import { Command } from '@langchain/langgraph';
import { buildTestGenGraph } from './graph/graph.ts';
import { checkpointer } from './graph/checkpointer.ts';
import type { AIProvider } from './infra/provider.ts';
import type { AgentObserver } from './graph/nodes/types.ts';
import type { TestGenState, GlobalEpicEntry, CrossEpicDependency, PreviousBatchCoverageSummary } from './graph/state.ts';
import { clearQueryCache } from './graph/skills/data-skills.ts';
import { Log } from '../../shared/services/logger.ts';
import type { HtmlKnowledgeReference } from './html-knowledge/types.ts';
import {
  requireMatchingHtmlKnowledgeRuntime,
  type ResolvedHtmlKnowledgeRuntime,
} from './graph/skills/html-knowledge.ts';

export interface BatchInput {
  batchIndex: number;
  inputState: {
    projectId: string;
    runId: string;
    mode: 'auto' | 'interactive';
    requirementIds: string[];
    epic?: { id: string; title: string; description: string };
    analystInput?: Record<string, unknown>;
    currentBatch: any[];
    batchContext: { currentBatch: number; totalBatches: number; processedCount: number };
    projectContext: { name: string; pages: { name: string }[]; endpoints: { name: string; method: string }[] };
    businessFlowBlueprints: any[] | undefined;
    htmlKnowledgeReference?: HtmlKnowledgeReference;
    selectedFlowIds: string[];
    generationMode: 'component' | 'flow' | 'mixed';
    globalStats?: { totalRequirements: number; totalEpics: number; totalFlows: number };
    // L1/L2 字段
    globalEpicIndex?: GlobalEpicEntry[];
    crossEpicDependencies?: CrossEpicDependency[];
    previousBatchCoverageSummary?: PreviousBatchCoverageSummary[];
    relevantFlowBlueprints?: any[];
    phase: TestGenState['phase'];
  };
}

export interface BatchResult {
  batchIndex: number;
  cases: unknown[];
  tokenUsage: { input: number; output: number; total: number };
  lastState: Partial<TestGenState>;
}

export interface InterruptInfo {
  threadId: string;
  phase: string;
  checkpointNumber: number;
  payload: Record<string, unknown>;
}

export type RunOutcome =
  | { type: 'complete'; result: BatchResult }
  | { type: 'interrupt'; interrupt: InterruptInfo };

export interface SessionOptions {
  runId: string;
  projectId: string;
  provider: AIProvider;
  observer: AgentObserver;
  modelName: string;
  tokenLimit: number | null;
  timeoutMs?: number;
  useCache?: boolean;
  signal?: AbortSignal;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
}

export type CheckpointInspection =
  | { kind: 'none' }
  | { kind: 'start-only'; values: Partial<TestGenState> }
  | { kind: 'meaningful'; values: Partial<TestGenState> }
  | { kind: 'completed'; values: Partial<TestGenState> };

export class CheckpointUnavailableError extends Error {
  readonly code: string = 'CHECKPOINT_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CheckpointUnavailableError';
  }
}

export class CheckpointCorruptError extends CheckpointUnavailableError {
  readonly code = 'CHECKPOINT_CORRUPT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CheckpointCorruptError';
  }
}

export class TestGenSessionAbortedError extends Error {
  readonly code = 'TEST_GEN_SESSION_ABORTED';

  constructor() {
    super('Test gen graph stream aborted');
    this.name = 'TestGenSessionAbortedError';
  }
}

export class EmptyGraphStreamError extends CheckpointUnavailableError {
  readonly code = 'EMPTY_GRAPH_STREAM';

  constructor() {
    super('Test gen graph stream completed without emitting state');
    this.name = 'EmptyGraphStreamError';
  }
}

export class HtmlKnowledgeReferenceMismatchError extends Error {
  readonly code = 'HTML_KNOWLEDGE_REFERENCE_MISMATCH';
  readonly recoverable = true;

  constructor(message = 'Checkpoint HTML knowledge reference does not match the resolved runtime') {
    super(message);
    this.name = 'HtmlKnowledgeReferenceMismatchError';
  }
}

export class TestGenSession {
  private aborted = false;

  constructor(private readonly opts: SessionOptions) {}

  abort(): void {
    this.aborted = true;
  }

  private isAborted(): boolean {
    return this.aborted || this.opts.signal?.aborted === true;
  }

  private compileGraph() {
    return buildTestGenGraph({
      provider: this.opts.provider,
      observer: this.opts.observer,
      modelName: this.opts.modelName,
      tokenLimit: this.opts.tokenLimit,
      timeoutMs: this.opts.timeoutMs,
      useCache: this.opts.useCache,
      signal: this.opts.signal,
      checkpointer,
      htmlKnowledge: this.opts.htmlKnowledge,
    });
  }

  private threadId(batchIndex: number): string {
    return `${this.opts.runId}-batch-${batchIndex}`;
  }

  /**
   * 启动一个新批次的流水线执行
   */
  async startBatch(batch: BatchInput, threadIdOverride?: string): Promise<RunOutcome> {
    const graph = this.compileGraph();
    const tid = threadIdOverride ?? this.threadId(batch.batchIndex);

    const input = {
      projectId: batch.inputState.projectId,
      runId: batch.inputState.runId,
      mode: batch.inputState.mode,
      requirementIds: batch.inputState.requirementIds,
      epic: batch.inputState.epic,
      analystInput: batch.inputState.analystInput,
      currentBatch: batch.inputState.currentBatch,
      batchContext: batch.inputState.batchContext,
      projectContext: batch.inputState.projectContext,
      businessFlowBlueprints: batch.inputState.businessFlowBlueprints,
      htmlKnowledgeReference: batch.inputState.htmlKnowledgeReference,
      selectedFlowIds: batch.inputState.selectedFlowIds,
      generationMode: batch.inputState.generationMode ?? 'component',
      globalStats: batch.inputState.globalStats,
      // L1/L2 透传：crossEpicDependencies 与 relevantFlowBlueprints 由 preparation 节点写入
      globalEpicIndex: batch.inputState.globalEpicIndex,
      previousBatchCoverageSummary: batch.inputState.previousBatchCoverageSummary,
      phase: batch.inputState.phase,
      skillCalls: [],
      humanReviewFeedback: '',
    };

    const log = Log.for('session');
    log.info(`Starting batch ${batch.batchIndex} (threadId=${tid})`);
    clearQueryCache();
    this.assertHtmlKnowledgeReference(input);

    return this.streamToOutcome(graph, input, tid, batch.batchIndex);
  }

  /**
   * 从 checkpoint 恢复执行
   */
  async resumeAt(
    threadId: string,
    resumeInput: { action: 'approve' | 'retry'; feedback?: string; edits?: any },
  ): Promise<RunOutcome> {
    const graph = this.compileGraph();
    const inspection = await this.inspectCheckpointWithGraph(graph, threadId);
    if (inspection.kind === 'completed') {
      return this.completedCheckpointOutcome(inspection.values);
    }
    if (inspection.kind !== 'meaningful') {
      throw new CheckpointUnavailableError(
        `Checkpoint ${inspection.kind === 'start-only' ? 'contains only __start__' : 'is unavailable'}`,
      );
    }
    this.assertHtmlKnowledgeReference(inspection.values);
    clearQueryCache();

    const resumeCommand = new Command({
      resume: {
        action: resumeInput.action,
        feedback: resumeInput.feedback,
        conditions: resumeInput.edits?.conditions,
        cases: resumeInput.edits?.cases,
        analysis: resumeInput.edits?.analysis,
        matrix: resumeInput.edits?.matrix,
        retry: resumeInput.action === 'retry',
      },
    });

    Log.for('session').info(`Resuming threadId=${threadId}, action=${resumeInput.action}`);

    return this.streamToOutcome(graph, resumeCommand, threadId, 0);
  }

  /**
   * 从失败的节点重试：利用 LangGraph checkpointer 保存的状态，
   * 传入 null 作为 input，LangGraph 会自动从最后一个 checkpoint 恢复并重新执行失败节点。
   *
   * 关键机制：当 analyst/designer/quality 节点 throw 时，LangGraph 不会为该节点
   * 保存 checkpoint。最后一个 checkpoint 来自前一个成功完成的节点。因此
   * stream(null, ...) 会从失败的那个节点重新开始执行 —— 这正是我们想要的。
   */
  async retryFromLastCheckpoint(threadId: string, batchIndex: number): Promise<RunOutcome> {
    const graph = this.compileGraph();
    const log = Log.for('session');
    const inspection = await this.inspectCheckpointWithGraph(graph, threadId);
    if (inspection.kind === 'completed') {
      return this.completedCheckpointOutcome(inspection.values, batchIndex);
    }
    if (inspection.kind !== 'meaningful') {
      throw new CheckpointUnavailableError(
        `Checkpoint ${inspection.kind === 'start-only' ? 'contains only __start__' : 'is unavailable'}`,
      );
    }
    this.assertHtmlKnowledgeReference(inspection.values);
    clearQueryCache();

    log.info(`Retrying from last checkpoint (threadId=${threadId}, batch=${batchIndex})`);
    return this.streamToOutcome(graph, null, threadId, batchIndex);
  }

  /**
   * 从 agent logs 恢复已成功 agent 的状态，然后从失败的 agent 继续执行。
   *
   * 当 checkpoint 恢复失败时（thread_id 丢失、__start__ 状态、checkpointer 数据
   * 损坏等），用此方法避免从头开始。从数据库 agent logs 中查出当前 batch 已
   * 成功完成的 agent 输出，用 `graph.updateState(values, asNode)` 写入一个新
   * 的 checkpoint，然后 `stream(null)` 从该 checkpoint 恢复 —— 即从失败的
   * agent 重新开始，而不是从 preparation 重新开始。
   *
   * `asNode` 让 LangGraph 认为最后成功的 agent "刚执行完"，根据 graph 路由
   * 计算出正确的 `next` 节点（例如 asNode='analyst' → next='checkpoint_1'
   * → auto-approve → designer）。
   *
   * @param threadId       新的 thread_id（避免 stale checkpoint）
   * @param batchIndex     当前 batch 索引
   * @param baseInput      preparation 节点的输入 state（来自 rebuildBatchInputForRetry）
   * @param completedAgentOutputs 已成功 agent 的输出，按执行顺序排列
   */
  async retryFromAgentLogs(
    threadId: string,
    batchIndex: number,
    baseInput: Record<string, unknown>,
    completedAgentOutputs: { agentName: string; outputData: Record<string, unknown> }[],
  ): Promise<RunOutcome> {
    const graph = this.compileGraph();
    const log = Log.for('session');
    const config = { configurable: { thread_id: threadId } };
    this.assertCheckpointIdentity(baseInput as Partial<TestGenState>);
    clearQueryCache();

    // agent_name → graph node name
    const agentToNode: Record<string, string> = {
      test_analyst: 'analyst',
      test_designer: 'designer',
      quality_manager: 'quality',
    };

    // 合并 baseInput（模拟 preparation 的输出）+ 所有已成功 agent 的输出。
    // baseInput 包含 preparation 需要的所有输入字段；environmentReady/tokenBudget
    // 等是 preparation 节点的输出字段，设为默认值即可（retry 场景下不再需要
    // token 估算）。
    const mergedState: Record<string, unknown> = {
      ...baseInput,
      phase: 'analysis',
    };

    let lastNode = 'preparation';
    for (const { agentName, outputData } of completedAgentOutputs) {
      const nodeName = agentToNode[agentName];
      if (!nodeName) continue;
      Object.assign(mergedState, outputData);
      if (baseInput.mode === 'auto' && agentName === 'test_analyst') {
        mergedState.approvedConditions = outputData.testConditions;
        mergedState.phase = 'review-conditions';
      }
      if (baseInput.mode === 'auto' && agentName === 'test_designer') {
        mergedState.approvedDraftCases = outputData.draftTestCases;
        mergedState.phase = 'review-draft';
      }
      lastNode = nodeName;
    }

    // 用 asNode=lastNode 写入合并后的 state。LangGraph 会认为 lastNode 刚
    // 执行完，根据 graph 边路由计算 next（例如 analyst→checkpoint_1,
    // designer→checkpoint_2）。然后 stream(null) 从 next 开始执行。
    await (graph as any).updateState(config, mergedState, lastNode);
    log.info(`Restored state from ${completedAgentOutputs.length} agent(s) [${completedAgentOutputs.map(a => a.agentName).join(', ')}], asNode=${lastNode}, resuming from next node`);

    // 诊断：打印恢复后的 checkpoint state
    try {
      const snapshot = await (graph as any).getState(config);
      const next = snapshot?.next ?? [];
      log.info(`Checkpoint after restore: next=[${next.join(',')}], will resume from there`);
    } catch (e: any) {
      log.warn(`Failed to read post-restore checkpoint state: ${e.message}`);
    }

    return this.streamToOutcome(graph, null, threadId, batchIndex);
  }

  async inspectCheckpoint(threadId: string): Promise<CheckpointInspection> {
    return this.inspectCheckpointWithGraph(this.compileGraph(), threadId);
  }

  private async inspectCheckpointWithGraph(
    graph: ReturnType<typeof this.compileGraph>,
    threadId: string,
  ): Promise<CheckpointInspection> {
    let snapshot: any;
    try {
      snapshot = await (graph as any).getState({
        configurable: { thread_id: threadId },
      });
    } catch (error) {
      throw new CheckpointUnavailableError(
        'Checkpoint is unavailable or corrupt',
        { cause: error },
      );
    }
    if (!snapshot) return { kind: 'none' };

    const values = snapshot.values && typeof snapshot.values === 'object'
      ? snapshot.values as Partial<TestGenState>
      : {};
    const next = Array.isArray(snapshot.next) ? snapshot.next : [];
    if (Object.keys(values).length === 0 && next.length === 0) {
      return { kind: 'none' };
    }
    this.assertCheckpointIdentity(values);
    if (next.length === 1 && next[0] === '__start__') {
      return { kind: 'start-only', values };
    }
    if (next.length === 0) {
      return { kind: 'completed', values };
    }
    return { kind: 'meaningful', values };
  }

  private assertCheckpointIdentity(state: Partial<TestGenState>): void {
    if (state.runId !== this.opts.runId || state.projectId !== this.opts.projectId) {
      throw new CheckpointCorruptError(
        'Checkpoint run or project identity does not match this session',
      );
    }
    this.assertHtmlKnowledgeReference(state);
  }

  private assertHtmlKnowledgeReference(state: Record<string, unknown>): void {
    try {
      requireMatchingHtmlKnowledgeRuntime(
        String(state.projectId ?? this.opts.htmlKnowledge?.projectId ?? ''),
        state.htmlKnowledgeReference as HtmlKnowledgeReference | undefined,
        this.opts.htmlKnowledge,
      );
    } catch {
      throw new HtmlKnowledgeReferenceMismatchError();
    }
  }

  private completedCheckpointOutcome(
    state: Partial<TestGenState>,
    fallbackBatchIndex?: number,
  ): RunOutcome {
    const currentBatch = state.batchContext?.currentBatch;
    const batchIndex = fallbackBatchIndex
      ?? (typeof currentBatch === 'number' && currentBatch > 0 ? currentBatch - 1 : 0);
    const cases = Array.isArray(state.finalTestCases) ? state.finalTestCases : [];
    return {
      type: 'complete',
      result: {
        batchIndex,
        cases,
        tokenUsage: { input: 0, output: 0, total: 0 },
        lastState: state,
      },
    };
  }

  /**
   * 检查指定 thread_id 是否存在可恢复的 checkpoint。
   *
   * LangGraph 在调用 stream(input, ...) 时会立即在 __start__ 创建一个初始 checkpoint
   *（包含 input values）。如果第一个真实节点（如 preparation）还没执行完就崩溃，
   * 这个 __start__ checkpoint 的 next 仍然是 ['__start__']，此时用 stream(null, ...)
   * 恢复会抛出 "Received no input writes for '__start__'"。
   *
   * 只有当 next 指向一个真实节点（如 'analyst'、'designer'）时，才代表有有意义的
   * checkpoint 可以恢复。
   */
  private async streamToOutcome(
    graph: ReturnType<typeof this.compileGraph>,
    input: Record<string, unknown> | Command | null,
    tid: string,
    batchIndex: number,
  ): Promise<RunOutcome> {
    const streamOpts = {
      configurable: { thread_id: tid },
      streamMode: 'values' as const,
    };

    const log = Log.for('session');
    log.info(`Streaming graph (threadId=${tid}, batch=${batchIndex})`);

    if (this.isAborted()) throw new TestGenSessionAbortedError();

    // retryFromLastCheckpoint 传入 null，LangGraph 从最后一个 checkpoint 恢复
    let stream: AsyncIterable<any>;
    try {
      stream = input === null
        ? await (graph as any).stream(null, streamOpts)
        : await (graph as any).stream(input, streamOpts);
    } catch (error) {
      if (this.isAborted()) throw new TestGenSessionAbortedError();
      throw error;
    }

    let lastState: any = null;
    let prevPhase: string | undefined;
    let interruptPayload: Record<string, unknown> | null = null;
    let nodeCount = 0;

    try {
      for await (const chunk of stream) {
        if (this.isAborted()) {
          log.info(`Aborted during streaming (threadId=${tid})`);
          throw new TestGenSessionAbortedError();
        }
        lastState = chunk;
        nodeCount++;

        const currentPhase = (chunk as any)?.phase as string | undefined;
        if (currentPhase && currentPhase !== prevPhase) {
          log.info(`Phase transition → ${currentPhase}`);
          prevPhase = currentPhase;
        }

        const interruptValue = (chunk as any)?.__interrupt__;
        if (interruptValue && Array.isArray(interruptValue) && interruptValue.length > 0) {
          const raw = interruptValue[0] as Record<string, unknown>;
          interruptPayload = (raw?.value as Record<string, unknown>) ?? raw;
          log.info(`INTERRUPTED at phase=${lastState?.phase}, checkpoint=${(interruptPayload as any).checkpointNumber ?? '?'}`);
          break;
        }
      }
    } catch (error) {
      if (this.isAborted() && !(error instanceof TestGenSessionAbortedError)) {
        throw new TestGenSessionAbortedError();
      }
      throw error;
    }

    log.info(`Stream complete: ${nodeCount} steps, threadId=${tid}`);

    if (this.isAborted()) throw new TestGenSessionAbortedError();
    if (nodeCount === 0) throw new EmptyGraphStreamError();

    if (interruptPayload) {
      const cpNum = (interruptPayload as any).checkpointNumber ?? 0;
      return {
        type: 'interrupt',
        interrupt: {
          threadId: tid,
          phase: (interruptPayload as any).phase ?? lastState?.phase ?? 'unknown',
          checkpointNumber: cpNum,
          payload: interruptPayload,
        },
      };
    }

    // In 'values' mode, lastState is the full state snapshot
    const cases = lastState?.finalTestCases ?? [];
    log.success(`Batch ${batchIndex} complete ── ${cases.length} final test cases`);
    return {
      type: 'complete',
      result: {
        batchIndex,
        cases,
        tokenUsage: { input: 0, output: 0, total: 0 },
        lastState: lastState ?? {},
      },
    };
  }
}
