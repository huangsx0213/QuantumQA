import { randomId } from '../../shared/utils/index.ts';
import type { AIProvider } from './infra/provider.ts';
import { pipelineRepo, type TestGenRunRow } from './repository.ts';
import { SSEGateway } from './sse-gateway.ts';
import {
  ContextBuilder,
  HtmlKnowledgeRuntimeError,
  RunCancelledError,
  type RunContext,
  type StartParams,
} from './context.ts';
import {
  CheckpointUnavailableError,
  type TestGenSession,
  type BatchInput,
  type BatchResult,
  type InterruptInfo,
  type RunOutcome,
} from './session.ts';
import { requirementRepo } from '../requirements/repository.ts';
import { buildRequirementIndexFromRequirements } from '../requirements/index-generator.ts';
import { groupRequirementsByEpic, selectedRequirementAndFlowIds } from './helpers.ts';
import { deduplicateTestCases } from './helpers.ts';
import { buildBlueprintsFromFlowStories } from './business-flow-blueprint.ts';
import { checkpointer } from './graph/checkpointer.ts';
import { buildTestGenGraph } from './graph/graph.ts';
import { CHECKPOINT_BY_PHASE } from './graph/state.ts';
import { buildAnalystInput } from './analyst-input-builder.ts';
import { CoverageIndex } from './coverage-index.ts';
import type { GlobalEpicEntry } from './graph/state.ts';
import { db } from '../../shared/db/client.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/http/errors.ts';
import { Log } from '../../shared/services/logger.ts';
import { RunCacheRegistry, runCacheRegistry } from './run-cache-registry.ts';
import { ProjectDeletionLock, projectDeletionLock } from './project-deletion-lock.ts';
import { requirementsFromHtmlSnapshot } from './html-knowledge/requirement-snapshot.ts';
import { resetFailureTelemetry, logFailureSummary } from './infra/failure-telemetry.ts';
import type { ResolvedHtmlKnowledgeRuntime } from './graph/skills/html-knowledge.ts';
import type { HtmlKnowledgeReference } from './html-knowledge/types.ts';
import type { Requirement } from '../../shared/contracts/index.ts';

type OrchestratorLifecycleRepository = Pick<
  typeof pipelineRepo,
  | 'deleteRun'
  | 'markRunFailed'
  | 'getRun'
  | 'getFailedRun'
  | 'getRunWithThreadId'
  | 'setRunRunning'
>;

export interface RunDeletionPreparation {
  readonly wasActive: boolean;
  readonly error?: unknown;
}

function createDummyProvider(): AIProvider {
  return {
    streamChat: async function* () { /* noop */ },
  };
}

function buildGlobalEpicIndex(
  epics: any[],
  rootGroups: Map<string, string[]>,
  requirements: any[],
  allFlowStories: any[],
): GlobalEpicEntry[] {
  return epics.map(epic => {
    const childIds = rootGroups.get(epic.id) ?? [];
    const childReqSet = new Set(childIds);
    const childReqs = requirements.filter(r => childReqSet.has(r.id));
    const epicFlowCount = allFlowStories.filter(s =>
      childReqSet.has(s.id) || childReqSet.has(s.parentId || '')
    ).length;
    const statusBreakdown: Record<string, number> = {};
    for (const r of childReqs) {
      statusBreakdown[r.status] = (statusBreakdown[r.status] ?? 0) + 1;
    }
    const stories = childReqs.filter(r => r.level === 'story');
    const storyIds = new Set(stories.map(s => s.id));
    const flowStoryIds = new Set(stories.filter((s: any) => s.isFlow).map(s => s.id));
    const allAcs = requirements.filter(r => storyIds.has(r.parentId) && r.level === 'ac');
    // ACs under flow stories inherit the flow flag from their parent story,
    // since the DB may not set isFlow=true on ACs individually.
    const nonFlowAcCount = allAcs.filter(a => !a.isFlow && !flowStoryIds.has(a.parentId)).length;
    const flowAcCount = allAcs.filter(a => a.isFlow || flowStoryIds.has(a.parentId)).length;
    return {
      epicId: epic.id,
      title: epic.title,
      requirementCount: childReqs.length,
      storyCount: stories.length,
      nonFlowAcCount,
      flowAcCount,
      flowCount: epicFlowCount,
      statusBreakdown,
      children: childReqs.map(r => ({
        id: r.id, title: r.title, level: r.level, isFlow: r.isFlow ?? false,
        // Nested ACs for story-level children so the prompt can list
        // story + AC titles/ids without a tool call.
        acs: r.level === 'story'
          ? allAcs
              .filter(a => a.parentId === r.id)
              .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
              .map(a => ({ id: a.id, title: a.title, level: 'ac', isFlow: r.isFlow || a.isFlow || false }))
          : undefined,
      })),
    };
  });
}

function computeTotalSubBatches(
  epics: any[],
  rootGroups: Map<string, string[]>,
  reqMap: Map<string, any>,
): number {
  let totalSubBatches = 0;
  for (const epic of epics) {
    const childIds = rootGroups.get(epic.id) ?? [];
    const hasComponentStories = childIds.some(id => {
      const r = reqMap.get(id);
      return r && r.level === 'story' && !r.isFlow;
    });
    const hasFlowStories = childIds.some(id => {
      const r = reqMap.get(id);
      return r && r.level === 'story' && r.isFlow && r.status === 'APPROVED';
    });
    if (hasComponentStories || hasFlowStories) totalSubBatches++;
  }
  return totalSubBatches;
}

interface BatchLoopParams {
  runId: string;
  projectId: string;
  requirementIds: string[];
  flowIds: string[];
  mode: 'auto' | 'interactive';
  epics: any[];
  rootGroups: Map<string, string[]>;
  reqMap: Map<string, any>;
  requirements: any[];
  businessFlows: any[];
  flowReferencedComponentContext: Map<string, any[]>;
  globalStats: { totalRequirements: number; totalEpics: number; totalFlows: number };
  globalEpicIndex: GlobalEpicEntry[];
  accumulatedCoverage: CoverageIndex;
  startFrom: number;
  totalSubBatches: number;
  htmlKnowledgeReference?: HtmlKnowledgeReference;
}

interface RunRequirementSource {
  requirements: Requirement[];
  requirementIds: string[];
  flowIds: string[];
  allIndex: ReturnType<typeof buildRequirementIndexFromRequirements>;
}

interface CompletedAgentOutput {
  agentName: string;
  outputData: Record<string, unknown>;
}

function selectAgentLogRecoveryPrefix(
  logs: any[],
  currentBatch: number,
  mode: 'auto' | 'interactive',
): CompletedAgentOutput[] | undefined {
  const current = logs.filter((log) => log.batch === currentBatch);
  const byAgent = (agentName: string) =>
    current.filter((log) => log.agent_name === agentName);
  const analystLogs = byAgent('test_analyst');
  const designerLogs = byAgent('test_designer');
  const qualityLogs = byAgent('quality_manager');
  const analysts = analystLogs.filter((log) => log.status === 'COMPLETED');
  const designers = designerLogs.filter((log) => log.status === 'COMPLETED');

  if (analystLogs.length > 1
    || designerLogs.length > 1
    || qualityLogs.length > 0
    || analysts.length > 1
    || designers.length > 1) {
    return undefined;
  }
  if (designers.length > 0 && (analysts.length !== 1 || mode !== 'auto')) {
    return undefined;
  }
  if (analysts.length === 0) return [];

  const analystOutput = analysts[0].output_data;
  if (!analystOutput
    || typeof analystOutput !== 'object'
    || !Array.isArray(analystOutput.testConditions)) {
    return undefined;
  }
  const outputs: CompletedAgentOutput[] = [{
    agentName: 'test_analyst',
    outputData: analystOutput,
  }];
  if (designers.length === 1) {
    const designerOutput = designers[0].output_data;
    if (!designerOutput
      || typeof designerOutput !== 'object'
      || !Array.isArray(designerOutput.draftTestCases)) {
      return undefined;
    }
    outputs.push({
      agentName: 'test_designer',
      outputData: designerOutput,
    });
  }
  return outputs;
}

export function loadRunRequirementSource(
  projectId: string,
  config: Pick<StartParams, 'requirementIds' | 'flowIds' | 'htmlKnowledgeSetId'>,
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime,
): RunRequirementSource {
  if (config.htmlKnowledgeSetId !== undefined) {
    if (typeof config.htmlKnowledgeSetId !== 'string' || !config.htmlKnowledgeSetId) {
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge set ID is invalid',
      );
    }
    if (!htmlKnowledge
      || htmlKnowledge.projectId !== projectId
      || htmlKnowledge.reference.knowledgeSetId !== config.htmlKnowledgeSetId) {
      throw new HtmlKnowledgeRuntimeError(
        'Configured HTML knowledge runtime is unavailable or mismatched',
      );
    }
    const requirements = requirementsFromHtmlSnapshot(htmlKnowledge.snapshot);
    return {
      requirements,
      requirementIds: [...htmlKnowledge.snapshot.selectedRequirementIds],
      flowIds: [...htmlKnowledge.snapshot.selectedFlowIds],
      allIndex: buildRequirementIndexFromRequirements(requirements),
    };
  }
  if (htmlKnowledge) {
    throw new HtmlKnowledgeRuntimeError(
      'Resolved HTML knowledge runtime has no persisted set configuration',
    );
  }
  const requirements = requirementRepo.listByProject(projectId);
  return {
    requirements,
    requirementIds: [...(config.requirementIds ?? [])],
    flowIds: [...(config.flowIds ?? [])],
    allIndex: buildRequirementIndexFromRequirements(requirements),
  };
}

export class Orchestrator {
  private readonly contextBuilder: ContextBuilder;

  constructor(
    private readonly sseGateway: SSEGateway,
    private readonly cacheRegistry: RunCacheRegistry = runCacheRegistry,
    contextBuilder?: ContextBuilder,
    private readonly lifecycleRepository: OrchestratorLifecycleRepository = pipelineRepo,
    private readonly deletionLock: ProjectDeletionLock = projectDeletionLock,
  ) {
    this.contextBuilder = contextBuilder ?? new ContextBuilder(sseGateway);
  }

  abort(runId: string): void {
    this.contextBuilder.abort(runId);
    this.lifecycleRepository.markRunFailed(runId);
  }

  async abortAndWaitForDeletion(runId: string): Promise<RunDeletionPreparation> {
    let wasActive = false;
    try {
      wasActive = this.contextBuilder.beginDeletion(runId);
      await this.contextBuilder.waitForQuiescence(runId);
      this.cacheRegistry.evict(runId);
      return { wasActive };
    } catch (error) {
      return { wasActive, error };
    }
  }

  completeDeletion(runId: string): void {
    try {
      this.sseGateway.cleanup(runId);
    } finally {
      this.contextBuilder.finishDeletion(runId);
    }
  }

  cancelDeletion(runId: string): void {
    this.contextBuilder.finishDeletion(runId);
  }

  failDeletion(runId: string, reason: string, wasActive: boolean): void {
    const boundedReason = Array.from(reason).slice(0, 500).join('');
    let failure: unknown;
    try {
      if (wasActive) {
        try {
          this.lifecycleRepository.markRunFailed(runId);
        } catch (error) {
          failure = error;
        }
        try {
          this.sseGateway.emit(runId, 'pipeline:error', {
            phase: 'deletion',
            message: boundedReason,
            recoverable: true,
          });
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      this.contextBuilder.finishDeletion(runId);
    }
    if (failure) throw failure;
  }

  async delete(runId: string): Promise<void> {
    try {
      const preparation = await this.abortAndWaitForDeletion(runId);
      if (preparation.error) {
        try {
          this.failDeletion(runId, 'Run deletion failed', preparation.wasActive);
        } catch {
          // Preserve the preparation failure while still releasing the barrier.
        }
        throw preparation.error;
      }
      try {
        this.lifecycleRepository.deleteRun(runId);
      } catch (error) {
        try {
          this.failDeletion(runId, 'Run deletion failed', preparation.wasActive);
        } catch {
          // Preserve the transaction failure after best-effort recovery.
        }
        throw error;
      }
      try {
        this.completeDeletion(runId);
      } catch {
        Log.for('orchestrator').error(
          `Post-commit run cleanup failed: runId=${runId}`,
        );
      }
    } finally {
      this.contextBuilder.finishDeletion(runId);
    }
  }

  async start(runId: string, projectId: string, params: StartParams): Promise<void> {
    const log = Log.for('orchestrator');
    Log.banner('PIPELINE START');
    log.kv('runId', runId);
    log.kv('projectId', projectId);
    log.kv('mode', params.mode);
    log.kv('ai.provider', params.providerConfigName ?? 'default');
    log.kv('ai.model', params.model ?? 'default');
    log.kv('ai.reasoningEffort', params.reasoningEffort ?? 'default');
    log.kv('ai.reasoningSummary', params.reasoningSummary ?? 'default');
    log.kv('ai.textVerbosity', params.textVerbosity ?? 'default');
    log.kv('ai.cache', params.useCache ?? false ? 'on' : 'off');
    log.kv('requirements', `${params.requirementIds?.length ?? 0} selected`);
      log.kv('flows', `${params.flowIds?.length ?? 0} selected (each epic: component then flow)`);
      Log.divider();
    let ctx: RunContext | null = null;
    let keepSse = false;

    try {
      // F4: reset structured-failure telemetry for this run; the distribution
      // is logged when the run finishes (success or failure).
      resetFailureTelemetry();
      ctx = await this.contextBuilder.build(runId, projectId, params.mode, {
        providerConfigName: params.providerConfigName,
        model: params.model,
        useCache: params.useCache,
        reasoningEffort: params.reasoningEffort,
        reasoningSummary: params.reasoningSummary,
        textVerbosity: params.textVerbosity,
        htmlKnowledgeSetId: params.htmlKnowledgeSetId,
      });
      const providerRow = params.providerConfigName
        ? pipelineRepo.getProviderConfigByName(params.providerConfigName)
        : pipelineRepo.getActiveProviderConfig();
      log.kv('context.model', ctx.modelName);
      log.kv('ai.apiVersion', providerRow?.api_version ?? 'default');
      log.kv('context.tokenLimit', ctx.tokenLimit ?? 'none', 0);

      // 构建需求索引和批次
      const requirementSource = loadRunRequirementSource(
        projectId,
        params,
        ctx.htmlKnowledge,
      );
      const {
        allIndex,
        requirements,
        requirementIds,
        flowIds,
      } = requirementSource;

      // Explicitly selected Flow Stories must be part of the same Epic group as
      // selected component Stories so each Epic can run component then flow.
      const selectedFlowSet = new Set(flowIds);
      const reqMap = new Map(requirements.map(r => [r.id, r]));
      const selectedIds = selectedRequirementAndFlowIds(requirementIds, flowIds);
      const { epics, rootGroups, totalBatches, selectedIndex } = groupRequirementsByEpic(allIndex, selectedIds);
      if (epics.length === 0 && selectedFlowSet.size === 0) {
        throw new ValidationError('No matching requirements found for selected IDs');
      }

      log.info(`Requirements indexed: ${selectedIndex.length} selected, ${epics.length} epics`);
      pipelineRepo.updateModelInfo(runId, ctx.modelName, params.providerConfigName ?? null);

      // Build context map: for each selected flow, collect its referenced
      // component stories (with ACs) so they can be injected into the batch
      // prompt WITHOUT creating separate batches for them.
      const flowReferencedComponentContext = this.buildFlowReferencedComponentContext(selectedFlowSet, requirements, reqMap);
      if (flowReferencedComponentContext.size > 0) {
        log.info(`Flow context: ${selectedFlowSet.size} flows, ${flowReferencedComponentContext.size} with referenced component context`);
      }

      const allFlowStories = requirements
        .filter(r => r.level === 'story' && r.isFlow && r.status === 'APPROVED');
      const filteredFlowStories = selectedFlowSet.size > 0
        ? allFlowStories.filter(s => selectedFlowSet.has(s.id))
        : allFlowStories;
      const businessFlows = buildBlueprintsFromFlowStories({
        flowStories: filteredFlowStories,
        requirements,
      });
      log.info(`Flow stories: ${allFlowStories.length} total, ${filteredFlowStories.length} selected, ${businessFlows.length} blueprints`);

      // ── Pre-flight validation (P1.4, P1.5) ──
      // Validate selected flows and component stories before entering the batch loop
      const validationErrors: string[] = [];
      
      // 1. Validate flow stories
      for (const flowId of selectedFlowSet) {
        const flowStory = reqMap.get(flowId);
        if (!flowStory) {
          validationErrors.push(`Flow story ${flowId} not found`);
          continue;
        }
        if (!flowStory.isFlow) {
          validationErrors.push(`Requirement ${flowId} is not a flow story (isFlow=false)`);
        }
        if (flowStory.status !== 'APPROVED') {
          validationErrors.push(`Flow story "${flowStory.title}" (${flowId}) status is ${flowStory.status}, must be APPROVED`);
        }
        // Validate flow AC relatedRequirementIds point to existing APPROVED component stories
        const flowAcs = requirements.filter(r => r.parentId === flowId && r.level === 'ac');
        for (const ac of flowAcs) {
          const refs = (ac as any).relatedRequirementIds as string[] | undefined;
          if (!refs || refs.length === 0) continue;
          for (const refId of refs) {
            const ref = reqMap.get(refId);
            if (!ref) {
              validationErrors.push(`Flow "${flowStory.title}" AC "${ac.title}" references non-existent requirement ${refId}`);
            } else if (ref.status !== 'APPROVED') {
              validationErrors.push(`Flow "${flowStory.title}" AC "${ac.title}" references ${ref.title || refId} with status ${ref.status} (must be APPROVED)`);
            }
          }
        }
      }

      // 2. Validate component stories
      for (const epic of epics) {
        const childIds = rootGroups.get(epic.id) ?? [];
        for (const id of childIds) {
          const r = reqMap.get(id);
          if (r && r.level === 'story' && !r.isFlow) {
            if (r.status !== 'APPROVED') {
              validationErrors.push(`Component story "${r.title}" (${r.id}) status is ${r.status}, must be APPROVED`);
            }
          }
        }
      }

      if (validationErrors.length > 0) {
        const msg = `Pre-flight validation failed (${validationErrors.length} errors):\n  - ${validationErrors.join('\n  - ')}`;
        log.error(msg);
        ctx.sendEvent('pipeline:error', { phase: 'preflight', message: msg, recoverable: false });
        throw new ValidationError(msg);
      }
      log.info(`Pre-flight validation passed: ${selectedFlowSet.size} flow(s), all references and component stories valid`);

      // ── Orphan requirements warning (P1.6) ──
      const parentMap = new Map(allIndex.map(i => [i.id, i.parent]));
      function findRoot(id: string): string | null {
        let curr = id;
        for (let j = 0; j < 20; j++) {
          const p = parentMap.get(curr);
          if (!p) return curr;
          curr = p;
        }
        return curr;
      }
      const epicIdSet = new Set(epics.map(e => e.id));
      const orphanIds = selectedIndex
        .filter(item => {
          const r = findRoot(item.id);
          return !r || !epicIdSet.has(r);
        })
        .map(item => item.id);
      
      if (orphanIds.length > 0) {
        log.warn(`Orphan requirements detected (ignored because their root is not a level 0 Epic): ${orphanIds.join(', ')}`);
        ctx.sendEvent('pipeline:warning', {
          message: `The following selected requirements were skipped because they do not belong to any top-level Epic: ${orphanIds.join(', ')}`,
        });
      }

      // 计算总批次数：每个 epic 一个批次（component + flow 合并）
      const totalSubBatches = computeTotalSubBatches(epics, rootGroups, reqMap);
      pipelineRepo.updateBatchCount(runId, totalSubBatches);
      log.info(`Total sub-batches: ${totalSubBatches} (component + flow per epic)`);

      // ── 构建全局统计 + L1 Epic 索引（所有批次共享）（P0.1, P0.3） ──
      const globalStats = {
        totalRequirements: requirements.length,
        totalEpics: epics.length,
        totalFlows: allFlowStories.length,
      };
      const globalEpicIndex = buildGlobalEpicIndex(epics, rootGroups, requirements, allFlowStories);
      log.info(`Global snapshot: ${globalStats.totalRequirements} requirements, ${globalStats.totalEpics} epics, ${globalStats.totalFlows} flows; L1 Epic index built`);

      // 发送准备阶段事件
      ctx.sendEvent('phase:start', { phase: 'preparation', message: `Processing ${selectedIndex.length} requirements in ${totalSubBatches} sub-batch(es)` });
      ctx.sendEvent('pipeline:context', { flows: businessFlows.length, indexEntries: selectedIndex.length });

      const avgTokensPerReq = 1000;
      const estimated = selectedIndex.length * avgTokensPerReq;
      ctx.sendEvent('pipeline:budget', {
        estimated, limit: ctx.tokenLimit,
        message: ctx.tokenLimit && estimated > ctx.tokenLimit
          ? `Estimated token usage (${estimated}) exceeds limit (${ctx.tokenLimit}).`
          : `Estimated token usage (${estimated}) within limit.`,
      });

      // 发送 L1 Epic 索引（全局观，供 Preparation 页面展示）
      ctx.sendEvent('preparation:context', {
        globalStats,
        globalEpicIndex: globalEpicIndex.map(e => ({
          epicId: e.epicId,
          title: e.title,
          requirementCount: e.requirementCount,
          flowCount: e.flowCount,
        })),
      });

      // 记录 preparation 日志
      const preparationLogId = randomId('log');
      const preparationOutput = {
        requirementCount: selectedIndex.length,
        totalBatches: totalSubBatches,
        estimatedTokens: estimated,
        flowCases: businessFlows.length,
      };
      db.prepare(`
        INSERT INTO test_gen_agent_logs (id, run_id, batch, agent_name, phase, input_prompt, output_data, token_usage, latency_ms, raw_trace, status)
        VALUES (?, ?, 0, 'preparation', '', NULL, ?, NULL, 0, NULL, 'COMPLETED')
      `).run(preparationLogId, runId, JSON.stringify(preparationOutput));

      // 执行批次（累积 previousBatchCoverageSummary 给后续批次使用）
      const allResults: BatchResult[] = [];
      // L2 累积：按 requirementId 分组 of 覆盖摘要
      const accumulatedCoverage = new CoverageIndex();

      // 如果指定了参考的其他 Runs，则从其历史中提取已生成的 test conditions 和 finalTestCases，避免生成重复用例
      if (params.referenceRunIds && params.referenceRunIds.length > 0) {
        for (const refId of params.referenceRunIds) {
          try {
            this.loadCoverageFromLogs(refId, accumulatedCoverage);
            log.info(`Loaded conditions+cases from reference run ${refId}`);
          } catch (e) {
            log.error(`Failed to load reference coverage from run ${refId}: ${e}`);
          }
        }
        log.info(`Total accumulated reference requirements: ${accumulatedCoverage.size}`);
      }

      // 执行批次循环 (P0.2)
      const loopRes = await this.executeBatchLoop(ctx, {
        runId,
        projectId,
        requirementIds,
        flowIds,
        mode: params.mode,
        epics,
        rootGroups,
        reqMap,
        requirements,
        businessFlows,
        flowReferencedComponentContext,
        globalStats,
        globalEpicIndex,
        accumulatedCoverage,
        startFrom: 0,
        totalSubBatches,
        htmlKnowledgeReference: ctx.htmlKnowledge?.reference,
      }, allResults);

      if (loopRes.interrupted) {
        keepSse = true;
        return;
      }

      // 完成：totalCases 使用原始计数（与保存行为一致），去重仅作度量告警
      if (!ctx.isAborted()) {
        // D3: 全局覆盖矩阵后处理（纯 TS 计算，不调用 LLM）
        const allBatchResults = allResults;
        const globalSummary = {
          totalConditions: allBatchResults.reduce((sum, r) => sum + (r.lastState?.testConditions?.length ?? 0), 0),
          totalCases: allBatchResults.reduce((sum, r) => sum + (r.lastState?.finalTestCases?.length ?? r.cases?.length ?? 0), 0),
          batchCount: epics.length,
        };
        ctx.sendEvent('pipeline:global-coverage', globalSummary);
        log.info(`Global coverage: ${globalSummary.totalConditions} conditions, ${globalSummary.totalCases} cases across ${globalSummary.batchCount} batches`);

        const { totalCases, removedCount } = this.finishRun(ctx, allResults, epics.length);
        log.success(`All batches done ── ${totalCases} final cases${removedCount > 0 ? ` (${removedCount} suspected duplicates — prevent at generation, not here)` : ''}`);
        logFailureSummary();
      }
    } catch (err: any) {
      if (err instanceof RunCancelledError) return;
      logFailureSummary();
      if (ctx) {
        if (!ctx.isAborted()) ctx.scope.markFailed(err.message);
      } else {
        const htmlFailure = err instanceof HtmlKnowledgeRuntimeError;
        pipelineRepo.markRunFailed(runId, htmlFailure
          ? {
              type: 'HTML_KNOWLEDGE_UNAVAILABLE',
              phase: 'html-knowledge',
              recoverable: true,
            }
          : {
              type: 'CONTEXT_SETUP_FAILED',
              phase: 'context',
              recoverable: true,
            });
        this.sseGateway.emit(runId, 'pipeline:error', {
          phase: htmlFailure ? 'html-knowledge' : 'context',
          type: htmlFailure ? err.code : 'CONTEXT_SETUP_FAILED',
          message: err.message,
          recoverable: true,
        });
      }
    } finally {
      if (ctx) {
        ctx.releaseSlot();
        if (!keepSse) this.sseGateway.cleanup(runId);
      }
    }
  }

  async resume(runId: string, action: 'approve' | 'retry', feedback?: string, editedData?: any): Promise<void> {
    const row = this.assertCanResume(runId);

    const cpNum = CHECKPOINT_BY_PHASE[row.phase] ?? 0;

    this.deletionLock.assertStartAllowed(row.project_id);
    pipelineRepo.insertAuditLog(runId, `checkpoint_${cpNum}`, action, editedData ?? null);
    pipelineRepo.setRunRunning(runId);

    if (cpNum > 0) {
      this.sseGateway.emit(runId, 'checkpoint:resolved', { checkpointNumber: cpNum, action });
    }

    const config = row.config || {};
    let ctx: RunContext | null = null;
    let keepSse = false;

    try {
      ctx = await this.contextBuilder.build(runId, row.project_id, (row.mode || 'auto') as 'auto' | 'interactive', {
        providerConfigName: config.providerConfigName,
        model: config.model,
        useCache: config.useCache,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        textVerbosity: config.textVerbosity,
        currentBatch: row.current_batch || 0,
        htmlKnowledgeSetId: config.htmlKnowledgeSetId,
      });

      const outcome = await ctx.session.resumeAt(row.thread_id, {
        action,
        feedback,
        edits: editedData,
      });

      if (ctx.isAborted()) return;

      if (outcome.type === 'interrupt') {
        this.handleInterrupt(runId, ctx, outcome.interrupt);
        keepSse = true;
        return;
      }

      // Update state for the newly completed resumed batch (P1.8)
      try {
        const { coverage } = this.readRunStateCoverage(runId);
        const batchConditions: any[] = outcome.result.lastState?.testConditions ?? [];
        for (const tc of batchConditions) coverage.addCondition(tc);
        const batchCases: any[] = outcome.result.lastState?.finalTestCases ?? [];
        for (const tc of batchCases) coverage.addCase(tc);
        this.persistRunStateCoverage(runId, coverage);
      } catch (err: any) {
        Log.for('orchestrator').warn(`Failed to update serialized coverage state after resume: ${err.message}`);
      }

      // 继续剩余批次
      const allResults: BatchResult[] = [outcome.result];
      const totalBatches = row.total_batches || 0;
      const currentBatch = row.current_batch || 0;
      if (currentBatch < totalBatches) {
        const remaining = await this.continueRemainingBatches(runId, row.project_id, config, ctx);
        if (remaining.interrupted) { keepSse = true; return; }
        allResults.push(...remaining.allResults);
      }

      if (ctx.isAborted()) return;

      // totalCases 使用原始计数（与保存行为一致），去重仅作度量告警
      this.finishRun(ctx, allResults, totalBatches || 1);
    } catch (err: any) {
      if (err instanceof RunCancelledError) return;
      if (ctx) {
        if (!ctx.isAborted()) ctx.scope.markFailed(err.message);
      } else {
        this.markRecoverableContextFailure(runId, err);
      }
    } finally {
      if (ctx) {
        ctx.releaseSlot();
        if (!keepSse) this.sseGateway.cleanup(runId);
      }
    }
  }

  assertCanResume(runId: string): any {
    const row = this.requireResumableRun(runId);
    this.deletionLock.assertStartAllowed(row.project_id);
    return row;
  }

  assertCanRetry(runId: string): TestGenRunRow {
    if (!this.lifecycleRepository.getRun(runId)) {
      throw new NotFoundError('Test gen run not found');
    }
    const row = this.lifecycleRepository.getFailedRun(runId);
    if (!row) throw new ConflictError('Test gen run is not in FAILED status');
    this.deletionLock.assertStartAllowed(row.project_id);
    return row;
  }

  /**
   * 从失败的 agent 重试：利用 LangGraph checkpointer 保存的状态，
   * 从最后一个成功的 checkpoint 重新执行失败的节点。
   */
  async retry(runId: string): Promise<void> {
    const log = Log.for('orchestrator');
    const row = this.assertCanRetry(runId);

    const threadId = row.thread_id;
    const config = row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : {};
    this.deletionLock.assertStartAllowed(row.project_id);
    this.lifecycleRepository.setRunRunning(runId);
    this.sseGateway.emit(runId, 'pipeline:retry', {
      phase: row.phase,
      message: threadId
        ? `Retrying from last checkpoint (phase: ${row.phase})`
        : 'Restarting run from persisted configuration',
    });

    let ctx: RunContext | null = null;
    let keepSse = false;

    try {
      ctx = await this.contextBuilder.build(runId, row.project_id, (row.mode || 'auto') as 'auto' | 'interactive', {
        providerConfigName: config.providerConfigName,
        model: config.model,
        useCache: config.useCache,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        textVerbosity: config.textVerbosity,
        currentBatch: row.current_batch || 0,
        htmlKnowledgeSetId: config.htmlKnowledgeSetId,
      });

      ctx.scope.restoreBatchState(row.current_batch || 0);
      const batchIndex = (row.current_batch || 1) - 1;
      let recoveredBatchNumber: number | undefined;
      let recoveredTotalBatches: number | undefined;

      const recoverWithoutCheckpoint = async (
        checkpointError?: CheckpointUnavailableError,
      ): Promise<RunOutcome> => {
        if (checkpointError) {
          log.warn(`Checkpoint recovery unavailable (${checkpointError.message}), attempting agent-log recovery for batch ${row.current_batch}`);
        } else {
          log.info(`No checkpoint thread exists; rebuilding persisted batch ${row.current_batch || 1}`);
        }
        const batchInput = this.rebuildBatchInputForRetry(
          runId,
          row.project_id,
          config,
          row.current_batch || 1,
          ctx!.htmlKnowledge,
        );
        if (!batchInput) {
          throw new CheckpointUnavailableError(
            `Failed to rebuild batch input for retry (batch ${row.current_batch || 1})`,
            checkpointError ? { cause: checkpointError } : undefined,
          );
        }

        recoveredBatchNumber = row.current_batch || 1;
        recoveredTotalBatches = batchInput.inputState.batchContext.totalBatches;
        ctx!.scope.restoreBatchState(recoveredBatchNumber);
        if (!row.total_batches) {
          pipelineRepo.updateBatchCount(runId, recoveredTotalBatches);
        }

        // 查出当前 batch 已成功完成的 agent logs，按执行顺序排序。
        // 这样可以从失败的 agent 继续执行，而不是从 preparation 从头开始，
        // 避免浪费已成功 agent 的 LLM 调用结果。
        const currentBatchNum = row.current_batch || 1;
        const allLogs = pipelineRepo.getAgentLogs(runId);
        const recoveryPrefix = selectAgentLogRecoveryPrefix(
          allLogs,
          currentBatchNum,
          row.mode === 'interactive' || config.mode === 'interactive'
            ? 'interactive'
            : 'auto',
        );

        // Use a fresh thread_id to avoid stale checkpoint state
        const retryThreadId = `${runId}-batch-${currentBatchNum}-retry-${Date.now()}`;
        pipelineRepo.updateThreadId(runId, retryThreadId);

        if (recoveryPrefix && recoveryPrefix.length > 0) {
          log.info(`Recovered ${recoveryPrefix.length} completed agent(s) [${recoveryPrefix.map(a => a.agentName).join(', ')}] from logs, resuming from failed agent (not from scratch)`);
          return ctx!.session.retryFromAgentLogs(
            retryThreadId,
            batchIndex,
            batchInput.inputState as Record<string, unknown>,
            recoveryPrefix,
          );
        }
        log.info(`${recoveryPrefix ? 'No completed agents found' : 'Agent-log history is ambiguous'} for batch ${currentBatchNum}, starting from scratch`);
        return ctx!.session.startBatch(batchInput, retryThreadId);
      };

      let outcome: RunOutcome;
      if (!threadId) {
        outcome = await recoverWithoutCheckpoint();
      } else {
        try {
          log.info(`Attempting checkpoint recovery (threadId=${threadId}, batch=${batchIndex}, failedPhase=${row.phase || 'unknown'})`);
          outcome = await ctx.session.retryFromLastCheckpoint(threadId, batchIndex);
        } catch (retryErr) {
          if (!(retryErr instanceof CheckpointUnavailableError)) throw retryErr;
          outcome = await recoverWithoutCheckpoint(retryErr);
        }
      }

      if (ctx.isAborted()) return;

      if (outcome.type === 'interrupt') {
        this.handleInterrupt(runId, ctx, outcome.interrupt);
        keepSse = true;
        return;
      }

      // Update state for the newly completed retried batch (P1.8)
      try {
        let coverage: CoverageIndex = new CoverageIndex();
        let loadedFromArray = false;
        try {
          const stored = this.readRunStateCoverage(runId);
          coverage = stored.coverage;
          loadedFromArray = stored.loadedFromArray;
        } catch (stateError: any) {
          Log.for('orchestrator').warn(
            `Stored retry coverage is invalid; rebuilding from logs: ${stateError.message}`,
          );
        }
        if (!loadedFromArray) {
          this.loadCoverageFromLogs(
            runId,
            coverage,
            row.current_batch || recoveredBatchNumber || 1,
          );
        }
        const batchConditions: any[] = outcome.result.lastState?.testConditions ?? [];
        for (const tc of batchConditions) coverage.addCondition(tc);
        const batchCases: any[] = outcome.result.lastState?.finalTestCases ?? [];
        for (const tc of batchCases) coverage.addCase(tc);
        this.persistRunStateCoverage(runId, coverage);
      } catch (err: any) {
        Log.for('orchestrator').warn(`Failed to update serialized coverage state after retry: ${err.message}`);
      }

      // 继续剩余批次
      const allResults: BatchResult[] = [outcome.result];
      const totalBatches = row.total_batches || recoveredTotalBatches || 0;
      const currentBatch = row.current_batch || recoveredBatchNumber || 0;
      if (currentBatch < totalBatches) {
        const remaining = await this.continueRemainingBatches(runId, row.project_id, config, ctx);
        if (remaining.interrupted) { keepSse = true; return; }
        allResults.push(...remaining.allResults);
      }

      if (ctx.isAborted()) return;

      // totalCases 使用原始计数（与保存行为一致），去重仅作度量告警
      this.finishRun(ctx, allResults, totalBatches || 1);
    } catch (err: any) {
      if (err instanceof RunCancelledError) return;
      if (ctx) {
        if (!ctx.isAborted()) ctx.scope.markFailed(err.message);
      } else {
        this.markRecoverableContextFailure(runId, err);
      }
    } finally {
      if (ctx) {
        ctx.releaseSlot();
        if (!keepSse) this.sseGateway.cleanup(runId);
      }
    }
  }

  private requireResumableRun(runId: string): any {
    const row = this.lifecycleRepository.getRunWithThreadId(runId);
    if (!row) throw new NotFoundError('Test gen run not found');
    if (row.status !== 'WAITING_REVIEW') {
      throw new ConflictError('Test gen is not waiting for review');
    }
    return row;
  }

  private requireEditableCheckpointRun(runId: string, checkpointNumber: number): any {
    if (!Number.isInteger(checkpointNumber) || checkpointNumber < 1 || checkpointNumber > 3) {
      throw new ValidationError('Checkpoint number must be an integer between 1 and 3');
    }
    const row = this.lifecycleRepository.getRunWithThreadId(runId);
    if (!row) throw new NotFoundError('Test gen run not found');
    if (row.status !== 'WAITING_REVIEW') {
      throw new ConflictError('Test gen is not waiting for review');
    }
    if (CHECKPOINT_BY_PHASE[row.phase] !== checkpointNumber) {
      throw new ValidationError('Checkpoint number does not match the current review phase');
    }
    if (!row.thread_id) throw new ConflictError('Test gen run has no checkpoint thread');
    return row;
  }

  private markRecoverableContextFailure(runId: string, error: Error): void {
    const htmlFailure = error instanceof HtmlKnowledgeRuntimeError;
    this.lifecycleRepository.markRunFailed(runId, htmlFailure
      ? {
          type: 'HTML_KNOWLEDGE_UNAVAILABLE',
          phase: 'html-knowledge',
          recoverable: true,
        }
      : {
          type: 'CONTEXT_SETUP_FAILED',
          phase: 'context',
          recoverable: true,
        });
    this.sseGateway.emit(runId, 'pipeline:error', {
      phase: htmlFailure ? 'html-knowledge' : 'context',
      type: htmlFailure ? error.code : 'CONTEXT_SETUP_FAILED',
      message: error.message,
      recoverable: true,
    });
  }

  /**
   * Rebuild the BatchInput for a failed batch when no checkpoint exists to
   * resume from. Iterates through epics/sub-batches to find the epic +
   * generationMode that corresponds to the given batch number, then builds
   * the full batch input state (including global context and accumulated
   * coverage from past batches).
   */
  private rebuildBatchInputForRetry(
    runId: string,
    projectId: string,
    config: any,
    currentBatch: number,
    htmlKnowledge?: ResolvedHtmlKnowledgeRuntime,
  ): BatchInput | null {
    const requirementSource = loadRunRequirementSource(projectId, {
      requirementIds: Array.isArray(config.requirementIds) ? config.requirementIds : [],
      flowIds: Array.isArray(config.flowIds) ? config.flowIds : [],
      htmlKnowledgeSetId: config.htmlKnowledgeSetId,
    }, htmlKnowledge);
    const { requirementIds, flowIds, allIndex, requirements } = requirementSource;
    const selectedIds = selectedRequirementAndFlowIds(requirementIds, flowIds);
    const { epics, rootGroups } = groupRequirementsByEpic(allIndex, selectedIds);
    const allFlowStories = requirements.filter(r => r.level === 'story' && r.isFlow && r.status === 'APPROVED');
    const selectedFlowSet = new Set(flowIds);
    const filteredFlowStories = selectedFlowSet.size > 0
      ? allFlowStories.filter(s => selectedFlowSet.has(s.id))
      : allFlowStories;
    const businessFlows = buildBlueprintsFromFlowStories({
      flowStories: filteredFlowStories,
      requirements,
    });
    const reqMap = new Map(requirements.map(r => [r.id, r]));

    // Compute total sub-batches: 1 per epic (component + flow merged, mixed mode) (P0.3)
    const totalSubBatches = computeTotalSubBatches(epics, rootGroups, reqMap);

    // Find the epic for the current batch number (mixed mode: 1 batch per epic)
    let batchCounter = 0;
    let failedEpic: any = null;
    let failedStoryIds: string[] = [];

    for (const epic of epics) {
      const childIds = rootGroups.get(epic.id) ?? [];
      const componentStoryIds = childIds.filter(id => {
        const r = reqMap.get(id);
        return r && r.level === 'story' && !r.isFlow;
      });
      const flowStoryIds = childIds.filter(id => {
        const r = reqMap.get(id);
        return r && r.level === 'story' && r.isFlow && r.status === 'APPROVED';
      });
      const combinedStoryIds = [...componentStoryIds, ...flowStoryIds];

      if (combinedStoryIds.length > 0) {
        batchCounter++;
        if (batchCounter === currentBatch) {
          failedEpic = epic;
          failedStoryIds = combinedStoryIds;
          break;
        }
      }
    }

    if (!failedEpic) {
      Log.for('orchestrator').error(`Could not find epic for batch ${currentBatch} (total ${totalSubBatches} sub-batches)`);
      return null;
    }

    const flowReferencedComponentContext = this.buildFlowReferencedComponentContext(selectedFlowSet, requirements, reqMap);

    // Rebuild global context (same as continueRemainingBatches) (P0.1)
    const globalStats = {
      totalRequirements: requirements.length,
      totalEpics: epics.length,
      totalFlows: allFlowStories.length,
    };
    const globalEpicIndex = buildGlobalEpicIndex(epics, rootGroups, requirements, allFlowStories);

    // Load accumulated coverage from past agent logs
    const accumulatedCoverage = new CoverageIndex();
    try {
      this.loadCoverageFromLogs(runId, accumulatedCoverage, currentBatch);
    } catch (e) {
      Log.for('orchestrator').warn(`Failed to load past coverage for retry: ${e}`);
    }

    const previousBatchCoverageSummary = accumulatedCoverage.summaryList();

    const batchInput: BatchInput = {
      batchIndex: currentBatch - 1,
      inputState: {
        ...this.buildBatchInputState(
          runId, projectId, requirementIds, requirements, rootGroups, failedEpic,
          currentBatch - 1, totalSubBatches, businessFlows,
          config.mode || 'auto', flowIds,
          'mixed', failedStoryIds, flowReferencedComponentContext,
          htmlKnowledge?.reference,
        ),
        globalStats,
        globalEpicIndex,
        previousBatchCoverageSummary: previousBatchCoverageSummary.length > 0
          ? previousBatchCoverageSummary
          : undefined,
      },
    };

    return batchInput;
  }

  async getCheckpointState(runId: string): Promise<any> {
    const run = pipelineRepo.getRunWithThreadId(runId);
    if (!run?.thread_id) return null;

    pipelineRepo.touchRun(runId);

    const graph = buildTestGenGraph({ provider: createDummyProvider(), checkpointer });
    const snapshot = await graph.getState({ configurable: { thread_id: run.thread_id } });
    const state = snapshot?.values;
    if (!state) return null;

    switch (run.phase) {
      case 'review-conditions':
        return { checkpointData: { conditions: state.testConditions ?? [], analysis: state.requirementAnalysis ?? null } };
      case 'review-draft':
        return { checkpointData: { cases: state.draftTestCases ?? [] } };
      case 'final-review':
        return { checkpointData: { cases: state.finalTestCases ?? [], matrix: state.coverageMatrix ?? null } };
      default:
        return null;
    }
  }

  async saveCheckpointEdits(runId: string, editedData: Record<string, unknown>, checkpointNumber: number): Promise<void> {
    const releaseOperation = this.contextBuilder.registerExternalOperation(runId);
    try {
      const initialRow = this.requireEditableCheckpointRun(runId, checkpointNumber);
      this.deletionLock.assertStartAllowed(initialRow.project_id);

      const AGENT_NAMES: Record<number, string> = { 1: 'test_analyst', 2: 'test_designer', 3: 'quality_manager' };
      const agentName = AGENT_NAMES[checkpointNumber];
      const stateKeys: Record<string, unknown> = {};
      if (checkpointNumber === 1) {
        if (editedData.conditions) stateKeys.testConditions = editedData.conditions;
        if (editedData.analysis) stateKeys.requirementAnalysis = editedData.analysis;
      } else if (checkpointNumber === 2) {
        if (editedData.cases) stateKeys.draftTestCases = editedData.cases;
      } else if (checkpointNumber === 3) {
        if (editedData.cases) stateKeys.finalTestCases = editedData.cases;
        if (editedData.matrix) stateKeys.coverageMatrix = editedData.matrix;
      }
      if (Object.keys(stateKeys).length === 0) return;

      const graph = buildTestGenGraph({ provider: createDummyProvider(), checkpointer });
      const currentRow = this.requireEditableCheckpointRun(runId, checkpointNumber);
      this.deletionLock.assertStartAllowed(currentRow.project_id);
      await graph.updateState(
        { configurable: { thread_id: currentRow.thread_id } },
        stateKeys,
      );

      try {
        const updatedPayload = await this.getCheckpointState(runId);
        if (updatedPayload) {
          this.sseGateway.emit(runId, 'checkpoint:waiting', {
            checkpointNumber,
            type: currentRow.phase,
            summary: 'Awaiting Review',
            payload: updatedPayload,
          });
        }
        if (agentName) pipelineRepo.updateAgentLogOutput(runId, agentName, stateKeys);
      } catch (err) {
        Log.for('orchestrator').error(`Failed to refresh checkpoint state after edit for ${runId}: ${err}`);
      }
    } finally {
      releaseOperation();
    }
  }

  private async continueRemainingBatches(
    runId: string,
    projectId: string,
    config: any,
    ctx: RunContext,
  ): Promise<{ allResults: BatchResult[]; interrupted: boolean }> {
    const requirementSource = loadRunRequirementSource(projectId, {
      requirementIds: Array.isArray(config.requirementIds) ? config.requirementIds : [],
      flowIds: Array.isArray(config.flowIds) ? config.flowIds : [],
      htmlKnowledgeSetId: config.htmlKnowledgeSetId,
    }, ctx.htmlKnowledge);
    const {
      requirementIds,
      flowIds,
      allIndex,
      requirements,
    } = requirementSource;
    const startFrom = ctx.scope.currentBatch;

    const selectedIds = selectedRequirementAndFlowIds(requirementIds, flowIds);
    const { epics, rootGroups, totalBatches } = groupRequirementsByEpic(allIndex, selectedIds);
    const allFlowStories = requirements
      .filter(r => r.level === 'story' && r.isFlow && r.status === 'APPROVED');
    const selectedFlowSet = new Set(flowIds);
    const filteredFlowStories = selectedFlowSet.size > 0
      ? allFlowStories.filter(s => selectedFlowSet.has(s.id))
      : allFlowStories;
    const businessFlows = buildBlueprintsFromFlowStories({
      flowStories: filteredFlowStories,
      requirements,
    });
    const reqMap = new Map(requirements.map(r => [r.id, r]));

    // 计算总子批次数：每个 epic 一个批次（component + flow 合并，mixed mode） (P0.3)
    const totalSubBatches = computeTotalSubBatches(epics, rootGroups, reqMap);

    const flowReferencedComponentContext = this.buildFlowReferencedComponentContext(selectedFlowSet, requirements, reqMap);

    // Rebuild global context (P0.1)
    const globalStats = {
      totalRequirements: requirements.length,
      totalEpics: epics.length,
      totalFlows: allFlowStories.length,
    };
    const globalEpicIndex = buildGlobalEpicIndex(epics, rootGroups, requirements, allFlowStories);

    const allResults: BatchResult[] = [];
    // L2 累积：从已完成的 agent logs 加载，避免 resume 后跨批次防重复失效
    let accumulatedCoverage = new CoverageIndex();
    
    // First, attempt to load from serialized storage (P1.8)
    let loadedFromState = false;
    try {
      const serialized = this.readRunStateCoverage(runId);
      if (serialized.loadedFromArray) {
        accumulatedCoverage = serialized.coverage;
        Log.for('orchestrator').info(`Loaded ${accumulatedCoverage.size} coverage entries from serialized state for run ${runId}`);
        loadedFromState = true;
      }
    } catch (err: any) {
      Log.for('orchestrator').warn(`Failed to parse serialized coverage state: ${err.message}`);
    }

    if (!loadedFromState) {
      try {
        this.loadCoverageFromLogs(runId, accumulatedCoverage, startFrom + 1);
        if (accumulatedCoverage.size > 0) {
          Log.for('orchestrator').info(`Pre-loaded coverage for ${accumulatedCoverage.size} requirements from past logs before continuing`);
        }
      } catch (e) {
        Log.for('orchestrator').warn(`Failed to pre-load past batch coverage from logs: ${e}`);
      }
    }

    // 执行批次循环 (P0.2)
    const loopRes = await this.executeBatchLoop(ctx, {
      runId,
      projectId,
      requirementIds,
      flowIds,
      mode: config.mode || 'auto',
      epics,
      rootGroups,
      reqMap,
      requirements,
      businessFlows,
      flowReferencedComponentContext,
      globalStats,
      globalEpicIndex,
      accumulatedCoverage,
      startFrom,
      totalSubBatches,
      htmlKnowledgeReference: ctx.htmlKnowledge?.reference,
    }, allResults);

    return { allResults, interrupted: loopRes.interrupted };
  }

  private async executeBatchLoop(
    ctx: RunContext,
    params: BatchLoopParams,
    allResults: BatchResult[],
  ): Promise<{ interrupted: boolean; keepSse: boolean }> {
    const log = Log.for('orchestrator');
    let batchCounter = 0;

    for (let i = 0; i < params.epics.length; i++) {
      if (ctx.isAborted()) break;
      const epic = params.epics[i];
      const childIds = params.rootGroups.get(epic.id) ?? [];

      const componentStoryIds = childIds.filter(id => {
        const r = params.reqMap.get(id);
        return r && r.level === 'story' && !r.isFlow;
      });
      const flowStoryIds = childIds.filter(id => {
        const r = params.reqMap.get(id);
        return r && r.level === 'story' && r.isFlow && r.status === 'APPROVED';
      });
      const combinedStoryIds = [...componentStoryIds, ...flowStoryIds];

      if (combinedStoryIds.length > 0) {
        batchCounter++;
        if (batchCounter > params.startFrom) {
          if (ctx.isAborted()) break;

          Log.subsection(`Batch ${batchCounter}/${params.totalSubBatches} START ── epic: ${epic.id ?? 'N/A'} [MIXED]`);
          ctx.scope.setBatch(batchCounter, params.totalSubBatches);
          pipelineRepo.updateCurrentBatch(params.runId, batchCounter);
          // 使用统一的 threadId 命名，避免 start 和 continue/retry 差异
          const threadId = `${params.runId}-batch-${epic.id}-mixed`;
          pipelineRepo.updateThreadId(params.runId, threadId);

          const previousBatchCoverageSummary = params.accumulatedCoverage.summaryList();

          const batchInput: BatchInput = {
            batchIndex: batchCounter - 1,
            inputState: {
              ...this.buildBatchInputState(
                params.runId, params.projectId, params.requirementIds, params.requirements, params.rootGroups, epic, batchCounter - 1, params.totalSubBatches, params.businessFlows,
                params.mode, params.flowIds,
                'mixed',
                combinedStoryIds,
                params.flowReferencedComponentContext,
                params.htmlKnowledgeReference,
              ),
              globalStats: params.globalStats,
              globalEpicIndex: params.globalEpicIndex,
              previousBatchCoverageSummary: previousBatchCoverageSummary.length > 0 ? previousBatchCoverageSummary : undefined,
            },
          };

          const outcome = await ctx.session.startBatch(batchInput, threadId);
          if (outcome.type === 'interrupt') {
            log.info(`Batch ${batchCounter} INTERRUPTED at phase=${outcome.interrupt.phase}, checkpoint=${outcome.interrupt.checkpointNumber}`);
            ctx.scope.flushAndPersistThinking();
            pipelineRepo.setRunWaiting(params.runId, outcome.interrupt.phase);
            this.emitCheckpointWaiting(params.runId, outcome.interrupt);
            return { interrupted: true, keepSse: true };
          }

          // 累积本批次已生成的 conditions 摘要
          const batchConditions: any[] = outcome.result.lastState?.testConditions ?? [];
          for (const tc of batchConditions) {
            params.accumulatedCoverage.addCondition(tc);
          }
          // 累积本批次已生成的 finalTestCases 标题+级别
          const batchCases: any[] = outcome.result.lastState?.finalTestCases ?? [];
          for (const tc of batchCases) {
            params.accumulatedCoverage.addCase(tc);
          }

          // Serialized storage for accumulatedCoverage (P1.8)
          try {
            this.persistRunStateCoverage(params.runId, params.accumulatedCoverage);
          } catch (err: any) {
            log.warn(`Failed to serialize accumulated coverage state: ${err.message}`);
          }

          log.success(`Batch ${batchCounter}/${params.totalSubBatches} complete ── ${outcome.result.cases.length} test cases (MIXED), ${batchConditions.length} conditions, ${batchCases.length} cases accumulated`);
          allResults.push(outcome.result);
          ctx.sendEvent('batch:complete', {
            batch: batchCounter, total: params.totalSubBatches,
            testCases: outcome.result.cases.length,
            mode: 'mixed',
          });
        }
      }
    }
    return { interrupted: false, keepSse: false };
  }

  /** 从已完成的 analyst / quality agent logs 中合并累积覆盖（跨批次、跨运行去重）。 */
  private loadCoverageFromLogs(
    runId: string,
    coverage: CoverageIndex,
    beforeBatch?: number,
  ): void {
    const isEligible = (logEntry: any): boolean =>
      logEntry.status === 'COMPLETED'
      && (beforeBatch === undefined || logEntry.batch < beforeBatch);
    const analystLogs = pipelineRepo.getAgentLogs(runId, 'test_analyst');
    for (const logEntry of analystLogs.filter(isEligible)) {
      const tcs: any[] = logEntry.output_data?.testConditions ?? [];
      for (const tc of tcs) {
        if (tc.id && tc.condition && tc.requirementId) coverage.addCondition(tc);
      }
    }
    const qualityLogs = pipelineRepo.getAgentLogs(runId, 'quality_manager');
    for (const logEntry of qualityLogs.filter(isEligible)) {
      const cases: any[] = logEntry.output_data?.finalTestCases ?? [];
      for (const tc of cases) coverage.addCase(tc);
    }
  }

  /** 读取序列化的累积覆盖（getRunState）。JSON 非法时抛错，由调用方 try/catch。 */
  private readRunStateCoverage(runId: string): {
    coverage: CoverageIndex;
    statePresent: boolean;
    loadedFromArray: boolean;
  } {
    const empty = new CoverageIndex();
    const stateStr = pipelineRepo.getRunState(runId);
    if (!stateStr) return { coverage: empty, statePresent: false, loadedFromArray: false };
    const parsed = JSON.parse(stateStr);
    if (Array.isArray(parsed)) {
      // 旧格式：仅摘要 entries 数组。
      return { coverage: CoverageIndex.fromSummaryEntries(parsed), statePresent: true, loadedFromArray: true };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).summary)) {
      // 新格式：CoverageIndex.serialize() 的结构化对象（摘要 + 明细）。
      return { coverage: CoverageIndex.deserialize(parsed), statePresent: true, loadedFromArray: true };
    }
    return { coverage: empty, statePresent: true, loadedFromArray: false };
  }

  private persistRunStateCoverage(runId: string, coverage: CoverageIndex): void {
    pipelineRepo.updateRunState(runId, JSON.stringify(coverage.serialize()));
  }

  private handleInterrupt(runId: string, ctx: RunContext, interrupt: InterruptInfo): void {
    ctx.scope.flushAndPersistThinking();
    pipelineRepo.updateThreadId(runId, interrupt.threadId);
    pipelineRepo.setRunWaiting(runId, interrupt.phase);
    this.emitCheckpointWaiting(runId, interrupt);
  }

  private emitCheckpointWaiting(runId: string, interrupt: InterruptInfo): void {
    this.sseGateway.emit(runId, 'checkpoint:waiting', {
      checkpointNumber: interrupt.checkpointNumber,
      phase: interrupt.phase,
      summary: 'Awaiting Review',
      payload: interrupt.payload,
    });
  }

  private finishRun(ctx: RunContext, allResults: BatchResult[], totalBatches: number): { totalCases: number; removedCount: number } {
    const allRawCases = allResults.flatMap((r: any) => r.lastState?.finalTestCases || r.cases || []);
    const { removedCount } = deduplicateTestCases(allRawCases);
    if (removedCount > 0) {
      ctx.sendEvent('pipeline:dedup', {
        removed: removedCount,
        remaining: allRawCases.length - removedCount,
        total: allRawCases.length,
      });
    }
    ctx.scope.markComplete({ totalCases: allRawCases.length, totalBatches });
    return { totalCases: allRawCases.length, removedCount };
  }

  /**
   * For each selected flow, collect its referenced component stories (with
   * ACs) so they can be injected into the batch prompt WITHOUT creating
   * separate batches for them. Shared by `start` and `continueRemainingBatches`.
   *
   * P4 dedup: component story contexts are built once globally and shared by
   * reference across flows, so a story referenced by N flows is constructed
   * once (not N times). AC serialization is slimmed to only `id` + `title`;
   * the LLM can call requirement_detail_query for full AC Given/When/Then text.
   */
  private buildFlowReferencedComponentContext(
    selectedFlowSet: Set<string>,
    requirements: any[],
    reqMap: Map<string, any>,
  ): Map<string, any[]> {
    const ctx = new Map<string, any[]>();
    if (selectedFlowSet.size === 0) return ctx;

    // Step 1: Collect each flow's referenced component story IDs, and the
    // global union of all referenced IDs (for one-shot context building).
    const flowToStoryIds = new Map<string, string[]>();
    const allReferencedStoryIds = new Set<string>();
    for (const flowId of selectedFlowSet) {
      const flowACs = requirements.filter(r => r.parentId === flowId && r.level === 'ac');
      const referencedStoryIds: string[] = [];
      const seen = new Set<string>();
      for (const ac of flowACs) {
        for (const refId of ac.relatedRequirementIds ?? []) {
          if (seen.has(refId)) continue;
          const refReq = reqMap.get(refId);
          if (refReq && refReq.level === 'story' && !refReq.isFlow) {
            referencedStoryIds.push(refId);
            seen.add(refId);
            allReferencedStoryIds.add(refId);
          }
        }
      }
      if (referencedStoryIds.length > 0) {
        flowToStoryIds.set(flowId, referencedStoryIds);
      }
    }

    // Step 2: Build context for each unique component story ONCE.
    // ACs include description (Given/When/Then) and flowType so the prompt
    // builder can parse them into structured fields — no tool calls needed.
    const storyContextCache = new Map<string, any>();
    for (const storyId of allReferencedStoryIds) {
      const story = reqMap.get(storyId)!;
      const epicReq = reqMap.get(story.parentId ?? '');
      const acs = requirements
        .filter(r => r.parentId === storyId && r.level === 'ac')
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(ac => ({
          id: ac.id,
          title: ac.title,
          description: ac.description ?? '',
          flowType: ac.flowType ?? 'atomic',
        }));
      storyContextCache.set(storyId, {
        id: story.id,
        title: story.title,
        description: story.description ?? '',
        epicId: epicReq?.id ?? '',
        epicTitle: epicReq?.title ?? '',
        isFlow: story.isFlow ?? false,
        acceptanceCriteria: acs,
      });
    }

    // Step 3: Each flow stores references to the shared story contexts
    // (no duplicate construction per flow).
    for (const [flowId, storyIds] of flowToStoryIds) {
      ctx.set(flowId, storyIds.map(id => storyContextCache.get(id)!));
    }
    return ctx;
  }

  private buildBatchInputState(
    runId: string,
    projectId: string,
    requirementIds: string[],
    requirements: any[],
    rootGroups: Map<string, string[]>,
    epic: any,
    i: number,
    totalBatches: number,
    businessFlows: any[],
    mode: 'auto' | 'interactive' = 'auto',
    selectedFlowIds: string[] = [],
    generationMode: 'component' | 'flow' | 'mixed' = 'component',
    selectedStoryIds: string[] = [],
    flowReferencedComponentContext: Map<string, any[]> = new Map(),
    htmlKnowledgeReference?: HtmlKnowledgeReference,
  ) {
    const selectedStoryIdSet = new Set(selectedStoryIds);
    // Filter requirements to only include selected stories and their ACs
    const batchReqs = requirements.filter((r: any) => {
      if (r.level === 'story') {
        return selectedStoryIdSet.has(r.id);
      }
      if (r.level === 'ac') {
        return selectedStoryIdSet.has(r.parentId);
      }
      return false;
    });

    // IndexEntry only has {id, parent, level, title} — look up description
    // from the full requirements array.
    const epicReq = requirements.find((r: any) => r.id === epic.id);
    const epicData = { id: epic.id, title: epic.title, description: epicReq?.description ?? '' };

    // Build currentBatch (used by Designer/Quality prompts and validation).
    // AC records inherit isFlow from their parent story — the DB does not set
    // isFlow on ACs individually (see comment above at the flowAcCount fix).
    const storyIsFlow = new Map<string, boolean>();
    for (const r of batchReqs) {
      if (r.level === 'story') storyIsFlow.set(r.id, r.isFlow ?? false);
    }
    const currentBatch = batchReqs.map((r: any) => {
      const acs = r.level === 'story'
        ? requirements
            .filter((c: any) => c.parentId === r.id && c.level === 'ac')
            .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
            .map((ac: any) => ({
              id: ac.id,
              title: ac.title,
              description: ac.description ?? '',
              flowType: ac.flowType ?? 'atomic',
              relatedRequirementIds: ac.relatedRequirementIds ?? [],
            }))
        : [];
      return {
        id: r.id,
        title: r.title,
        level: r.level ?? '',
        parentId: r.parentId ?? '',
        description: r.description ?? '',
        isFlow: r.level === 'ac'
          ? (r.isFlow || storyIsFlow.get(r.parentId) || false)
          : (r.isFlow ?? false),
        acceptanceCriteria: acs,
      };
    });

    // Keep businessFlowBlueprints for the state (used by Designer/Quality prompts).
    // Blueprints are keyed by AC id (one per AC path), so filter by AC ids
    // under the flow stories in this batch.
    let filteredBusinessFlows: any[] = [];
    if (generationMode === 'flow' || generationMode === 'mixed') {
      const batchAcIds = new Set<string>();
      for (const story of currentBatch.filter(r => r.isFlow)) {
        for (const ac of (story.acceptanceCriteria ?? [])) {
          batchAcIds.add(ac.id);
        }
      }
      filteredBusinessFlows = businessFlows.filter((f: any) => batchAcIds.has(f.id));
    }

    // Build the pre-assembled analystInput JSON — one source of truth for
    // the Analyst's user prompt, avoiding reconstruction in buildAnalystUserMessage.
    // Flow mode carries referencedComponentContext (for real dependency
    // conditionIds) — see analyst-input-builder.ts.
    // filteredBusinessFlows is passed so the LLM sees the exact flowId values
    // to use in flowStepRefs (prevents hallucinated flowId duplicates).
    const analystInput = buildAnalystInput({
      epic: epicData,
      currentBatch,
      flowReferencedComponentContext: flowReferencedComponentContext.size > 0
        ? Object.fromEntries(flowReferencedComponentContext)
        : undefined,
      generationMode,
      flowBlueprints: filteredBusinessFlows,
    });

    // Look up the real project name (single PK query). Previously this used
    // `epic.title`, which leaked the epic title into the Project field of
    // the prompt and confused the LLM about scope.
    const projectRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    const projectName = projectRow?.name ?? 'Unknown Project';

    return {
      projectId,
      runId,
      mode,
      requirementIds,
      epic: epicData,
      currentBatch,
      analystInput,
      batchContext: { currentBatch: i + 1, totalBatches, processedCount: i },
      projectContext: { name: projectName, pages: [], endpoints: [] },
      businessFlowBlueprints: filteredBusinessFlows,
      htmlKnowledgeReference,
      selectedFlowIds,
      generationMode,
      phase: 'analysis' as const,
    };
  }
}
