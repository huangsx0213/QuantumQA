import { ZodError } from 'zod';

import { randomId } from '../../shared/utils/index.ts';
import { pipelineRepo } from './repository.ts';
import { SSEGateway } from './sse-gateway.ts';
import { Orchestrator } from './orchestrator.ts';
import { startPipelineSchema, resumePipelineSchema, checkpointUpdateSchema } from './schema.ts';
import { nlCaseRepo } from '../nl-cases/repository.ts';
import { Log } from '../../shared/services/logger.ts';
import { HtmlKnowledgeService } from './html-knowledge/service.ts';
import {
  ProjectDeletionLock,
  projectDeletionLock,
} from './project-deletion-lock.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/http/errors.ts';
import {
  buildAnalystSystemPrompt,
  buildDesignerSystemPrompt,
  buildQualitySystemPrompt,
} from './graph/prompts.ts';
import type { TestGenState } from './graph/state.ts';

export class TestGenController {
  public readonly orchestrator: Orchestrator;
  public readonly sseGateway: SSEGateway;
  private readonly htmlKnowledgeService: HtmlKnowledgeService;

  constructor(private readonly deletionLock: ProjectDeletionLock = projectDeletionLock) {
    this.sseGateway = new SSEGateway();
    this.orchestrator = new Orchestrator(
      this.sseGateway,
      undefined,
      undefined,
      undefined,
      this.deletionLock,
    );
    this.htmlKnowledgeService = new HtmlKnowledgeService();
  }

  /** 列出项目下的所有运行 */
  listRuns(projectId: string) {
    return pipelineRepo.listRunsByProject(projectId);
  }

  /** 获取活跃运行 */
  getActiveRun(projectId: string) {
    return pipelineRepo.getActiveRun(projectId);
  }

  /** 获取运行日志 */
  getLogs(runId: string, agent?: string) {
    return pipelineRepo.getAgentLogs(runId, agent);
  }

  /** 获取运行详情 */
  getRun(runId: string) {
    const row = pipelineRepo.getRun(runId);
    if (!row) return null;
    return pipelineRepo.getRunInfo(runId);
  }

  /** 获取运行信息 */
  getRunInfo(runId: string) {
    return pipelineRepo.getRunInfo(runId);
  }

  /** 删除运行 */
  async deleteRun(runId: string) {
    const row = pipelineRepo.getRun(runId);
    if (!row) throw new NotFoundError('Test gen run not found');
    await this.orchestrator.delete(runId);
    return { success: true };
  }

  /** 中止运行 */
  abortRun(runId: string) {
    this.orchestrator.abort(runId);
    return { success: true };
  }

  /** 启动流水线 */
  async startPipeline(projectId: string, body: unknown) {
    const params = parseRequest(() => startPipelineSchema.parse(body));
    this.deletionLock.assertStartAllowed(projectId);
    const candidateRunId = randomId('tgr');
    const result = params.htmlKnowledgeSetId
      ? this.htmlKnowledgeService.createOrReuseRun(
          projectId,
          params.htmlKnowledgeSetId,
          candidateRunId,
          params,
        )
      : (() => {
          pipelineRepo.createRun(candidateRunId, projectId, params.mode, params);
          return { runId: candidateRunId, created: true } as const;
        })();
    // 异步执行，不阻塞响应
    if (result.created) {
      this.orchestrator.start(result.runId, projectId, params).catch(err => {
        Log.for('controller').error(`Pipeline ${result.runId} failed: ${err.message}`);
      });
    }
    return result;
  }

  /** 审核通过/重试 */
  resumeRun(runId: string, body: unknown) {
    const { action, feedback, editedData } = parseRequest(() => resumePipelineSchema.parse(body));
    this.orchestrator.assertCanResume(runId);
    void this.orchestrator.resume(runId, action, feedback, editedData).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      Log.for('controller').error(`Resume ${runId} failed: ${message}`);
    });
    return { success: true, action };
  }

  /** 从失败的 agent 重试 */
  retryRun(runId: string) {
    this.orchestrator.assertCanRetry(runId);
    void this.orchestrator.retry(runId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      Log.for('controller').error(`Retry ${runId} failed: ${message}`);
    });
    return { success: true };
  }

  /** 保存 checkpoint 编辑 */
  async saveCheckpointEdits(runId: string, body: unknown) {
    const { editedData, checkpointNumber } = parseRequest(
      () => checkpointUpdateSchema.parse(body),
    );
    await this.orchestrator.saveCheckpointEdits(runId, editedData, checkpointNumber);
    return { success: true };
  }

  /** 获取 checkpoint 状态 */
  async getCheckpointState(runId: string) {
    return this.orchestrator.getCheckpointState(runId);
  }

  /** 保存用例到项目 */
  saveCases(runId: string) {
    const run = pipelineRepo.getRun(runId);
    if (!run) throw new NotFoundError('Run not found');

    const logs = pipelineRepo.getAgentLogs(runId);
    const allCases = logs
      .filter(l => l.agent_name === 'quality_manager' && l.output_data?.finalTestCases)
      .flatMap(l => l.output_data.finalTestCases);
    if (allCases.length === 0) throw new ConflictError('No test cases found to export');

    // 保存全部用例，不在保存阶段去重。每个用例生成新的 DB id（不沿用 LLM 生成的
    // transient id），避免跨运行同名 id 互相覆盖。去重应由生成阶段负责。
    for (const tc of allCases) {
      nlCaseRepo.save({ ...tc, id: undefined, projectId: run.project_id });
    }
    return { saved: allCases.length };
  }

  /** 获取思考数据（持久化的） */
  getThinkingData(runId: string) {
    return pipelineRepo.getThinkingData(runId);
  }

  /** 获取审核日志 */
  getAuditLogs(runId: string, checkpointId?: string) {
    return pipelineRepo.getAuditLogs(runId, checkpointId);
  }

  // 获取最近一次成功的运行日志
  getLatestRunLogs(projectId: string) {
    const runs = pipelineRepo.listRunsByProject(projectId);
    const completedRun = runs.find((r: any) => r.status === 'COMPLETED');
    if (!completedRun) return null;
    return pipelineRepo.getAgentLogs(completedRun.id);
  }

  // ---- Prompt Overrides ----

  getPromptOverrides(projectId: string) {
    return pipelineRepo.getPromptOverrides(projectId);
  }

  upsertPromptOverride(projectId: string, agentName: string, customPrompt: string | null, modelOverride: string | null) {
    pipelineRepo.upsertPromptOverride(projectId, agentName, customPrompt, modelOverride);
    return { success: true };
  }

  deletePromptOverride(projectId: string, agentName: string) {
    pipelineRepo.deletePromptOverride(projectId, agentName);
    return { success: true };
  }

  /** Get the default system prompt for an agent (without any custom override) */
  getDefaultPrompt(agentName: string): string {
    const minimalState = this.createMinimalState();
    switch (agentName) {
      case 'test_analyst':
        return buildAnalystSystemPrompt(minimalState);
      case 'test_designer':
        return buildDesignerSystemPrompt(minimalState);
      case 'quality_manager':
        return buildQualitySystemPrompt(minimalState);
      default:
        return '';
    }
  }

  /** Create a minimal TestGenState for generating default prompts */
  private createMinimalState(): TestGenState {
    return {
      projectId: '',
      runId: '',
      mode: 'auto',
      requirementIds: [],
      epic: undefined,
      currentBatch: [],
      batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 },
      projectContext: { name: '', pages: [], endpoints: [] },
      businessFlowBlueprints: undefined,
      htmlKnowledgeReference: undefined,
      globalStats: { totalRequirements: 0, totalEpics: 0, totalFlows: 0 },
      globalEpicIndex: undefined,
      crossEpicDependencies: undefined,
      previousBatchCoverageSummary: undefined,
      relevantFlowBlueprints: undefined,
      flowReferencedComponentContext: undefined,
      environmentReady: true,
      initializationLogs: [],
      tokenBudget: { estimated: 0, limit: null },
      requirementAnalysis: undefined,
      testConditions: undefined,
      approvedConditions: undefined,
      draftTestCases: undefined,
      approvedDraftCases: undefined,
      finalTestCases: undefined,
      coverageMatrix: undefined,
      generationMode: 'component',
      selectedFlowIds: [],
      analystInput: undefined,
      humanReviewFeedback: '',
      skillCalls: [],
      phase: 'init',
      errors: [],
    } as TestGenState;
  }

  /** 恢复中断的运行（服务重启后调用） */
  async recoverInterruptedRuns(): Promise<void> {
    const waitingRuns = pipelineRepo.getWaitingRuns();
    const log = Log.for('controller');
    if (waitingRuns.length === 0) {
      log.info('No interrupted test gen runs to recover');
      return;
    }

    log.info(`Recovering ${waitingRuns.length} interrupted run(s)...`);
    for (const run of waitingRuns) {
      log.info(`Resuming run ${run.id} (phase: ${run.phase})`);
      this.orchestrator.resume(run.id, 'approve').catch(err => {
        log.error(`Failed to resume run ${run.id}: ${err.message}`);
      });
    }
  }
}

function parseRequest<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const message = error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }).join('; ');
    throw new ValidationError(message || 'Invalid request');
  }
}
