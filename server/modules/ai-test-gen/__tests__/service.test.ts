import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/http/errors.ts';
import { TestGenController } from '../controller.ts';
import {
  ContextBuilder,
  HtmlKnowledgeRuntimeError,
  RunCancelledError,
} from '../context.ts';
import { HtmlKnowledgeService } from '../html-knowledge/service.ts';
import { hashHtmlRequirementSnapshot } from '../html-knowledge/requirement-snapshot.ts';
import type { BoundHtmlKnowledgeData } from '../html-knowledge/repository.ts';
import type { HtmlRequirementSnapshot } from '../html-knowledge/types.ts';
import { createStartPipelineHandler } from '../index.ts';
import { RunCacheRegistry, runCacheRegistry } from '../run-cache-registry.ts';
import { ProjectDeletionLock } from '../project-deletion-lock.ts';
import { deleteProjectTestGenData, testGenController } from '../runtime.ts';
import { SSEGateway } from '../sse-gateway.ts';
import { Orchestrator } from '../orchestrator.ts';
import { RunScope } from '../scope.ts';

const mockRepo = vi.hoisted(() => ({
  getCacheStore: vi.fn(() => ({
    getCache: vi.fn(), setCache: vi.fn(),
    invalidateByPromptVersion: vi.fn(), invalidateAll: vi.fn(),
  })),
  markRunFailed: vi.fn(), markRunCompleted: vi.fn(),
  getRun: vi.fn(), getRunWithThreadId: vi.fn(),
  getFailedRun: vi.fn(),
  insertAuditLog: vi.fn(), setRunRunning: vi.fn(),
  deleteRun: vi.fn(), updateThreadId: vi.fn(),
  setRunWaiting: vi.fn(), touchRun: vi.fn(),
  getWaitingRuns: vi.fn(() => []),
  getActiveProviderConfig: vi.fn(), getProviderConfigByName: vi.fn(),
  getProviderConfig: vi.fn(),
  updateProviderInfo: vi.fn(), updateBatchCount: vi.fn(), updateCurrentBatch: vi.fn(),
  getMonthlyTokenUsage: vi.fn(() => 0),
  listRunsByProject: vi.fn(() => []), getActiveRun: vi.fn(() => null),
  getRunInfo: vi.fn(() => null), getAgentLogs: vi.fn(() => []), getAuditLogs: vi.fn(() => []),
  createRun: vi.fn(),
  updateAgentLogOutput: vi.fn(),
  updatePhase: vi.fn(),
  getAccumulatedTokenUsage: vi.fn(() => ({
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    latency_ms: 0,
  })),
  saveAgentLog: vi.fn(),
  saveThinkingData: vi.fn(),
  getThinkingData: vi.fn(() => null),
  getRunState: vi.fn(() => null),
  updateRunState: vi.fn(),
}));

const mockProviderStream = vi.hoisted(() => vi.fn(async function* () { /* no-op */ }));

vi.mock('../repository.ts', () => ({
  pipelineRepo: mockRepo,
  decryptApiKey: vi.fn((key: string) => key),
}));

vi.mock('../../shared/db/client.ts', () => ({
  db: {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  },
}));

vi.mock('../infra/provider.ts', () => ({
  createAIProvider: vi.fn(() => ({
    streamChat: mockProviderStream,
  })),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function providerConfig() {
  return {
    id: 'provider-1',
    name: 'provider-1',
    type: 'openai',
    endpoint: null,
    encrypted_api_key: 'key',
    deployment: null,
    api_version: null,
    model: 'model-1',
    models: null,
    is_active: 1,
    monthly_token_limit: null,
    fallback_config_ids: null,
    reasoning_effort: null,
    reasoning_summary: null,
    text_verbosity: null,
  };
}

function boundHtmlKnowledgeData(): BoundHtmlKnowledgeData {
  const snapshot: HtmlRequirementSnapshot = {
    version: 1,
    projectId: 'project-1',
    selectedRequirementIds: ['story-1'],
    selectedFlowIds: [],
    records: [
      {
        id: 'epic-1',
        projectId: 'project-1',
        level: 'epic',
        title: 'Epic',
        description: 'Epic description',
        position: 0,
        status: 'APPROVED',
        flowType: null,
        isFlow: false,
        relatedRequirementIds: [],
      },
      {
        id: 'story-1',
        projectId: 'project-1',
        level: 'story',
        parentId: 'epic-1',
        title: 'Story',
        description: 'Story description',
        position: 1,
        status: 'APPROVED',
        flowType: null,
        isFlow: false,
        relatedRequirementIds: [],
      },
    ],
  };
  return {
    set: {
      id: 'set-1',
      project_id: 'project-1',
      run_id: 'html-run',
      status: 'BOUND',
      page_count: 1,
      total_bytes: 128,
      page_graph: '[]',
      index_version: 1,
      requirement_snapshot: JSON.stringify(snapshot),
      requirement_snapshot_hash: hashHtmlRequirementSnapshot(snapshot),
      created_at: '2026-08-22T00:00:00.000Z',
      updated_at: '2026-08-22T00:00:00.000Z',
    },
    pages: [{
      version: 1,
      pageId: 'page-1',
      fileName: 'login.html',
      fileNameKey: 'login.html',
      pageTitle: 'Login',
      contentSha256: 'b'.repeat(64),
      informationLevel: 'NORMAL',
      routeAliases: [],
      chunks: [],
      relationCandidates: [],
      warnings: [],
    }],
    relations: [],
    requirementSnapshot: snapshot,
  };
}

describe('ContextBuilder cancellation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.getActiveProviderConfig.mockReturnValue(providerConfig());
  });

  it('cancels a queued build and keeps its tombstone through quiescence', async () => {
    const builder = new ContextBuilder(new SSEGateway(), 1);
    const active = await builder.build('active-run', 'project-1', 'auto');
    const queued = builder.build('queued-run', 'project-1', 'auto');
    await Promise.resolve();

    builder.beginDeletion('queued-run');
    await expect(queued).rejects.toBeInstanceOf(RunCancelledError);
    await builder.waitForQuiescence('queued-run');
    expect(builder.isCancellationRequested('queued-run')).toBe(true);

    builder.finishDeletion('queued-run');
    expect(builder.isCancellationRequested('queued-run')).toBe(false);
    active.releaseSlot();
  });

  it('waits for an active context to release and includes AbortSignal in isAborted', async () => {
    const builder = new ContextBuilder(new SSEGateway(), 1);
    const context = await builder.build('active-run', 'project-1', 'auto');
    let quiescent = false;

    builder.beginDeletion('active-run');
    const waiting = builder.waitForQuiescence('active-run').then(() => {
      quiescent = true;
    });
    await Promise.resolve();

    expect(context.abortSignal.aborted).toBe(true);
    expect(context.isAborted()).toBe(true);
    expect(quiescent).toBe(false);
    context.releaseSlot();
    await waiting;
    expect(builder.isCancellationRequested('active-run')).toBe(true);
    builder.finishDeletion('active-run');
  });

  it('waits for external run operations and rejects new operations during deletion', async () => {
    const builder = new ContextBuilder(new SSEGateway(), 1);
    const releaseOperation = builder.registerExternalOperation('checkpoint-run');
    let quiescent = false;

    builder.beginDeletion('checkpoint-run');
    const waiting = builder.waitForQuiescence('checkpoint-run').then(() => {
      quiescent = true;
    });
    await Promise.resolve();

    expect(quiescent).toBe(false);
    expect(() => builder.registerExternalOperation('checkpoint-run'))
      .toThrow(ConflictError);

    releaseOperation();
    await waiting;
    expect(quiescent).toBe(true);
    builder.finishDeletion('checkpoint-run');
  });

  it('rejects configured missing HTML knowledge as recoverable before provider use and releases its slot', async () => {
    const htmlRepository = {
      loadBoundSetByRun: vi.fn(() => undefined),
      verifyBoundReference: vi.fn(),
    };
    const registry = new RunCacheRegistry();
    const builder = new ContextBuilder(
      new SSEGateway(),
      1,
      htmlRepository as any,
      registry,
    );

    const error = await builder.build('html-run', 'project-1', 'auto', {
      htmlKnowledgeSetId: 'missing-set',
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(HtmlKnowledgeRuntimeError);
    expect(error).toMatchObject({
      code: 'HTML_KNOWLEDGE_UNAVAILABLE',
      recoverable: true,
    });
    expect(mockProviderStream).not.toHaveBeenCalled();
    expect(registry.has('html-run')).toBe(false);

    const next = await builder.build('next-run', 'project-1', 'auto');
    next.releaseSlot();
  });

  it('resolves an exact bound runtime and disposes its run-scoped cache on release', async () => {
    const bound = boundHtmlKnowledgeData();
    const htmlRepository = {
      loadBoundSetByRun: vi.fn(() => bound),
      verifyBoundReference: vi.fn(),
    };
    const registry = new RunCacheRegistry();
    const builder = new ContextBuilder(
      new SSEGateway(),
      1,
      htmlRepository,
      registry,
    );

    const context = await builder.build('html-run', 'project-1', 'auto', {
      htmlKnowledgeSetId: 'set-1',
    });
    const disposeCache = vi.spyOn(context.htmlKnowledge!.cache, 'dispose');

    expect(context.htmlKnowledge).toMatchObject({
      projectId: 'project-1',
      reference: {
        knowledgeSetId: 'set-1',
        pageCount: 1,
        totalBytes: 128,
        pageTitles: ['Login'],
        requirementSnapshotHash: bound.set.requirement_snapshot_hash,
      },
      snapshot: bound.requirementSnapshot,
    });
    expect(htmlRepository.loadBoundSetByRun)
      .toHaveBeenCalledWith('project-1', 'html-run', 'set-1');
    expect(htmlRepository.verifyBoundReference).toHaveBeenCalledWith(
      'html-run',
      'project-1',
      context.htmlKnowledge!.reference,
    );
    expect(registry.has('html-run')).toBe(true);

    context.releaseSlot();

    expect(disposeCache).toHaveBeenCalledOnce();
    expect(registry.has('html-run')).toBe(false);
  });

  it('rejects recursively corrupt bound data and releases the semaphore before provider use', async () => {
    const corrupt = boundHtmlKnowledgeData();
    (corrupt.pages[0].chunks as any[]).push({
      id: 'chunk-1',
      pageId: 'unknown-page',
      sectionType: 'content',
      domPath: 'body',
      staticText: 'corrupt',
      elements: [],
      searchTerms: [],
    });
    const htmlRepository = {
      loadBoundSetByRun: vi.fn(() => corrupt),
      verifyBoundReference: vi.fn(),
    };
    const registry = new RunCacheRegistry();
    const builder = new ContextBuilder(
      new SSEGateway(),
      1,
      htmlRepository,
      registry,
    );

    await expect(builder.build('html-run', 'project-1', 'auto', {
      htmlKnowledgeSetId: 'set-1',
    })).rejects.toMatchObject({
      name: 'HtmlKnowledgeRuntimeError',
      code: 'HTML_KNOWLEDGE_UNAVAILABLE',
      recoverable: true,
    });
    expect(htmlRepository.verifyBoundReference).not.toHaveBeenCalled();
    expect(mockProviderStream).not.toHaveBeenCalled();
    expect(registry.has('html-run')).toBe(false);

    const next = await builder.build('next-run', 'project-1', 'auto');
    next.releaseSlot();
  });

  it('disposes a resolved runtime and releases its slot when later provider setup fails', async () => {
    const htmlRepository = {
      loadBoundSetByRun: vi.fn(() => boundHtmlKnowledgeData()),
      verifyBoundReference: vi.fn(),
    };
    const registry = new RunCacheRegistry();
    const builder = new ContextBuilder(
      new SSEGateway(),
      1,
      htmlRepository,
      registry,
    );
    mockRepo.getActiveProviderConfig
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(providerConfig());

    await expect(builder.build('html-run', 'project-1', 'auto', {
      htmlKnowledgeSetId: 'set-1',
    })).rejects.toThrow(/provider configuration/i);
    expect(registry.has('html-run')).toBe(false);

    const next = await builder.build('next-run', 'project-1', 'auto');
    next.releaseSlot();
  });
});

describe('RunScope retry persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.getAgentLogs.mockReturnValue([]);
  });

  it('persists projected calls before agent failure and appends retry calls deterministically', () => {
    const scope = new RunScope('run-tools', 'project-1', 'auto', vi.fn());
    scope.setBatch(1, 1);
    const firstCall = {
      name: 'html_knowledge_query',
      input: { requirementIds: ['story-1'], focus: 'all', maxResults: 5 },
      output: {
        resultChars: 321,
        confidence: [{ requestedRequirementId: 'story-1', confidence: 'high' }],
        pageIds: ['page-1'],
        chunkIds: ['chunk-1'],
        omittedRequirementIds: [],
        truncated: false,
        cacheHit: false,
      },
      latencyMs: 12,
    };
    const retryCall = {
      name: 'requirement_detail_query',
      input: { requirementId: 'story-1' },
      output: { id: 'story-1' },
      latencyMs: 3,
    };

    scope.recordAgentStart('test_analyst');
    scope.recordAgentToolCall('test_analyst', firstCall);
    scope.recordAgentError('test_analyst', new Error('agent extraction failed'));

    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'FAILED',
      toolHistory: [firstCall],
    });
    expect(JSON.stringify(mockRepo.saveAgentLog.mock.calls)).not.toContain('FULL_EVIDENCE_MARKER');

    scope.recordAgentStart('test_analyst');
    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'RUNNING',
      outputData: null,
      rawTrace: [],
      toolHistory: [firstCall],
    });
    scope.recordAgentToolCall('test_analyst', retryCall);
    scope.recordAgentComplete('test_analyst', {
      tokenUsage: { input: 1, output: 1, reasoning: 0 },
      latencyMs: 20,
      outputData: { testConditions: [] },
    });

    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'COMPLETED',
      toolHistory: [firstCall, retryCall],
    });
    scope.dispose();
  });

  it('does not carry completed output into a failed retry attempt', () => {
    const firstCall = {
      name: 'html_knowledge_query',
      input: { requirementIds: ['story-1'] },
      output: { resultChars: 100, pageIds: ['page-1'] },
      latencyMs: 7,
    };
    const retryCall = {
      name: 'flow_detail_query',
      input: { flowId: 'flow-1' },
      output: { id: 'flow-1' },
      latencyMs: 2,
    };
    const scope = new RunScope('run-tools', 'project-1', 'auto', vi.fn());
    scope.setBatch(1, 1);
    scope.recordAgentStart('test_designer');
    scope.recordAgentToolCall('test_designer', firstCall);
    scope.recordAgentComplete('test_designer', {
      tokenUsage: { input: 1, output: 1, reasoning: 0 },
      latencyMs: 10,
      outputData: { draftTestCases: [{ id: 'stale-success' }] },
    });

    scope.recordAgentStart('test_designer');
    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'RUNNING',
      outputData: null,
      rawTrace: [],
      toolHistory: [firstCall],
    });
    scope.recordAgentToolCall('test_designer', retryCall);
    scope.recordAgentError('test_designer', new Error('current failure'));

    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'FAILED',
      outputData: null,
      errorMessage: 'current failure',
      toolHistory: [firstCall, retryCall],
    });
    scope.dispose();
  });

  it('continues persisted projected history when a retry uses a rebuilt run scope', () => {
    const priorCall = {
      name: 'html_knowledge_query',
      input: { requirementIds: ['story-1'] },
      output: { resultChars: 100, pageIds: ['page-1'] },
      latencyMs: 7,
    };
    const retryCall = {
      name: 'flow_detail_query',
      input: { flowId: 'flow-1' },
      output: { id: 'flow-1' },
      latencyMs: 2,
    };
    mockRepo.getAgentLogs.mockReturnValue([{
      id: 'existing-log',
      batch: 2,
      tool_history: [priorCall],
    }]);
    const scope = new RunScope('run-tools', 'project-1', 'auto', vi.fn());
    scope.restoreBatchState(2);

    scope.recordAgentStart('test_designer');
    scope.recordAgentToolCall('test_designer', retryCall);

    expect(mockRepo.saveAgentLog.mock.calls.at(-1)?.[0]).toMatchObject({
      logId: 'existing-log',
      status: 'RUNNING',
      toolHistory: [priorCall, retryCall],
    });
    scope.dispose();
  });
});

describe('Orchestrator', () => {
  let sseGateway: SSEGateway;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    sseGateway = new SSEGateway();
    orchestrator = new Orchestrator(sseGateway);
  });

  it('emits pipeline:error when aborting a run', () => {
    const events: any[] = [];
    sseGateway.getEmitter('run-1').on('sse', (e, d) => events.push({ event: e, data: d }));

    orchestrator.abort('run-1');

    expect(mockRepo.markRunFailed).toHaveBeenCalledWith('run-1');
  });

  it('deletes a quiescent run', async () => {
    await orchestrator.delete('run-1');

    expect(mockRepo.deleteRun).toHaveBeenCalledWith('run-1');
  });

  it('waits for deferred work to release before eviction, deletion, and SSE cleanup', async () => {
    const order: string[] = [];
    mockRepo.getActiveProviderConfig.mockReturnValue(providerConfig());
    mockRepo.deleteRun.mockImplementationOnce(() => {
      order.push('delete-transaction');
    });
    const cleanup = vi.spyOn(sseGateway, 'cleanup').mockImplementationOnce(() => {
      order.push('sse-cleanup');
    });
    const registry = new RunCacheRegistry();
    registry.register('run-1', () => order.push('cache:run-1'));
    const contextBuilder = new ContextBuilder(sseGateway, 1);
    const context = await contextBuilder.build('run-1', 'project-1', 'auto');
    const withBarrier = new Orchestrator(sseGateway, registry, contextBuilder);
    const events: string[] = [];
    sseGateway.getEmitter('run-1').on('sse', (event) => events.push(event));

    const deleting = withBarrier.delete('run-1');
    await Promise.resolve();
    expect(mockRepo.deleteRun).not.toHaveBeenCalled();
    expect(context.isAborted()).toBe(true);

    context.releaseSlot();
    await deleting;

    expect(order).toEqual(['cache:run-1', 'delete-transaction', 'sse-cleanup']);
    expect(cleanup).toHaveBeenCalledWith('run-1');
    const writesAfterDelete = mockRepo.saveAgentLog.mock.calls.length;
    context.scope.recordAgentStart('test_analyst');
    context.sendEvent('batch:complete', { batch: 1 });
    expect(mockRepo.saveAgentLog).toHaveBeenCalledTimes(writesAfterDelete);
    expect(events).toEqual([]);
  });

  it('evicts production runtime caches through the shared registry', async () => {
    const evict = vi.fn();
    runCacheRegistry.register('runtime-run', evict);
    mockRepo.getRun.mockReturnValue({ id: 'runtime-run' });

    await testGenController.deleteRun('runtime-run');

    expect(evict).toHaveBeenCalledOnce();
    expect(runCacheRegistry.has('runtime-run')).toBe(false);
  });

  it('marks context setup failure as recoverable FAILED state', async () => {
    const events: Array<{ event: string; data: any }> = [];
    sseGateway.getEmitter('context-failure').on('sse', (event, data) => {
      events.push({ event, data });
    });
    mockRepo.getActiveProviderConfig.mockReturnValue(undefined);

    await orchestrator.start('context-failure', 'project-1', {
      requirementIds: ['story-1'],
      mode: 'auto',
    });

    expect(mockRepo.markRunFailed).toHaveBeenCalledWith('context-failure', {
      type: 'CONTEXT_SETUP_FAILED',
      phase: 'context',
      recoverable: true,
    });
    expect(events).toContainEqual({
      event: 'pipeline:error',
      data: expect.objectContaining({ phase: 'context', recoverable: true }),
    });
  });

  it.each(['resume', 'retry'] as const)(
    'marks a non-HTML no-provider %s context failure recoverable after setRunRunning',
    async (operation) => {
      const runId = `no-provider-${operation}`;
      const events: Array<{ event: string; data: any }> = [];
      sseGateway.getEmitter(runId).on('sse', (event, data) => {
        events.push({ event, data });
      });
      mockRepo.getActiveProviderConfig.mockReturnValue(undefined);
      if (operation === 'resume') {
        mockRepo.getRunWithThreadId.mockReturnValue({
          id: runId,
          project_id: 'project-1',
          status: 'WAITING_REVIEW',
          phase: 'review-conditions',
          thread_id: `${runId}-batch-1`,
          mode: 'auto',
          config: {},
          current_batch: 1,
          total_batches: 1,
        });
        await orchestrator.resume(runId, 'approve');
      } else {
        mockRepo.getRun.mockReturnValue({ id: runId, status: 'FAILED' });
        mockRepo.getFailedRun.mockReturnValue({
          id: runId,
          project_id: 'project-1',
          status: 'FAILED',
          phase: 'analysis',
          thread_id: null,
          mode: 'auto',
          config: JSON.stringify({ requirementIds: ['story-1'], mode: 'auto' }),
          current_batch: 0,
          total_batches: 0,
        });
        await orchestrator.retry(runId);
      }

      expect(mockRepo.setRunRunning).toHaveBeenCalledWith(runId);
      expect(mockRepo.markRunFailed).toHaveBeenCalledWith(runId, {
        type: 'CONTEXT_SETUP_FAILED',
        phase: 'context',
        recoverable: true,
      });
      expect(events).toContainEqual({
        event: 'pipeline:error',
        data: expect.objectContaining({ phase: 'context', recoverable: true }),
      });
    },
  );

  it.each(['resume', 'retry'] as const)(
    'does not complete a run aborted while %s returns a batch result',
    async (operation) => {
      const runId = `aborted-${operation}`;
      let aborted = false;
      const scope = {
        currentBatch: 1,
        restoreBatchState: vi.fn(),
        markComplete: vi.fn(),
        markFailed: vi.fn(),
      };
      const completeResult = {
        type: 'complete' as const,
        result: {
          batchIndex: 0,
          cases: [],
          tokenUsage: { input: 0, output: 0, total: 0 },
          lastState: { testConditions: [], finalTestCases: [] },
        },
      };
      const context = {
        scope,
        session: {
          resumeAt: vi.fn(async () => {
            aborted = true;
            return completeResult;
          }),
          retryFromLastCheckpoint: vi.fn(async () => {
            aborted = true;
            return completeResult;
          }),
        },
        isAborted: () => aborted,
        releaseSlot: vi.fn(),
      };
      const contextBuilder = {
        build: vi.fn(async () => context),
      } as unknown as ContextBuilder;
      const aborting = new Orchestrator(
        sseGateway,
        new RunCacheRegistry(),
        contextBuilder,
      );
      if (operation === 'resume') {
        mockRepo.getRunWithThreadId.mockReturnValue({
          id: runId,
          project_id: 'project-1',
          status: 'WAITING_REVIEW',
          phase: 'review-conditions',
          thread_id: `${runId}-batch-1`,
          mode: 'auto',
          config: {},
          current_batch: 1,
          total_batches: 1,
        });
        await aborting.resume(runId, 'approve');
      } else {
        mockRepo.getRun.mockReturnValue({ id: runId, status: 'FAILED' });
        mockRepo.getFailedRun.mockReturnValue({
          id: runId,
          project_id: 'project-1',
          status: 'FAILED',
          phase: 'quality',
          thread_id: `${runId}-batch-1`,
          mode: 'auto',
          config: JSON.stringify({ requirementIds: ['story-1'], mode: 'auto' }),
          current_batch: 1,
          total_batches: 1,
        });
        await aborting.retry(runId);
      }

      expect(scope.markComplete).not.toHaveBeenCalled();
      expect(mockRepo.markRunCompleted).not.toHaveBeenCalled();
    },
  );

  it('releases the deletion barrier when cache eviction throws', async () => {
    const cacheError = new Error('cache eviction failed');
    const registry = new RunCacheRegistry();
    registry.register('cache-failure', () => {
      throw cacheError;
    });
    const contextBuilder = {
      beginDeletion: vi.fn(() => true),
      waitForQuiescence: vi.fn(async () => undefined),
      finishDeletion: vi.fn(),
    } as unknown as ContextBuilder;
    const withThrowingCache = new Orchestrator(sseGateway, registry, contextBuilder);

    const deletionError = await withThrowingCache.delete('cache-failure').catch((error) => error);

    expect(deletionError).toBeInstanceOf(AggregateError);
    expect((deletionError as AggregateError).errors).toEqual([cacheError]);
    expect(contextBuilder.finishDeletion).toHaveBeenCalledWith('cache-failure');
    expect(mockRepo.deleteRun).not.toHaveBeenCalled();
  });

  it.each(['repository', 'sse'] as const)(
    'releases the deletion barrier when %s failure recovery throws',
    (throwingDependency) => {
      const recoveryError = new Error(`${throwingDependency} recovery failed`);
      const contextBuilder = {
        finishDeletion: vi.fn(),
      } as unknown as ContextBuilder;
      const lifecycleRepository = {
        ...mockRepo,
        markRunFailed: throwingDependency === 'repository'
          ? vi.fn(() => { throw recoveryError; })
          : vi.fn(),
      };
      if (throwingDependency === 'sse') {
        vi.spyOn(sseGateway, 'emit').mockImplementationOnce(() => {
          throw recoveryError;
        });
      }
      const recovering = new Orchestrator(
        sseGateway,
        new RunCacheRegistry(),
        contextBuilder,
        lifecycleRepository,
      );

      expect(() => recovering.failDeletion('recovery-failure', 'bounded reason', true))
        .toThrow(recoveryError);
      expect(contextBuilder.finishDeletion).toHaveBeenCalledWith('recovery-failure');
    },
  );

  it.each([
    ['preserved deletion-rollback coverage', JSON.stringify([['story-old', {
      requirementId: 'story-old',
      conditionCount: 1,
      categories: ['functional'],
      techniques: ['EP'],
      caseCountByLevel: { component: 0, integration: 0 },
    }]])],
    ['legacy non-array', JSON.stringify({ type: 'DELETION_FAILED' })],
    ['corrupt JSON', '{not-json'],
  ])('reconstructs multi-batch retry coverage from logs for %s state', async (
    _label,
    storedState,
  ) => {
    const oldCondition = {
      id: 'condition-old',
      condition: 'Previously covered condition',
      requirementId: 'story-old',
      category: 'functional',
      primaryTechnique: 'EP',
    };
    const retriedCondition = {
      id: 'condition-new',
      condition: 'Retried condition',
      requirementId: 'story-new',
      category: 'functional',
      primaryTechnique: 'BVA',
    };
    mockRepo.getRun.mockReturnValue({ id: 'retry-coverage', status: 'FAILED' });
    mockRepo.getFailedRun.mockReturnValue({
      id: 'retry-coverage',
      project_id: 'project-1',
      status: 'FAILED',
      phase: 'quality',
      thread_id: 'thread-1',
      mode: 'auto',
      config: JSON.stringify({ requirementIds: ['story-old', 'story-new'] }),
      current_batch: 2,
      total_batches: 2,
    });
    mockRepo.getRunState.mockReturnValue(storedState);
    (mockRepo.getAgentLogs as any).mockImplementation((_runId: string, agent?: string) =>
      agent === 'test_analyst'
        ? [{ batch: 1, status: 'COMPLETED', output_data: { testConditions: [oldCondition] } }]
        : []
    );
    const scope = {
      restoreBatchState: vi.fn(),
      markComplete: vi.fn(),
      markFailed: vi.fn(),
    };
    const context = {
      scope,
      session: {
        retryFromLastCheckpoint: vi.fn(async () => ({
          type: 'complete',
          result: {
            cases: [],
            lastState: { testConditions: [retriedCondition], finalTestCases: [] },
          },
        })),
      },
      isAborted: () => false,
      releaseSlot: vi.fn(),
    };
    const contextBuilder = {
      build: vi.fn(async () => context),
    } as unknown as ContextBuilder;
    const retrying = new Orchestrator(sseGateway, new RunCacheRegistry(), contextBuilder);

    await retrying.retry('retry-coverage');

    const serialized = mockRepo.updateRunState.mock.calls.at(-1)?.[1] as string;
    const coverage = new Map(JSON.parse(serialized).summary);
    expect(coverage.get('story-old')).toMatchObject({ conditionCount: 1 });
    expect(coverage.get('story-new')).toMatchObject({ conditionCount: 1 });
  });

  it('rebuilds retry coverage from completed prior batches and merges the retried batch once', async () => {
    const condition = (id: string, requirementId: string) => ({
      id,
      condition: id,
      requirementId,
      category: 'functional',
      primaryTechnique: 'EP',
    });
    const testCase = (title: string, requirementId: string) => ({
      title,
      requirementId,
      testLevel: 'component',
    });
    mockRepo.getRun.mockReturnValue({ id: 'retry-filtered', status: 'FAILED' });
    mockRepo.getFailedRun.mockReturnValue({
      id: 'retry-filtered',
      project_id: 'project-1',
      status: 'FAILED',
      phase: 'quality',
      thread_id: 'thread-filtered',
      mode: 'auto',
      config: JSON.stringify({ requirementIds: ['story-prior', 'story-current'] }),
      current_batch: 2,
      total_batches: 2,
    });
    mockRepo.getRunState.mockReturnValue(null);
    (mockRepo.getAgentLogs as any).mockImplementation((_runId: string, agent?: string) => {
      if (agent === 'test_analyst') {
        return [
          { batch: 1, status: 'COMPLETED', output_data: { testConditions: [condition('prior', 'story-prior')] } },
          { batch: 1, status: 'FAILED', output_data: { testConditions: [condition('failed', 'story-failed')] } },
          { batch: 2, status: 'COMPLETED', output_data: { testConditions: [condition('stale-current', 'story-current')] } },
          { batch: 3, status: 'COMPLETED', output_data: { testConditions: [condition('future', 'story-future')] } },
        ];
      }
      if (agent === 'quality_manager') {
        return [
          { batch: 1, status: 'COMPLETED', output_data: { finalTestCases: [testCase('prior', 'story-prior')] } },
          { batch: 2, status: 'COMPLETED', output_data: { finalTestCases: [testCase('stale-current', 'story-current')] } },
        ];
      }
      return [];
    });
    const scope = {
      restoreBatchState: vi.fn(),
      markComplete: vi.fn(),
      markFailed: vi.fn(),
    };
    const context = {
      scope,
      session: {
        retryFromLastCheckpoint: vi.fn(async () => ({
          type: 'complete',
          result: {
            cases: [],
            lastState: {
              testConditions: [condition('retried', 'story-current')],
              finalTestCases: [testCase('retried', 'story-current')],
            },
          },
        })),
      },
      isAborted: () => false,
      releaseSlot: vi.fn(),
    };
    const contextBuilder = {
      build: vi.fn(async () => context),
    } as unknown as ContextBuilder;
    const retrying = new Orchestrator(sseGateway, new RunCacheRegistry(), contextBuilder);

    await retrying.retry('retry-filtered');

    const serialized = mockRepo.updateRunState.mock.calls.at(-1)?.[1] as string;
    const coverage = new Map<string, any>(JSON.parse(serialized).summary);
    expect(coverage.get('story-prior')).toMatchObject({
      conditionCount: 1,
      caseCountByLevel: { component: 1, integration: 0 },
    });
    expect(coverage.get('story-current')).toMatchObject({
      conditionCount: 1,
      caseCountByLevel: { component: 1, integration: 0 },
    });
    expect(coverage.has('story-failed')).toBe(false);
    expect(coverage.has('story-future')).toBe(false);
  });

  it('returns typed errors for missing runs and invalid resume/retry states', async () => {
    mockRepo.getRunWithThreadId.mockReturnValueOnce(undefined);
    expect(() => orchestrator.assertCanResume('missing')).toThrow(NotFoundError);

    mockRepo.getRunWithThreadId.mockReturnValueOnce(undefined);
    const missingResume = await orchestrator.resume('missing', 'approve').catch((error) => error);
    expect(missingResume).toBeInstanceOf(NotFoundError);
    expect(missingResume).toMatchObject({ statusCode: 404, message: 'Test gen run not found' });

    mockRepo.getRunWithThreadId.mockReturnValueOnce({ status: 'RUNNING' });
    const invalidResume = await orchestrator.resume('run-1', 'approve').catch((error) => error);
    expect(invalidResume).toBeInstanceOf(ConflictError);
    expect(invalidResume).toMatchObject({
      statusCode: 409,
      message: 'Test gen is not waiting for review',
    });

    mockRepo.getRun.mockReturnValueOnce(undefined);
    const missingRetry = await orchestrator.retry('missing').catch((error) => error);
    expect(missingRetry).toBeInstanceOf(NotFoundError);
    expect(missingRetry).toMatchObject({ statusCode: 404, message: 'Test gen run not found' });

    mockRepo.getRun.mockReturnValueOnce({ id: 'run-1', status: 'RUNNING' });
    mockRepo.getFailedRun.mockReturnValueOnce(undefined);
    const invalidRetry = await orchestrator.retry('run-1').catch((error) => error);
    expect(invalidRetry).toBeInstanceOf(ConflictError);
    expect(invalidRetry).toMatchObject({
      statusCode: 409,
      message: 'Test gen run is not in FAILED status',
    });

    mockRepo.getRun.mockReturnValueOnce({ id: 'run-2', status: 'FAILED' });
    mockRepo.getFailedRun.mockReturnValueOnce({
      id: 'run-2',
      project_id: 'project-1',
      status: 'FAILED',
      thread_id: null,
      mode: 'auto',
      config: JSON.stringify({
        requirementIds: ['story-1'],
        providerConfigName: 'provider-1',
        htmlKnowledgeSetId: 'set-1',
      }),
    });
    const restart = vi.spyOn(orchestrator, 'start').mockResolvedValueOnce(undefined);
    await orchestrator.retry('run-2');
    expect(mockRepo.setRunRunning).toHaveBeenCalledWith('run-2');
    expect(restart).not.toHaveBeenCalled();
    expect(mockRepo.markRunFailed).toHaveBeenCalledWith('run-2', {
      type: 'HTML_KNOWLEDGE_UNAVAILABLE',
      phase: 'html-knowledge',
      recoverable: true,
    });
  });

  it('returns typed errors for missing runs and invalid checkpoint state', async () => {
    mockRepo.getRunWithThreadId.mockReturnValueOnce(undefined);
    const missingRun = await orchestrator.saveCheckpointEdits('missing', {}, 1)
      .catch((error) => error);
    expect(missingRun).toBeInstanceOf(NotFoundError);
    expect(missingRun).toMatchObject({ statusCode: 404, message: 'Test gen run not found' });

    mockRepo.getRunWithThreadId.mockReturnValueOnce({
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: null,
    });
    const missingThread = await orchestrator.saveCheckpointEdits('run-1', {}, 1)
      .catch((error) => error);
    expect(missingThread).toBeInstanceOf(ConflictError);
    expect(missingThread).toMatchObject({
      statusCode: 409,
      message: 'Test gen run has no checkpoint thread',
    });
  });

  it.each(['RUNNING', 'COMPLETED'])(
    'rejects checkpoint edits while a run is %s',
    async (status) => {
      mockRepo.getRunWithThreadId.mockReturnValue({
        id: 'run-1',
        project_id: 'project-1',
        status,
        phase: status === 'RUNNING' ? 'analysis' : 'complete',
        thread_id: 'run-1-batch-1',
      });

      await expect(orchestrator.saveCheckpointEdits('run-1', { conditions: [] }, 1))
        .rejects.toMatchObject({
          name: 'ConflictError',
          statusCode: 409,
        });
    },
  );

  it('rejects a checkpoint number that does not match the current review phase', async () => {
    mockRepo.getRunWithThreadId.mockReturnValue({
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-draft',
      thread_id: 'run-1-batch-1',
    });

    await expect(orchestrator.saveCheckpointEdits('run-1', { conditions: [] }, 1))
      .rejects.toMatchObject({
        name: 'ValidationError',
        statusCode: 400,
      });
  });

  it('rejects checkpoint edits while the owning project is deleting', async () => {
    const deletionLock = new ProjectDeletionLock();
    const releaseLock = deletionLock.acquire('project-1');
    const guarded = new Orchestrator(
      sseGateway,
      new RunCacheRegistry(),
      undefined,
      mockRepo,
      deletionLock,
    );
    mockRepo.getRunWithThreadId.mockReturnValue({
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: 'run-1-batch-1',
    });

    await expect(guarded.saveCheckpointEdits('run-1', { conditions: [] }, 1))
      .rejects.toMatchObject({
        name: 'ConflictError',
        statusCode: 409,
      });
    releaseLock();
  });

  it('revalidates checkpoint status after acquiring the external-operation guard', async () => {
    const waitingRun = {
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: 'run-1-batch-1',
    };
    mockRepo.getRunWithThreadId
      .mockReturnValueOnce(waitingRun)
      .mockReturnValueOnce({ ...waitingRun, status: 'RUNNING', phase: 'analysis' });
    const updateState = vi.fn();
    const graphModule = await import('../graph/graph.ts');
    const graphSpy = vi.spyOn(graphModule, 'buildTestGenGraph').mockReturnValue({
      updateState,
    } as any);

    try {
      await expect(orchestrator.saveCheckpointEdits('run-1', { conditions: [] }, 1))
        .rejects.toMatchObject({
          name: 'ConflictError',
          statusCode: 409,
        });
      expect(updateState).not.toHaveBeenCalled();
    } finally {
      graphSpy.mockRestore();
    }
  });

  it('makes run deletion wait for a checkpoint update and rejects later writes', async () => {
    const waitingRun = {
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: 'run-1-batch-1',
    };
    mockRepo.getRunWithThreadId.mockReturnValue(waitingRun);
    const updateStarted = deferred<void>();
    const allowUpdate = deferred<void>();
    const updateState = vi.fn()
      .mockImplementationOnce(async () => {
        updateStarted.resolve(undefined);
        await allowUpdate.promise;
      })
      .mockResolvedValue(undefined);
    const graphModule = await import('../graph/graph.ts');
    const graphSpy = vi.spyOn(graphModule, 'buildTestGenGraph').mockReturnValue({
      updateState,
      getState: vi.fn(async () => ({ values: { testConditions: [] } })),
    } as any);
    const saving = orchestrator.saveCheckpointEdits('run-1', { conditions: [] }, 1);
    let deleting: Promise<void> | undefined;

    try {
      await updateStarted.promise;
      deleting = orchestrator.delete('run-1');
      await Promise.resolve();

      expect(mockRepo.deleteRun).not.toHaveBeenCalled();
      await expect(orchestrator.saveCheckpointEdits('run-1', { conditions: [] }, 1))
        .rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });
      expect(updateState).toHaveBeenCalledOnce();

      allowUpdate.resolve(undefined);
      await saving;
      await deleting;
      expect(mockRepo.deleteRun).toHaveBeenCalledWith('run-1');
    } finally {
      allowUpdate.resolve(undefined);
      await Promise.allSettled([saving, ...(deleting ? [deleting] : [])]);
      graphSpy.mockRestore();
    }
  });

  it('makes project deletion wait for a checkpoint update without recreating rows', async () => {
    const deletionLock = new ProjectDeletionLock();
    const contextBuilder = new ContextBuilder(sseGateway);
    let deleted = false;
    let checkpointRows = 0;
    const waitingRun = {
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: 'run-1-batch-1',
    };
    mockRepo.getRunWithThreadId.mockImplementation(() => deleted ? undefined : waitingRun);
    const guarded = new Orchestrator(
      sseGateway,
      new RunCacheRegistry(),
      contextBuilder,
      mockRepo,
      deletionLock,
    );
    const updateStarted = deferred<void>();
    const allowUpdate = deferred<void>();
    const updateState = vi.fn(async () => {
      updateStarted.resolve(undefined);
      await allowUpdate.promise;
      checkpointRows += 1;
    });
    const graphModule = await import('../graph/graph.ts');
    const graphSpy = vi.spyOn(graphModule, 'buildTestGenGraph').mockReturnValue({
      updateState,
      getState: vi.fn(async () => ({ values: { testConditions: [] } })),
    } as any);
    const runRepository = {
      listRunIdsByProject: vi.fn(() => deleted ? [] : ['run-1']),
      deleteProjectData: vi.fn(() => {
        deleted = true;
        checkpointRows = 0;
        return ['run-1'];
      }),
    };
    const saving = guarded.saveCheckpointEdits('run-1', { conditions: [] }, 1);
    let deleting: Promise<void> | undefined;

    try {
      await updateStarted.promise;
      deleting = deleteProjectTestGenData('project-1', {
        runRepository,
        orchestrator: guarded,
        deletionLock,
      });
      await Promise.resolve();

      expect(runRepository.deleteProjectData).not.toHaveBeenCalled();
      await expect(guarded.saveCheckpointEdits('run-1', { conditions: [] }, 1))
        .rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });
      expect(updateState).toHaveBeenCalledOnce();

      allowUpdate.resolve(undefined);
      await saving;
      await deleting;
      expect(checkpointRows).toBe(0);
      await expect(guarded.saveCheckpointEdits('run-1', { conditions: [] }, 1))
        .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
      expect(updateState).toHaveBeenCalledOnce();
    } finally {
      allowUpdate.resolve(undefined);
      await Promise.allSettled([saving, ...(deleting ? [deleting] : [])]);
      graphSpy.mockRestore();
    }
  });
});

describe('TestGenController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an actionable 404 error when deleting a missing run', async () => {
    mockRepo.getRun.mockReturnValue(undefined);
    const controller = new TestGenController();

    await expect(controller.deleteRun('missing-run')).rejects.toMatchObject({
      name: 'NotFoundError',
      statusCode: 404,
      message: 'Test gen run not found',
    });
    expect(mockRepo.deleteRun).not.toHaveBeenCalled();
  });

  it('returns typed errors for missing runs and empty exports', () => {
    const controller = new TestGenController();
    mockRepo.getRun.mockReturnValueOnce(undefined);

    let missingRun: unknown;
    try {
      controller.saveCases('missing-run');
    } catch (error) {
      missingRun = error;
    }
    expect(missingRun).toBeInstanceOf(NotFoundError);
    expect(missingRun).toMatchObject({ statusCode: 404, message: 'Run not found' });

    mockRepo.getRun.mockReturnValueOnce({ project_id: 'project-1' });
    mockRepo.getAgentLogs.mockReturnValueOnce([]);
    let emptyExport: unknown;
    try {
      controller.saveCases('run-1');
    } catch (error) {
      emptyExport = error;
    }
    expect(emptyExport).toBeInstanceOf(ConflictError);
    expect(emptyExport).toMatchObject({
      statusCode: 409,
      message: 'No test cases found to export',
    });
  });

  it('maps Zod request failures to actionable 400 errors', async () => {
    const controller = new TestGenController();
    const invalidRequests: Array<{
      field: string;
      invoke: () => unknown | Promise<unknown>;
    }> = [
      {
        field: 'requirementIds',
        invoke: () => controller.startPipeline('project-1', {}),
      },
      {
        field: 'action',
        invoke: () => controller.resumeRun('run-1', {}),
      },
      {
        field: 'editedData',
        invoke: () => controller.saveCheckpointEdits('run-1', {}),
      },
      {
        field: 'checkpointNumber',
        invoke: () => controller.saveCheckpointEdits('run-1', {
          editedData: {},
          checkpointNumber: 1.5,
        }),
      },
    ];

    for (const invalidRequest of invalidRequests) {
      const error = await Promise.resolve()
        .then(invalidRequest.invoke)
        .then(() => undefined, (caught) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ statusCode: 400 });
      expect((error as Error).message).toContain(invalidRequest.field);
    }
  });

  it('throws synchronous resume preflight errors before dispatch', () => {
    const controller = new TestGenController();
    const expectedError = new ConflictError('Test gen is not waiting for review');
    const preflight = vi.spyOn(controller.orchestrator, 'assertCanResume')
      .mockImplementation(() => {
        throw expectedError;
      });
    const resume = vi.spyOn(controller.orchestrator, 'resume');

    let thrown: unknown;
    try {
      controller.resumeRun('run-1', { action: 'approve' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(expectedError);
    expect(preflight).toHaveBeenCalledWith('run-1');
    expect(resume).not.toHaveBeenCalled();
  });

  it('rejects resume and retry synchronously while project deletion is locked', async () => {
    const deletionLock = new ProjectDeletionLock();
    const release = deletionLock.acquire('project-locked');
    const controller = new TestGenController(deletionLock);
    mockRepo.getRunWithThreadId.mockReturnValue({
      id: 'waiting-run',
      project_id: 'project-locked',
      status: 'WAITING_REVIEW',
      thread_id: 'thread-1',
    });
    mockRepo.getRun.mockReturnValue({
      id: 'failed-run',
      project_id: 'project-locked',
      status: 'FAILED',
    });
    mockRepo.getFailedRun.mockReturnValue({
      id: 'failed-run',
      project_id: 'project-locked',
      status: 'FAILED',
      thread_id: null,
      config: '{}',
      mode: 'auto',
    });
    const resume = vi.spyOn(controller.orchestrator, 'resume');
    const retry = vi.spyOn(controller.orchestrator, 'retry');

    expect(() => controller.resumeRun('waiting-run', { action: 'approve' }))
      .toThrow(ConflictError);
    let retryError: unknown;
    let retryResult: unknown;
    try {
      retryResult = controller.retryRun('failed-run');
    } catch (error) {
      retryError = error;
    }
    if (retryResult instanceof Promise) await retryResult.catch(() => undefined);

    expect(retryError).toBeInstanceOf(ConflictError);
    expect(resume).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(mockRepo.setRunRunning).not.toHaveBeenCalled();
    release();
  });

  it('acknowledges resume immediately and logs deferred background failures', async () => {
    const controller = new TestGenController();
    const resumeWork = deferred<void>();
    vi.spyOn(controller.orchestrator, 'assertCanResume').mockImplementation(() => undefined);
    vi.spyOn(controller.orchestrator, 'resume').mockReturnValue(resumeWork.promise);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = controller.resumeRun('run-1', {
      action: 'approve',
      feedback: 'Proceed',
    });

    expect(response).toEqual({ success: true, action: 'approve' });
    expect(response).not.toBeInstanceOf(Promise);
    expect(controller.orchestrator.assertCanResume).toHaveBeenCalledWith('run-1');
    expect(controller.orchestrator.resume).toHaveBeenCalledWith(
      'run-1',
      'approve',
      'Proceed',
      undefined,
    );

    resumeWork.reject(new Error('deferred resume failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('deferred resume failed'),
    );
  });

  it('starts orchestration only for a newly bound HTML knowledge run', async () => {
    const controller = new TestGenController();
    const bind = vi.spyOn(HtmlKnowledgeService.prototype, 'createOrReuseRun');
    const start = vi.spyOn(controller.orchestrator, 'start').mockResolvedValue(undefined);
    const request = {
      requirementIds: ['story-1'],
      providerConfigName: 'provider-1',
      mode: 'auto',
      htmlKnowledgeSetId: 'set-1',
    };
    bind.mockReturnValueOnce({ runId: 'winner-run', created: false });

    await expect(controller.startPipeline('project-1', request)).resolves.toEqual({
      runId: 'winner-run',
      created: false,
    });
    expect(start).not.toHaveBeenCalled();

    bind.mockReturnValueOnce({ runId: 'new-run', created: true });
    await expect(controller.startPipeline('project-1', request)).resolves.toEqual({
      runId: 'new-run',
      created: true,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      'new-run',
      'project-1',
      expect.objectContaining({ htmlKnowledgeSetId: 'set-1' }),
    );
  });

  it('preserves asynchronous start behavior when no HTML set is supplied', async () => {
    const controller = new TestGenController();
    const startWork = deferred<void>();
    vi.spyOn(controller.orchestrator, 'start').mockReturnValue(startWork.promise);

    const response = await controller.startPipeline('project-1', {
      requirementIds: ['story-1'],
      providerConfigName: 'provider-1',
      mode: 'auto',
    });

    expect(response).toMatchObject({ created: true, runId: expect.stringMatching(/^tgr/u) });
    expect(mockRepo.createRun).toHaveBeenCalledOnce();
    expect(controller.orchestrator.start).toHaveBeenCalledOnce();
    startWork.resolve();
  });

  it('rejects a start before creating a run while project deletion is locked', async () => {
    const deletionLock = new ProjectDeletionLock();
    const release = deletionLock.acquire('project-1');
    const controller = new TestGenController(deletionLock);

    await expect(controller.startPipeline('project-1', {
      requirementIds: ['story-1'],
      providerConfigName: 'provider-1',
      mode: 'auto',
    })).rejects.toBeInstanceOf(ConflictError);
    expect(mockRepo.createRun).not.toHaveBeenCalled();

    release();
  });

  it('uses 201 for a new start and 200 when an HTML-bound run is reused', async () => {
    const startPipeline = vi.fn()
      .mockResolvedValueOnce({ runId: 'new-run', created: true })
      .mockResolvedValueOnce({ runId: 'winner-run', created: false });
    const handler = createStartPipelineHandler({ startPipeline });
    const response = {
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    const request = { params: { projectId: 'project-1' }, body: {} };

    await handler(request as any, response as any);
    expect(response.status).toHaveBeenLastCalledWith(201);
    expect(response.json).toHaveBeenLastCalledWith({ runId: 'new-run', created: true });

    await handler(request as any, response as any);
    expect(response.status).toHaveBeenLastCalledWith(200);
    expect(response.json).toHaveBeenLastCalledWith({ runId: 'winner-run', created: false });
  });

  it('returns success after deletion and a typed 404 on the next delete', async () => {
    const controller = new TestGenController();
    mockRepo.getRun
      .mockReturnValueOnce({ id: 'deleted-run', project_id: 'project-1' })
      .mockReturnValueOnce(undefined);
    vi.spyOn(controller.orchestrator, 'delete').mockResolvedValueOnce(undefined);

    await expect(controller.deleteRun('deleted-run')).resolves.toEqual({ success: true });
    await expect(controller.deleteRun('deleted-run')).rejects.toBeInstanceOf(NotFoundError);
  });
});
