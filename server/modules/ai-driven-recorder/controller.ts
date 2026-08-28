/**
 * AI-Driven Recorder Controller
 *
 * 业务编排层，协调 Repository / SSEGateway / WS Relay / Provider Matrix。
 * 不直接操作 DB，不调 LLM，不碰浏览器。
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §8
 */

import { randomId } from '../../shared/utils/index.ts';
import { AiDrivenRecorderRepository } from './repository.ts';
import { SSEGateway } from '../ai-test-gen/sse-gateway.ts';
import { canTriggerAiRecording } from './provider-matrix.ts';
import { nlCaseRepo } from '../nl-cases/repository.ts';
import { agentRegistry } from '../agent/registry.ts';
import { wsService } from '../../shared/services/websocketService.ts';
import { saveSuite } from '../suites/repository.ts';
import type { TestSuite } from '../../../shared/contracts/index.ts';
import {
  AI_RECORDER_START_EVENT,
  AI_RECORDER_STOP_EVENT,
} from '../../../shared/recording/protocol.ts';
import {
  findCaseStartUrl,
  normalizeExplicitStartUrl,
} from '../../../shared/recording/start-url.ts';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/http/errors.ts';
import { LocalRecordingRunner } from './local-runner.ts';
import { getLocalRunHandle } from './run-registry.ts';
import { RecordingService } from '../recording/service.ts';
import { defaultIngestService } from '../recording/default-ingest.ts';

export interface StartRunRequest {
  nlCaseId: string;
  providerConfigId: string;
  model?: string;
  executionMode?: 'agent' | 'local';
  /** 显式起始 URL 覆盖；缺省时从 NlCase preconditions/testData 解析 */
  startUrl?: string;
  options?: {
    headless?: boolean;
    maxRetriesPerStep?: number;
    timeoutPerStep?: number;
    /** 编译管线（docs/07）：规则+AI 编译断言；确认回放由 Server 端在会话结束后执行 */
    enableCompilePipeline?: boolean;
  };
}

export interface StartRunResponse {
  runId: string;
  suiteId: string;
  caseId: string;
  status: 'started';
}

export interface RunStatusResponse {
  runId: string;
  nlCaseId: string;
  status: string;
  executionMode: 'agent' | 'local';
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  result?: { suiteId: string; caseId: string };
  replayReport?: unknown;
  error?: string;
}

export class AiDrivenRecorderController {
  public readonly sseGateway: SSEGateway;
  private readonly repository: AiDrivenRecorderRepository;
  private readonly localRunner: LocalRecordingRunner;

  constructor(
    sseGateway: SSEGateway,
    repository: AiDrivenRecorderRepository,
    localRunner?: LocalRecordingRunner,
  ) {
    this.sseGateway = sseGateway;
    this.repository = repository;
    // 可注入以便测试；生产默认走 RecordingService 持久化 live step（与人工录制一致）
    this.localRunner = localRunner ?? new LocalRecordingRunner({
      sseGateway,
      repository,
      recordingBridge: new RecordingService(defaultIngestService, wsService),
    });
  }

  /** 启动 AI 录制 run */
  startRun(projectId: string, body: unknown): StartRunResponse {
    const params = body as StartRunRequest;
    const executionMode = params?.executionMode ?? 'agent';
    if (executionMode !== 'agent' && executionMode !== 'local') {
      throw new ValidationError('executionMode must be "agent" or "local"');
    }
    if (!params?.nlCaseId) throw new ValidationError('nlCaseId is required');
    if (!params?.providerConfigId) throw new ValidationError('providerConfigId is required');

    // 1. 校验 NlCase 存在且为 APPROVED 状态
    const nlCase = nlCaseRepo.get(params.nlCaseId);
    if (!nlCase) throw new NotFoundError(`NlCase not found: ${params.nlCaseId}`);
    if (nlCase.projectId !== projectId) {
      throw new NotFoundError('NlCase does not belong to this project');
    }
    if (nlCase.status !== 'APPROVED') {
      throw new ConflictError(`NlCase must be APPROVED, current: ${nlCase.status}`);
    }

    // 2. 校验 providerConfig 存在且在认证矩阵中允许触发
    const providerConfig = this.repository.getDecryptedProviderConfig(params.providerConfigId);
    if (!providerConfig) {
      throw new NotFoundError(`Provider config not found: ${params.providerConfigId}`);
    }
    if (!canTriggerAiRecording(providerConfig)) {
      throw new ConflictError(
        `Provider type ${providerConfig.type} is not allowed for AI recording (unverified)`,
      );
    }

    // 3. 检查是否有进行中的 run（同一 NlCase 不允许并发录制）
    const existingRuns = this.repository.getRunsByProject(projectId);
    const conflictingRun = existingRuns.find(
      (r) => r.nl_case_id === params.nlCaseId && (r.status === 'running' || r.status === 'refining' || r.status === 'replaying'),
    );
    if (conflictingRun) {
      throw new ConflictError(`NlCase already has an active run: ${conflictingRun.id}`);
    }

    // 3.5 local 模式容量预检：409 必须先于一切副作用（draft suite / run 记录）
    if (executionMode === 'local') {
      this.localRunner.assertCapacity();
    }

    // 3.6 起始 URL 前置校验：解析不到时在启动前快速失败（400），
    //     避免浏览器启动后才发现、浪费一次 run。显式覆盖优先。
    let startUrl: string | undefined;
    const rawStartUrl = typeof params?.startUrl === 'string' ? params.startUrl.trim() : '';
    if (rawStartUrl) {
      try {
        startUrl = normalizeExplicitStartUrl(rawStartUrl);
      } catch (err: any) {
        throw new ValidationError(err?.message ?? 'Invalid startUrl');
      }
    } else if (!findCaseStartUrl(nlCase)) {
      throw new ValidationError(
        `NlCase ${nlCase.id} has no resolvable start URL. Add a URL to its preconditions or testData ` +
          `(key containing "url"), or set "Start URL" in the recorder config.`,
      );
    }

    // 4. 预分配 draft suiteId / caseId（Agent 完成后回填内容）
    const suiteId = randomId('ai-draft-suite');
    const caseId = randomId('ai-draft-case');
    // 立即创建空的 draft suite + case，否则录制中的 step 插入会因外键约束失败
    const draftSuite: TestSuite = {
      id: suiteId,
      projectId,
      name: `[AI Draft] ${nlCase.title}`,
      description: `AI 驱动录制草稿套件，来源 NlCase: ${nlCase.id}`,
      cases: [{ id: caseId, name: nlCase.title, description: '', steps: [] }],
      position: 0,
    };
    saveSuite(draftSuite);

    // 5. 创建 run 记录
    const runId = this.repository.createRun({
      projectId,
      nlCaseId: params.nlCaseId,
      providerConfigId: params.providerConfigId,
      options: params.options,
      executionMode,
    });

    // 6. 按 executionMode 分发：local 在 Server 进程内执行；agent 走既有 WS 下发
    if (executionMode === 'local') {
      this.localRunner.start({
        runId,
        projectId,
        nlCase,
        providerConfig,
        options: params.options ?? {},
        ...(startUrl ? { startUrl } : {}),
        caseId,
        suiteId,
      });
    } else {
      // 发现 idle Agent
      const activeConnections = agentRegistry.getActiveConnections();
      let idleAgent: { id: string; ws?: import('ws').WebSocket } | undefined;
      for (const agent of activeConnections.values()) {
        if (agent.status === 'idle' && agent.ws) {
          idleAgent = agent;
          break;
        }
      }
      if (!idleAgent) {
        this.repository.updateRunStatus(runId, 'failed', 'No idle agent available');
        throw new ServiceUnavailableError('No idle agent available');
      }

      // 通过 WS 下发 AI_RECORDER_START
      const startPayload = {
        runId,
        projectId,
        nlCase,
        providerConfigId: params.providerConfigId, // 只传 ID，Agent 通过 WS 请求解密 config
        model: params.model,
        ...(startUrl ? { startUrl } : {}),
        options: params.options ?? {},
        caseId,
        suiteId,
      };
      const packet = JSON.stringify({ event: AI_RECORDER_START_EVENT, data: startPayload });
      idleAgent.ws!.send(packet);
    }

    // 8. SSE 广播 run:start
    this.sseGateway.emit(runId, 'run:start', {
      runId,
      nlCaseId: params.nlCaseId,
      totalSteps: nlCase.steps.length,
    });

    return { runId, suiteId, caseId, status: 'started' };
  }

  /** 查询 run 状态 */
  getRun(projectId: string, runId: string): RunStatusResponse {
    const run = this.repository.getRun(runId);
    if (!run) throw new NotFoundError(`Run not found: ${runId}`);
    if (run.project_id !== projectId) {
      throw new NotFoundError('Run does not belong to this project');
    }

    const response: RunStatusResponse = {
      runId: run.id,
      nlCaseId: run.nl_case_id,
      status: run.status,
      executionMode: run.execution_mode as 'agent' | 'local',
      progress: {
        total: run.total_steps,
        completed: run.completed_steps,
        failed: run.failed_steps,
      },
    };

    if (run.result_suite_id && run.result_case_id) {
      response.result = { suiteId: run.result_suite_id, caseId: run.result_case_id };
    }
    if (run.replay_report) {
      try {
        response.replayReport = JSON.parse(run.replay_report);
      } catch {
        // ignore parse error
      }
    }
    if (run.error) {
      response.error = run.error;
    }
    return response;
  }

  /** 列出项目的所有 run */
  listRuns(projectId: string): RunStatusResponse[] {
    return this.repository.getRunsByProject(projectId).map((run) => ({
      runId: run.id,
      nlCaseId: run.nl_case_id,
      status: run.status,
      executionMode: run.execution_mode as 'agent' | 'local',
      progress: {
        total: run.total_steps,
        completed: run.completed_steps,
        failed: run.failed_steps,
      },
      result: run.result_suite_id && run.result_case_id
        ? { suiteId: run.result_suite_id, caseId: run.result_case_id }
        : undefined,
      replayReport: run.replay_report ? safeParse(run.replay_report) : undefined,
      error: run.error || undefined,
    }));
  }

  /**
 * 中止/删除 run。两条语义：
 *  - 进行中（running/refining/replaying）→ 软删除中止：发 STOP + 状态置 failed + 保留历史记录
 *  - 已结束（completed/failed）→ 硬删除历史记录：物理删除 run 及其 step logs
 */
  deleteRun(projectId: string, runId: string): { success: true } {
    const run = this.repository.getRun(runId);
    if (!run) throw new NotFoundError(`Run not found: ${runId}`);
    if (run.project_id !== projectId) {
      throw new NotFoundError('Run does not belong to this project');
    }

    const inProgress = run.status === 'running' || run.status === 'refining' || run.status === 'replaying';

    // 进行中：local 走进程内句柄 abort（避免向无关 agent 广播 STOP
    // 误杀并发 agent 会话）；agent 保持既有 STOP 广播
    if (inProgress) {
      if (run.execution_mode === 'local') {
        getLocalRunHandle(runId)?.abort();
      } else {
        wsService.broadcast(AI_RECORDER_STOP_EVENT, { runId });
      }
      // SSE 广播 run:error（让前端关闭连接）
      this.sseGateway.emit(runId, 'run:error', { runId, error: 'Run aborted by user' });
      this.sseGateway.cleanup(runId);
      // 软删除：保留 run 记录与 step logs，状态置 failed 以便历史列表仍可查看
      this.repository.updateRunStatus(runId, 'failed', 'Run aborted by user');
    } else {
      // 已完成的 run：硬删除历史记录（用户显式删除）
      this.sseGateway.cleanup(runId);
      this.repository.deleteRun(runId);
    }

    return { success: true };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
