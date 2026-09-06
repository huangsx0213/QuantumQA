// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Requirement } from '../../../../shared/contracts/index.ts';
import { buildBlueprintsFromFlowStories } from '../business-flow-blueprint.ts';
import { HtmlKnowledgeRuntimeError, type RunContext } from '../context.ts';
import { makePreparationNode } from '../graph/nodes/preparation.ts';
import { clearQueryCache } from '../graph/skills/data-skills.ts';
import {
  HtmlKnowledgeCriticalError,
  requireMatchingHtmlKnowledgeRuntime,
  type ResolvedHtmlKnowledgeRuntime,
} from '../graph/skills/html-knowledge.ts';
import {
  buildAnalystSkills,
  buildDesignerSkills,
  buildQualitySkills,
} from '../graph/skills/skills.ts';
import { requirementsFromHtmlSnapshot } from '../html-knowledge/requirement-snapshot.ts';
import type {
  HtmlKnowledgeReference,
  HtmlRequirementSnapshot,
} from '../html-knowledge/types.ts';
import { Orchestrator } from '../orchestrator.ts';
import { CoverageIndex } from '../coverage-index.ts';
import { RunCacheRegistry } from '../run-cache-registry.ts';
import { CheckpointUnavailableError } from '../session.ts';
import { SSEGateway } from '../sse-gateway.ts';

const pipelineRepo = vi.hoisted(() => ({
  deleteRun: vi.fn(),
  markRunFailed: vi.fn(),
  getRun: vi.fn(),
  getFailedRun: vi.fn(),
  getRunWithThreadId: vi.fn(),
  setRunRunning: vi.fn(),
  insertAuditLog: vi.fn(),
  getProviderConfigByName: vi.fn(),
  getActiveProviderConfig: vi.fn(() => ({ api_version: null })),
  updateModelInfo: vi.fn(),
  updateBatchCount: vi.fn(),
  updateCurrentBatch: vi.fn(),
  updateThreadId: vi.fn(),
  setRunWaiting: vi.fn(),
  updateRunState: vi.fn(),
  getRunState: vi.fn(() => null),
  getAgentLogs: vi.fn(() => []),
  getPromptOverride: vi.fn(),
  touchRun: vi.fn(),
  updateAgentLogOutput: vi.fn(),
}));

const liveRequirementRepo = vi.hoisted(() => ({
  listByProject: vi.fn(() => [] as Requirement[]),
}));

vi.mock('../repository.ts', () => ({
  pipelineRepo,
  decryptApiKey: vi.fn((value: string) => value),
}));

vi.mock('../../requirements/repository.ts', () => ({
  requirementRepo: liveRequirementRepo,
}));

vi.mock('../../../shared/db/client.ts', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => sql.includes('SELECT name FROM projects')
        ? { name: 'Snapshot Project' }
        : undefined),
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
  },
}));

const reference: HtmlKnowledgeReference = Object.freeze({
  knowledgeSetId: 'set-bound',
  pageCount: 1,
  totalBytes: 128,
  pageTitles: Object.freeze(['Snapshot Login']),
  hasLowInformationPages: false,
  requirementSnapshotHash: 'a'.repeat(64),
});

const snapshot: HtmlRequirementSnapshot = Object.freeze({
  version: 1,
  projectId: 'project-1',
  selectedRequirementIds: Object.freeze(['story-a', 'story-b']),
  selectedFlowIds: Object.freeze(['flow-a']),
  records: Object.freeze([
    record('ac-a', 'ac', 'Story A criterion from snapshot', 'story-a', ['story-b']),
    record('ac-b', 'ac', 'Story B criterion from snapshot', 'story-b'),
    record('ac-flow-a', 'ac', 'Checkout path from snapshot', 'flow-a', ['story-a']),
    record('epic-a', 'epic', 'Epic A from snapshot'),
    record('epic-b', 'epic', 'Epic B from snapshot'),
    record('flow-a', 'story', 'Flow A from snapshot', 'epic-a', [], true),
    record('story-a', 'story', 'Story A from snapshot', 'epic-a'),
    record('story-b', 'story', 'Story B from snapshot', 'epic-b'),
  ]),
});

function record(
  id: string,
  level: 'epic' | 'story' | 'ac',
  title: string,
  parentId?: string,
  relatedRequirementIds: readonly string[] = [],
  isFlow = false,
) {
  return Object.freeze({
    id,
    projectId: 'project-1',
    level,
    ...(parentId ? { parentId } : {}),
    title,
    description: `${title} description`,
    position: level === 'epic' ? 0 : 1,
    status: 'APPROVED' as const,
    flowType: null,
    isFlow,
    relatedRequirementIds: Object.freeze([...relatedRequirementIds]),
  });
}

function makeRuntime(overrides: Partial<ResolvedHtmlKnowledgeRuntime> = {}): ResolvedHtmlKnowledgeRuntime {
  return {
    projectId: 'project-1',
    reference,
    snapshot,
    repository: {
      verifyBoundReference: vi.fn(),
      loadBoundSetByRun: vi.fn(),
    },
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      getRetrievalContext: vi.fn(),
      setRetrievalContext: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    },
    dispose: vi.fn(),
    ...overrides,
  };
}

function completeOutcome(batchIndex = 0) {
  return {
    type: 'complete' as const,
    result: {
      batchIndex,
      cases: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      lastState: { testConditions: [], finalTestCases: [] },
    },
  };
}

function makeContext(sessionOverrides: Record<string, unknown> = {}, currentBatch = 0): RunContext {
  const scope = {
    currentBatch,
    setBatch: vi.fn((batch: number) => { scope.currentBatch = batch; }),
    restoreBatchState: vi.fn((batch: number) => { scope.currentBatch = batch; }),
    flushAndPersistThinking: vi.fn(),
    markComplete: vi.fn(),
    markFailed: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    runId: 'run-1',
    projectId: 'project-1',
    mode: 'auto',
    provider: { streamChat: vi.fn() },
    promptVersion: 'test',
    modelName: 'test-model',
    tokenLimit: null,
    scope: scope as any,
    session: {
      startBatch: vi.fn(async (batch: any) => completeOutcome(batch.batchIndex)),
      resumeAt: vi.fn(async () => completeOutcome()),
      retryFromLastCheckpoint: vi.fn(async () => completeOutcome()),
      retryFromAgentLogs: vi.fn(async () => completeOutcome()),
      ...sessionOverrides,
    } as any,
    htmlKnowledge: makeRuntime(),
    abortSignal: new AbortController().signal,
    sendEvent: vi.fn(),
    isAborted: () => false,
    releaseSlot: vi.fn(),
  };
}

function makeOrchestrator(context: RunContext) {
  const contextBuilder = {
    build: vi.fn(async () => context),
    abort: vi.fn(),
    beginDeletion: vi.fn(),
    waitForQuiescence: vi.fn(),
    finishDeletion: vi.fn(),
  };
  return {
    orchestrator: new Orchestrator(
      new SSEGateway(),
      new RunCacheRegistry(),
      contextBuilder as any,
    ),
    contextBuilder,
  };
}

function startParams() {
  return {
    requirementIds: ['story-a', 'story-b'],
    flowIds: ['flow-a'],
    htmlKnowledgeSetId: 'set-bound',
    mode: 'auto' as const,
  };
}

describe('HTML knowledge immutable recovery source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveRequirementRepo.listByProject.mockReturnValue([{
      id: 'story-live',
      projectId: 'project-1',
      title: 'Edited live requirement',
      description: 'This must not enter an HTML-backed run',
      level: 'story',
      status: 'APPROVED',
      position: 0,
    }]);
    pipelineRepo.getActiveProviderConfig.mockReturnValue({ api_version: null });
    pipelineRepo.getAgentLogs.mockReturnValue([]);
  });

  it('derives immutable Requirement-compatible records without mutating the snapshot', () => {
    const before = JSON.stringify(snapshot);

    const requirements = requirementsFromHtmlSnapshot(snapshot);

    expect(requirements.find((item) => item.id === 'story-a')).toMatchObject({
      title: 'Story A from snapshot',
      status: 'APPROVED',
      parentId: 'epic-a',
    });
    expect(requirements.find((item) => item.id === 'ac-a')?.relatedRequirementIds)
      .toEqual(['story-b']);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('builds flow blueprints from the explicit snapshot source, not a repository lookup', () => {
    const requirements = requirementsFromHtmlSnapshot(snapshot);
    const flow = requirements.find((item) => item.id === 'flow-a')!;

    const blueprints = buildBlueprintsFromFlowStories({
      flowStories: [flow],
      requirements,
    });

    expect(blueprints).toEqual([expect.objectContaining({
      id: 'ac-flow-a',
      name: 'Flow A from snapshot — Checkout path from snapshot',
    })]);
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it('uses the snapshot for initial batches after live requirements are edited or deleted', async () => {
    const context = makeContext();
    const { orchestrator } = makeOrchestrator(context);

    await orchestrator.start('run-1', 'project-1', startParams());

    const starts = vi.mocked(context.session.startBatch).mock.calls;
    expect(context.scope.markFailed).not.toHaveBeenCalled();
    expect(starts).toHaveLength(2);
    expect(starts[0][0].inputState.currentBatch).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'story-a', title: 'Story A from snapshot' }),
      expect.objectContaining({ id: 'flow-a', title: 'Flow A from snapshot' }),
    ]));
    expect(starts[1][0].inputState.currentBatch).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'story-b', title: 'Story B from snapshot' }),
    ]));
    expect(starts.every(([batch]) =>
      batch.inputState.htmlKnowledgeReference === reference
        || JSON.stringify(batch.inputState.htmlKnowledgeReference) === JSON.stringify(reference)
    )).toBe(true);
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it('uses the same snapshot for remaining batches after interactive resume', async () => {
    const context = makeContext({}, 1);
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRunWithThreadId.mockReturnValue({
      id: 'run-1',
      project_id: 'project-1',
      status: 'WAITING_REVIEW',
      phase: 'review-conditions',
      thread_id: 'thread-1',
      mode: 'interactive',
      config: startParams(),
      current_batch: 1,
      total_batches: 2,
    });

    await orchestrator.resume('run-1', 'approve');

    expect(context.session.resumeAt).toHaveBeenCalledWith('thread-1', expect.any(Object));
    expect(context.session.startBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(context.session.startBatch).mock.calls[0][0].inputState.currentBatch)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'story-b', title: 'Story B from snapshot' }),
      ]));
    expect(vi.mocked(context.session.startBatch).mock.calls[0][0].inputState.htmlKnowledgeReference)
      .toEqual(reference);
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it('restarts the persisted current batch on a fresh thread when no thread exists', async () => {
    const context = makeContext();
    const { orchestrator, contextBuilder } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1',
      project_id: 'project-1',
      status: 'FAILED',
      phase: 'analysis',
      thread_id: null,
      mode: 'auto',
      config: JSON.stringify(startParams()),
      current_batch: 2,
      total_batches: 2,
    });

    await orchestrator.retry('run-1');

    expect(contextBuilder.build).toHaveBeenCalledOnce();
    expect(context.session.startBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(context.session.startBatch).mock.calls[0][0].inputState.currentBatch)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'story-b', title: 'Story B from snapshot' }),
      ]));
    expect(pipelineRepo.updateThreadId).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('retry'),
    );
  });

  it('continues all snapshot batches after a pre-context no-thread failure', async () => {
    const context = makeContext();
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1',
      project_id: 'project-1',
      status: 'FAILED',
      phase: 'context',
      thread_id: null,
      mode: 'auto',
      config: JSON.stringify(startParams()),
      current_batch: 0,
      total_batches: 0,
    });

    await orchestrator.retry('run-1');

    expect(context.session.startBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.session.startBatch).mock.calls[0][0].inputState.currentBatch)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'story-a' })]));
    expect(vi.mocked(context.session.startBatch).mock.calls[1][0].inputState.currentBatch)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'story-b' })]));
    expect(pipelineRepo.updateBatchCount).toHaveBeenCalledWith('run-1', 2);
  });

  it('restarts a start-only checkpoint but resumes a meaningful checkpoint', async () => {
    const unavailable = new CheckpointUnavailableError('Checkpoint contains only __start__');
    const startOnlyContext = makeContext({
      retryFromLastCheckpoint: vi.fn(async () => { throw unavailable; }),
    });
    const startOnly = makeOrchestrator(startOnlyContext).orchestrator;
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'analysis',
      thread_id: 'thread-start', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 1,
    });

    await startOnly.retry('run-1');
    expect(startOnlyContext.session.startBatch).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    pipelineRepo.getActiveProviderConfig.mockReturnValue({ api_version: null });
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'design',
      thread_id: 'thread-meaningful', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 1,
    });
    const meaningfulContext = makeContext();
    const meaningful = makeOrchestrator(meaningfulContext).orchestrator;

    await meaningful.retry('run-1');

    expect(meaningfulContext.session.retryFromLastCheckpoint)
      .toHaveBeenCalledWith('thread-meaningful', 0);
    expect(meaningfulContext.session.startBatch).not.toHaveBeenCalled();
  });

  it('uses snapshot-backed reference metadata for agent-log fallback', async () => {
    const context = makeContext({
      retryFromLastCheckpoint: vi.fn(async () => {
        throw new CheckpointUnavailableError('Checkpoint is unavailable');
      }),
    });
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'design',
      thread_id: 'thread-1', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 2,
    });
    pipelineRepo.getAgentLogs.mockReturnValue([{
      batch: 1,
      status: 'COMPLETED',
      agent_name: 'test_analyst',
      output_data: { testConditions: [] },
    }]);

    await orchestrator.retry('run-1');

    expect(context.session.retryFromAgentLogs).toHaveBeenCalledOnce();
    const baseInput = vi.mocked(context.session.retryFromAgentLogs).mock.calls[0][2];
    expect(baseInput).toMatchObject({
      htmlKnowledgeReference: reference,
      currentBatch: expect.arrayContaining([
        expect.objectContaining({ id: 'story-a', title: 'Story A from snapshot' }),
      ]),
    });
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it.each([
    ['noncontiguous designer', [
      { batch: 1, status: 'COMPLETED', agent_name: 'test_designer', output_data: { draftTestCases: [{ id: 'draft' }] } },
    ]],
    ['multiple designer completions', [
      { batch: 1, status: 'COMPLETED', agent_name: 'test_analyst', output_data: { testConditions: [{ id: 'condition' }] } },
      { batch: 1, status: 'COMPLETED', agent_name: 'test_designer', output_data: { draftTestCases: [{ id: 'draft-1' }] } },
      { batch: 1, status: 'COMPLETED', agent_name: 'test_designer', output_data: { draftTestCases: [{ id: 'draft-2' }] } },
    ]],
    ['auto-repair quality history with preserved cases', [
      { batch: 1, status: 'COMPLETED', agent_name: 'test_analyst', output_data: { testConditions: [{ id: 'condition' }] } },
      { batch: 1, status: 'COMPLETED', agent_name: 'test_designer', output_data: { draftTestCases: [{ id: 'draft' }] } },
      {
        batch: 1,
        status: 'COMPLETED',
        agent_name: 'quality_manager',
        output_data: {
          finalTestCases: [{ id: 'preserved-case' }],
          coverageMatrix: { summary: { missingConditions: 1 } },
        },
      },
      { batch: 1, status: 'FAILED', agent_name: 'test_designer', output_data: { preservedCases: [{ id: 'preserved-case' }] } },
    ]],
  ])('restarts the immutable batch for ambiguous %s agent-log recovery', async (_label, logs) => {
    const context = makeContext({
      retryFromLastCheckpoint: vi.fn(async () => {
        throw new CheckpointUnavailableError('Checkpoint is unavailable');
      }),
    });
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'design',
      thread_id: 'thread-1', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 1,
    });
    pipelineRepo.getAgentLogs.mockReturnValue(logs);

    await orchestrator.retry('run-1');

    expect(context.session.retryFromAgentLogs).not.toHaveBeenCalled();
    expect(context.session.startBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(context.session.startBatch).mock.calls[0][0].inputState)
      .toMatchObject({
        htmlKnowledgeReference: reference,
        currentBatch: expect.arrayContaining([expect.objectContaining({ id: 'story-a' })]),
      });
  });

  it('restarts after a failed Quality row instead of restoring a patch-only Designer result', async () => {
    const context = makeContext({
      retryFromLastCheckpoint: vi.fn(async () => {
        throw new CheckpointUnavailableError('Checkpoint is unavailable');
      }),
    });
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'quality',
      thread_id: 'run-1-batch-epic-a-mixed', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 1,
    });
    const logs = [
      {
        batch: 1,
        status: 'COMPLETED',
        agent_name: 'test_analyst',
        output_data: { testConditions: [{ id: 'all-condition' }] },
      },
      {
        batch: 1,
        status: 'COMPLETED',
        agent_name: 'test_designer',
        output_data: { draftTestCases: [{ id: 'patch-only-case' }] },
      },
      {
        batch: 1,
        status: 'FAILED',
        agent_name: 'quality_manager',
        output_data: {
          finalTestCases: [{ id: 'preserved-case' }],
          coverageMatrix: { summary: { missingConditions: 1 } },
        },
      },
    ];
    pipelineRepo.getAgentLogs.mockReturnValue(logs);

    await orchestrator.retry('run-1');

    expect(context.session.retryFromAgentLogs).not.toHaveBeenCalled();
    expect(context.session.startBatch).toHaveBeenCalledOnce();
    const freshInput = vi.mocked(context.session.startBatch).mock.calls[0][0].inputState;
    expect(freshInput.currentBatch).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'story-a' }),
      expect.objectContaining({ id: 'flow-a' }),
    ]));
    expect(JSON.stringify(freshInput)).not.toContain('patch-only-case');
    expect(logs[2].output_data.finalTestCases).toEqual([{ id: 'preserved-case' }]);
  });

  it('does not turn a genuine retry agent failure into a second LLM attempt', async () => {
    const agentFailure = new Error('designer failed again');
    const context = makeContext({
      retryFromLastCheckpoint: vi.fn(async () => { throw agentFailure; }),
    });
    const { orchestrator } = makeOrchestrator(context);
    pipelineRepo.getRun.mockReturnValue({ id: 'run-1', status: 'FAILED' });
    pipelineRepo.getFailedRun.mockReturnValue({
      id: 'run-1', project_id: 'project-1', status: 'FAILED', phase: 'design',
      thread_id: 'thread-1', mode: 'auto', config: JSON.stringify(startParams()),
      current_batch: 1, total_batches: 2,
    });

    await orchestrator.retry('run-1');

    expect(context.session.startBatch).not.toHaveBeenCalled();
    expect(context.session.retryFromAgentLogs).not.toHaveBeenCalled();
    expect(context.scope.markFailed).toHaveBeenCalledWith(agentFailure.message);
  });

  it('fails a configured run when its resolved runtime is absent instead of using live rows', async () => {
    const context = makeContext();
    context.htmlKnowledge = undefined;
    const { orchestrator } = makeOrchestrator(context);

    await orchestrator.start('run-1', 'project-1', startParams());

    expect(context.session.startBatch).not.toHaveBeenCalled();
    expect(context.scope.markFailed).toHaveBeenCalledWith(expect.stringMatching(/HTML knowledge/i));
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });
});

describe('HTML runtime closure invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows the skill runtime only when project and exact state reference match', () => {
    const runtime = makeRuntime();

    expect(requireMatchingHtmlKnowledgeRuntime('project-1', reference, runtime)).toBe(runtime);
    expect(requireMatchingHtmlKnowledgeRuntime('project-1', undefined, undefined)).toBeUndefined();
    expect(() => requireMatchingHtmlKnowledgeRuntime(
      'project-1',
      { ...reference, requirementSnapshotHash: 'b'.repeat(64) },
      runtime,
    )).toThrow(HtmlKnowledgeCriticalError);
    expect(() => requireMatchingHtmlKnowledgeRuntime('project-1', reference, undefined))
      .toThrow(HtmlKnowledgeCriticalError);
  });

  it('preparation derives cross-epic context from the snapshot closure', async () => {
    const runtime = makeRuntime();
    const node = makePreparationNode({ htmlKnowledge: runtime });
    const requirements = requirementsFromHtmlSnapshot(snapshot);
    const story = requirements.find((item) => item.id === 'story-a')!;
    const criterion = requirements.find((item) => item.id === 'ac-a')!;

    const result = await node({
      projectId: 'project-1',
      runId: 'run-1',
      mode: 'auto',
      htmlKnowledgeReference: reference,
      currentBatch: [{
        id: story.id,
        title: story.title,
        description: story.description,
        level: story.level,
        parentId: story.parentId ?? '',
        acceptanceCriteria: [{
          id: criterion.id,
          title: criterion.title,
          description: criterion.description,
          relatedRequirementIds: criterion.relatedRequirementIds,
        }],
      }],
      batchContext: { currentBatch: 1, totalBatches: 2, processedCount: 0 },
      businessFlowBlueprints: [],
      selectedFlowIds: [],
      globalEpicIndex: [
        { epicId: 'epic-a', title: 'Epic A', children: [] },
        { epicId: 'epic-b', title: 'Epic B', children: [] },
      ],
    } as any);

    expect(result.crossEpicDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromRequirementId: 'story-a',
        toRequirementId: 'story-b',
        toEpicId: 'epic-b',
      }),
    ]));
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it('uses a typed recoverable error for a configured runtime source failure', () => {
    const error = new HtmlKnowledgeRuntimeError('Bound set missing');
    expect(error).toMatchObject({
      code: 'HTML_KNOWLEDGE_UNAVAILABLE',
      recoverable: true,
    });
  });

  it('isolates snapshot-backed data-skill caches between concurrent runs', async () => {
    clearQueryCache();
    const editedSnapshot: HtmlRequirementSnapshot = {
      ...snapshot,
      records: snapshot.records.map((item) => item.id === 'story-a'
        ? { ...item, title: 'Story A from another bound run' }
        : item),
    };
    const firstRuntime = makeRuntime();
    const secondRuntime = makeRuntime({
      snapshot: editedSnapshot,
      reference: {
        ...reference,
        knowledgeSetId: 'set-other',
        requirementSnapshotHash: 'c'.repeat(64),
      },
    });
    const batch = [{
      id: 'story-a',
      title: 'Story A',
      level: 'story',
      parentId: 'epic-a',
    }];
    const firstSkill = buildAnalystSkills(
      'run-first',
      'project-1',
      batch,
      firstRuntime,
    ).find((skill) => skill.name === 'requirement_detail_query')!;
    const secondSkill = buildAnalystSkills(
      'run-second',
      'project-1',
      batch,
      secondRuntime,
    ).find((skill) => skill.name === 'requirement_detail_query')!;

    const first = await firstSkill.func({ requirementId: 'story-a' }) as any;
    const second = await secondSkill.func({ requirementId: 'story-a' }) as any;

    expect(first.title).toBe('Story A from snapshot');
    expect(second.title).toBe('Story A from another bound run');
  });

  it('keeps every role previous-batch tool on the immutable snapshot after live deletion', async () => {
    const liveRequirements = requirementsFromHtmlSnapshot(snapshot);
    liveRequirementRepo.listByProject.mockImplementation(() => liveRequirements);
    pipelineRepo.getRun.mockReturnValue({ project_id: 'project-1' });
    const idx = new CoverageIndex();
    idx.addCondition({
      id: 'condition-snapshot',
      requirementId: 'story-a',
      condition: 'Snapshot-backed condition',
      conditionType: 'component',
      category: 'functional',
      primaryTechnique: 'EP',
    });
    idx.addCase({
      requirementId: 'story-a',
      title: 'Snapshot-backed case',
      testLevel: 'component',
      conditionId: 'condition-snapshot',
    });
    pipelineRepo.getRunState.mockReturnValue(JSON.stringify(idx.serialize()));
    const runtime = makeRuntime();
    const batch = [{
      id: 'story-a',
      title: 'Story A from snapshot',
      level: 'story',
      parentId: 'epic-a',
    }];

    liveRequirements.find((item) => item.id === 'story-a')!.title = 'Edited live title';
    liveRequirements.length = 0;
    const analystTool = buildAnalystSkills('run-1', 'project-1', batch, runtime)
      .find((skill) => skill.name === 'previous_batch_conditions_query')!;
    const designerTool = buildDesignerSkills('run-1', 'project-1', batch, runtime)
      .find((skill) => skill.name === 'previous_batch_cases_query')!;
    const qualityTool = buildQualitySkills('run-1', 'project-1', batch, runtime)
      .find((skill) => skill.name === 'previous_batch_cases_query')!;

    const analystResult = await analystTool.func({ requirementId: 'story-a' });
    const designerResult = await designerTool.func({ requirementId: 'story-a' });
    const qualityResult = await qualityTool.func({ requirementId: 'story-a' });

    expect(analystResult).toMatchObject({
      requirementId: 'story-a',
      conditions: [expect.objectContaining({ title: 'Snapshot-backed condition' })],
    });
    expect(designerResult).toMatchObject({
      requirementId: 'story-a',
      cases: [expect.objectContaining({ title: 'Snapshot-backed case' })],
    });
    expect(qualityResult).toEqual(designerResult);
    expect(liveRequirementRepo.listByProject).not.toHaveBeenCalled();
  });

  it('keeps every role previous-batch tool live-backed for non-HTML runs', async () => {
    liveRequirementRepo.listByProject.mockReturnValue(
      requirementsFromHtmlSnapshot(snapshot),
    );
    pipelineRepo.getRun.mockReturnValue({ project_id: 'project-1' });
    (pipelineRepo.getAgentLogs as any).mockImplementation((_runId: string, agentName?: string) => [{
      output_data: agentName === 'test_analyst'
        ? {
            testConditions: [{
              id: 'condition-live',
              requirementId: 'story-a',
              condition: 'Live-backed condition',
              conditionType: 'component',
            }],
          }
        : {
            finalTestCases: [{
              requirementId: 'story-a',
              title: 'Live-backed case',
            }],
          },
    }] as any);
    const builders = [buildAnalystSkills, buildDesignerSkills, buildQualitySkills];

    for (const buildSkills of builders) {
      const toolName = buildSkills === buildAnalystSkills
        ? 'previous_batch_conditions_query'
        : 'previous_batch_cases_query';
      const tool = buildSkills('run-1', 'project-1')
        .find((skill) => skill.name === toolName)!;
      const result = await tool.func({ requirementId: 'story-a' }) as any;
      expect(result.requirementId).toBe('story-a');
    }
    expect(liveRequirementRepo.listByProject).toHaveBeenCalledTimes(3);
  });
});
