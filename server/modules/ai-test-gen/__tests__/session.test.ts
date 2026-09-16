import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CheckpointCorruptError,
  CheckpointUnavailableError,
  EmptyGraphStreamError,
  HtmlKnowledgeReferenceMismatchError,
  TestGenSessionAbortedError,
  TestGenSession,
} from '../session.ts';
import { SSEGateway } from '../sse-gateway.ts';
import type { HtmlKnowledgeReference, HtmlRequirementSnapshot } from '../html-knowledge/types.ts';

function makeFakeGraph(streams: any[]) {
  return {
    async *stream() {
      for (const s of streams) yield s;
    },
  };
}

const htmlKnowledgeReference: HtmlKnowledgeReference = {
  knowledgeSetId: 'set-1',
  pageCount: 1,
  totalBytes: 100,
  pageTitles: ['Login'],
  hasLowInformationPages: false,
  requirementSnapshotHash: 'a'.repeat(64),
};

const htmlKnowledgeSnapshot: HtmlRequirementSnapshot = {
  version: 1,
  projectId: 'p',
  selectedRequirementIds: ['story-1'],
  selectedFlowIds: [],
  records: [],
};

function makeHtmlRuntime() {
  return {
    projectId: 'p',
    reference: htmlKnowledgeReference,
    snapshot: htmlKnowledgeSnapshot,
    repository: {
      verifyBoundReference: vi.fn(),
      loadBoundSetByRun: vi.fn(),
    },
    cache: {
      get: vi.fn(), set: vi.fn(), getRetrievalContext: vi.fn(), setRetrievalContext: vi.fn(),
      clear: vi.fn(), dispose: vi.fn(),
    },
    dispose: vi.fn(),
  } as any;
}

function batchInput(reference?: HtmlKnowledgeReference) {
  return {
    batchIndex: 0,
    inputState: {
      projectId: 'p',
      runId: 'r',
      mode: 'auto' as const,
      generationMode: 'component' as const,
      requirementIds: [],
      currentBatch: [],
      batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 },
      projectContext: { name: '', pages: [], endpoints: [] },
      businessFlowBlueprints: undefined,
      htmlKnowledgeReference: reference,
      selectedFlowIds: [],
phase: 'analysis' as const,
    },
  };
}

describe('TestGenSession', () => {
  let sseGateway: SSEGateway;
  let session: TestGenSession;

  beforeEach(() => {
    vi.clearAllMocks();
    sseGateway = new SSEGateway();
    session = new TestGenSession({
      runId: 'run-1',
      projectId: 'p',
      provider: { chat: vi.fn(), streamChat: vi.fn() } as any,
      observer: {
        onStart: vi.fn(),
        onStep: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      },
      modelName: 'test-model',
      tokenLimit: null,
      timeoutMs: 300_000,
      useCache: false,
      signal: undefined,
    });
  });

  describe('startBatch', () => {
    it('returns complete when graph runs without interrupt', async () => {
      const fakeGraph = makeFakeGraph([{ phase: 'complete', finalTestCases: [{ id: 'tc-1' }] }]);
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      const outcome = await session.startBatch({
        batchIndex: 0,
        inputState: { projectId: 'p', runId: 'r', mode: 'auto', generationMode: 'component', requirementIds: [], currentBatch: [], batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 }, projectContext: { name: '', pages: [], endpoints: [] }, businessFlowBlueprints: undefined, selectedFlowIds: [], phase: 'analysis' },
      });
      expect(outcome.type).toBe('complete');
      if (outcome.type === 'complete') {
        expect(outcome.result.cases).toHaveLength(1);
      }
    });

    it('detects interrupt and returns interrupt outcome', async () => {
      const fakeGraph = makeFakeGraph([{ __interrupt__: [{ value: { conditions: [{ id: 'c1' }], phase: 'review-conditions' } }] }]);
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      const outcome = await session.startBatch({
        batchIndex: 0,
        inputState: { projectId: 'p', runId: 'r', mode: 'interactive', generationMode: 'component', requirementIds: [], currentBatch: [], batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 }, projectContext: { name: '', pages: [], endpoints: [] }, businessFlowBlueprints: undefined, selectedFlowIds: [], phase: 'analysis' },
      });
      expect(outcome.type).toBe('interrupt');
    });

    it('throws a typed error when the graph emits no chunks', async () => {
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(makeFakeGraph([]) as any);

      await expect(session.startBatch({
        batchIndex: 0,
        inputState: { projectId: 'p', runId: 'run-1', mode: 'auto', generationMode: 'component', requirementIds: [], currentBatch: [], batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 }, projectContext: { name: '', pages: [], endpoints: [] }, businessFlowBlueprints: undefined, selectedFlowIds: [], phase: 'analysis' },
      })).rejects.toBeInstanceOf(EmptyGraphStreamError);
    });

    it('throws a typed abort instead of returning a partial completion', async () => {
      const fakeGraph = {
        async *stream() {
          session.abort();
          yield { phase: 'quality', finalTestCases: [{ id: 'partial' }] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(fakeGraph as any);

      await expect(session.startBatch({
        batchIndex: 0,
        inputState: { projectId: 'p', runId: 'run-1', mode: 'auto', generationMode: 'component', requirementIds: [], currentBatch: [], batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 }, projectContext: { name: '', pages: [], endpoints: [] }, businessFlowBlueprints: undefined, selectedFlowIds: [], phase: 'analysis' },
      })).rejects.toBeInstanceOf(TestGenSessionAbortedError);
    });

    it('normalizes an abort raised while opening the graph stream', async () => {
      const controller = new AbortController();
      const abortingSession = new TestGenSession({
        runId: 'run-1',
        projectId: 'p',
        provider: { chat: vi.fn(), streamChat: vi.fn() } as any,
        observer: {},
        modelName: 'test-model',
        tokenLimit: null,
        signal: controller.signal,
      });
      const fakeGraph = {
        stream: vi.fn(async () => {
          controller.abort();
          throw new Error('raw graph abort');
        }),
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(fakeGraph as any);

      await expect(abortingSession.startBatch({
        batchIndex: 0,
        inputState: { projectId: 'p', runId: 'run-1', mode: 'auto', generationMode: 'component', requirementIds: [], currentBatch: [], batchContext: { currentBatch: 1, totalBatches: 1, processedCount: 0 }, projectContext: { name: '', pages: [], endpoints: [] }, businessFlowBlueprints: undefined, selectedFlowIds: [], phase: 'analysis' },
      })).rejects.toBeInstanceOf(TestGenSessionAbortedError);
    });

    it('explicitly copies only the safe HTML reference into graph input', async () => {
      const streamInputs: any[] = [];
      const fakeGraph = {
        async getState() {
          return { next: ['designer'], values: { projectId: 'p' } };
        },
        async *stream(input: any) {
          streamInputs.push(input);
          yield { phase: 'complete', finalTestCases: [] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);
      const runtimeSession = new TestGenSession({
        runId: 'run-1',
        projectId: 'p',
        provider: { chat: vi.fn(), streamChat: vi.fn() } as any,
        observer: {},
        modelName: 'test-model',
        tokenLimit: null,
        htmlKnowledge: makeHtmlRuntime(),
      });

      await runtimeSession.startBatch(batchInput(htmlKnowledgeReference));

      expect(streamInputs[0].htmlKnowledgeReference).toEqual(htmlKnowledgeReference);
      expect(streamInputs[0]).not.toHaveProperty('htmlKnowledge');
      expect(streamInputs[0]).not.toHaveProperty('htmlKnowledgeSnapshot');
      expect(JSON.stringify(streamInputs[0])).not.toContain('normalized_html');
    });

    it('passes the non-persisted runtime only to graph compilation', async () => {
      const htmlKnowledge = makeHtmlRuntime();
      const runtimeSession = new TestGenSession({
        runId: 'run-1',
        projectId: 'p',
        provider: { chat: vi.fn(), streamChat: vi.fn() } as any,
        observer: {},
        modelName: 'test-model',
        tokenLimit: null,
        htmlKnowledge,
      });
      const fakeGraph = makeFakeGraph([{ phase: 'complete', finalTestCases: [] }]);
      const compile = vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(fakeGraph as any);

      await runtimeSession.startBatch(batchInput(htmlKnowledgeReference));

      expect(compile).toHaveBeenLastCalledWith(expect.objectContaining({ htmlKnowledge }));
    });
  });

  describe('resumeAt', () => {
    it('sends Command with resume payload to graph', async () => {
      const receivedInputs: any[] = [];
      const fakeGraph = {
        async getState() {
          return { next: ['designer'], values: { runId: 'run-1', projectId: 'p' } };
        },
        async *stream(input: any) {
          receivedInputs.push(input);
          yield { phase: 'complete', finalTestCases: [] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      await session.resumeAt('run-1-batch-0', { action: 'approve', feedback: 'looks good' });
      expect(receivedInputs.length).toBeGreaterThan(0);
    });

    it('rejects a checkpoint/reference mismatch before streaming', async () => {
      const stream = vi.fn();
      const runtimeSession = new TestGenSession({
        runId: 'run-1',
        projectId: 'p',
        provider: { chat: vi.fn(), streamChat: vi.fn() } as any,
        observer: {},
        modelName: 'test-model',
        tokenLimit: null,
        htmlKnowledge: makeHtmlRuntime(),
      });
      const fakeGraph = {
        getState: vi.fn(async () => ({
          next: ['designer'],
          values: {
            runId: 'run-1',
            projectId: 'p',
            htmlKnowledgeReference: {
              ...htmlKnowledgeReference,
              knowledgeSetId: 'different-set',
            },
          },
        })),
        stream,
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      await expect(runtimeSession.resumeAt('run-1-batch-0', { action: 'approve' }))
        .rejects.toBeInstanceOf(HtmlKnowledgeReferenceMismatchError);
      expect(stream).not.toHaveBeenCalled();
    });
  });

  describe('inspectCheckpoint', () => {
    it.each([
      ['none', undefined, { kind: 'none' }],
      ['start-only', { next: ['__start__'], values: { runId: 'run-1', projectId: 'p' } }, { kind: 'start-only' }],
      ['meaningful', { next: ['designer'], values: { runId: 'run-1', projectId: 'p' } }, { kind: 'meaningful' }],
      ['completed', { next: [], values: { runId: 'run-1', projectId: 'p', phase: 'complete', finalTestCases: [] } }, { kind: 'completed' }],
    ])('classifies %s checkpoint state', async (_label, snapshot, expected) => {
      const fakeGraph = { getState: vi.fn(async () => snapshot) };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      await expect(session.inspectCheckpoint('thread-1')).resolves.toMatchObject(expected);
    });

    it('types checkpointer read failures without swallowing their cause', async () => {
      const cause = new Error('checkpoint database is corrupt');
      const fakeGraph = { getState: vi.fn(async () => { throw cause; }) };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      const error = await session.inspectCheckpoint('thread-1').catch((caught) => caught);

      expect(error).toBeInstanceOf(CheckpointUnavailableError);
      expect(error).toMatchObject({ cause });
    });

    it.each([
      ['missing runId', { projectId: 'p' }],
      ['wrong runId', { runId: 'other-run', projectId: 'p' }],
      ['missing projectId', { runId: 'run-1' }],
      ['wrong projectId', { runId: 'run-1', projectId: 'other-project' }],
    ])('rejects %s as a corrupt stale checkpoint before streaming', async (_label, values) => {
      const stream = vi.fn();
      const fakeGraph = {
        getState: vi.fn(async () => ({ next: ['designer'], values })),
        stream,
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(fakeGraph as any);

      await expect(session.retryFromLastCheckpoint('stale-thread', 0))
        .rejects.toBeInstanceOf(CheckpointCorruptError);
      expect(stream).not.toHaveBeenCalled();
    });

    it('returns a completed checkpoint snapshot without streaming or rerunning an LLM', async () => {
      const stream = vi.fn();
      const finalTestCases = [{ id: 'case-from-checkpoint' }];
      const fakeGraph = {
        getState: vi.fn(async () => ({
          next: [],
          values: {
            runId: 'run-1',
            projectId: 'p',
            phase: 'complete',
            batchContext: { currentBatch: 2, totalBatches: 2, processedCount: 1 },
            finalTestCases,
          },
        })),
        stream,
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph')
        .mockReturnValue(fakeGraph as any);

      const outcome = await session.retryFromLastCheckpoint('completed-thread', 1);

      expect(outcome).toMatchObject({
        type: 'complete',
        result: { batchIndex: 1, cases: finalTestCases },
      });
      expect(stream).not.toHaveBeenCalled();
    });
  });

  describe('retryFromAgentLogs', () => {
    it('restores completed agent outputs via updateState(asNode) then streams null to resume', async () => {
      const updateStateCalls: { values: any; asNode?: string }[] = [];
      const streamInputs: any[] = [];
      const fakeGraph = {
        async updateState(_config: any, values: any, asNode?: string) {
          updateStateCalls.push({ values, asNode });
          return _config;
        },
        async getState() {
          return { next: ['checkpoint_1'], values: {} };
        },
        async *stream(input: any) {
          streamInputs.push(input);
          yield { phase: 'complete', finalTestCases: [{ id: 'tc-1' }] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      const baseInput = { projectId: 'p', runId: 'run-1', generationMode: 'mixed', currentBatch: [] };
      const completedAgentOutputs = [
        { agentName: 'test_analyst', outputData: { testConditions: [{ id: 'c1' }], requirementAnalysis: { overallApproach: 'x' } } },
      ];

      const outcome = await session.retryFromAgentLogs('retry-thread-1', 0, baseInput, completedAgentOutputs);

      // updateState called once with asNode='analyst' (last completed agent's node)
      expect(updateStateCalls).toHaveLength(1);
      expect(updateStateCalls[0].asNode).toBe('analyst');
      // Merged state contains both base input and agent output
      expect(updateStateCalls[0].values).toMatchObject({
        generationMode: 'mixed',
        testConditions: [{ id: 'c1' }],
      });

      // stream called with null (resume from checkpoint, not from START)
      expect(streamInputs).toHaveLength(1);
      expect(streamInputs[0]).toBeNull();

      expect(outcome.type).toBe('complete');
    });

    it('uses asNode=designer when both analyst and designer completed', async () => {
      const updateStateCalls: { values: any; asNode?: string }[] = [];
      const fakeGraph = {
        async updateState(_config: any, values: any, asNode?: string) {
          updateStateCalls.push({ values, asNode });
          return _config;
        },
        async getState() {
          return { next: ['checkpoint_2'], values: {} };
        },
        async *stream() {
          yield { phase: 'complete', finalTestCases: [] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      const testConditions = [{ id: 'condition-1' }];
      const draftTestCases = [{ id: 'case-1' }];
      await session.retryFromAgentLogs('retry-thread-2', 0, {
        runId: 'run-1',
        projectId: 'p',
        mode: 'auto',
      }, [
        { agentName: 'test_analyst', outputData: { testConditions } },
        { agentName: 'test_designer', outputData: { draftTestCases } },
      ]);

      // asNode should be 'designer' (the last completed agent)
      expect(updateStateCalls).toHaveLength(1);
      expect(updateStateCalls[0].asNode).toBe('designer');
      expect(updateStateCalls[0].values).toMatchObject({
        approvedConditions: testConditions,
        approvedDraftCases: draftTestCases,
      });
    });

    it('falls back to asNode=preparation when no agents completed', async () => {
      const updateStateCalls: { asNode?: string }[] = [];
      const fakeGraph = {
        async updateState(_config: any, _values: any, asNode?: string) {
          updateStateCalls.push({ asNode });
          return _config;
        },
        async getState() {
          return { next: ['analyst'], values: {} };
        },
        async *stream() {
          yield { phase: 'complete', finalTestCases: [] };
        },
      };
      vi.spyOn(await import('../graph/graph.ts'), 'buildTestGenGraph').mockReturnValue(fakeGraph as any);

      await session.retryFromAgentLogs('retry-thread-3', 0, {
        runId: 'run-1',
        projectId: 'p',
      }, []);

      expect(updateStateCalls).toHaveLength(1);
      expect(updateStateCalls[0].asNode).toBe('preparation');
    });
  });
});
