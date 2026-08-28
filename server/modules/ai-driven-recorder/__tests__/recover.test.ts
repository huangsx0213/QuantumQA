import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock suites/nl-cases so finalizeRunCompletion's saveSuite doesn't hit real DB
vi.mock('../../suites/repository.ts', () => ({ saveSuite: vi.fn() }));
vi.mock('../../nl-cases/repository.ts', () => ({ nlCaseRepo: { get: vi.fn(), save: vi.fn() } }));
vi.mock('../draft-suite-saver.ts', () => ({ saveDraftSuite: vi.fn() }));

import { recoverInterruptedRuns, type RecoverDeps } from '../recover.ts';

function makeMockRepo() {
  return {
    createRun: vi.fn(),
    getRun: vi.fn(),
    getRunsByProject: vi.fn(() => []),
    updateRunStatus: vi.fn(),
    updateRunResult: vi.fn(),
    updateRunProgress: vi.fn(),
    deleteRun: vi.fn(),
    getDecryptedProviderConfig: vi.fn(),
    insertStepLog: vi.fn(),
    getStepLogs: vi.fn(() => []),
    listStaleActiveRuns: vi.fn(() => []),
  };
}

function makeStaleRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-stale',
    project_id: 'proj-1',
    nl_case_id: 'nl-1',
    provider_config_id: null,
    status: 'running',
    execution_mode: 'agent',
    started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30min 前 → stale
    completed_at: null,
    total_steps: 0,
    completed_steps: 0,
    failed_steps: 0,
    result_suite_id: 'suite-1',
    result_case_id: 'case-1',
    replay_report: null,
    error: null,
    options: JSON.stringify({ enableCompilePipeline: true }),
    token_usage: null,
    ...overrides,
  };
}

function makeDeps(repo: ReturnType<typeof makeMockRepo>): RecoverDeps {
  return {
    repository: repo as any,
    sseGateway: { emit: vi.fn(), cleanup: vi.fn() } as any,
  };
}

describe('recoverInterruptedRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无 stale run 时返回 0，不做任何事', () => {
    const repo = makeMockRepo();
    repo.listStaleActiveRuns.mockReturnValue([]);
    const result = recoverInterruptedRuns(makeDeps(repo));
    expect(result).toBe(0);
    expect(repo.updateRunStatus).not.toHaveBeenCalled();
  });

  it('run 未分配 draft suite/case：标记 failed，不尝试恢复', () => {
    const repo = makeMockRepo();
    repo.listStaleActiveRuns.mockReturnValue([
      makeStaleRun({ result_suite_id: null, result_case_id: null }),
    ]);
    const result = recoverInterruptedRuns(makeDeps(repo));
    expect(result).toBe(0);
    expect(repo.updateRunStatus).toHaveBeenCalledWith('r-stale', 'failed', expect.stringContaining('no steps to recover'));
  });

  it('case_steps 为空：标记 failed，不恢复', () => {
    const repo = makeMockRepo();
    repo.listStaleActiveRuns.mockReturnValue([makeStaleRun()]);
    const result = recoverInterruptedRuns({
      ...makeDeps(repo),
      listLiveSteps: () => [],
    });
    expect(result).toBe(0);
    expect(repo.updateRunStatus).toHaveBeenCalledWith('r-stale', 'failed', expect.stringContaining('no steps recorded'));
  });

  it('有 live steps：触发 finalize（注入 fake），返回 1', () => {
    const repo = makeMockRepo();
    repo.listStaleActiveRuns.mockReturnValue([makeStaleRun()]);
    const finalize = vi.fn();
    const liveSteps = [
      { id: 's1', action: 'goto', target: 'http://localhost:3000/aut/login', data: null, description: '', enabled: 1, metadata: 'null', wait_for_network: 'null', assertions: 'null' },
      { id: 's2', action: 'fill', target: '#user', data: 'admin', description: '', enabled: 1, metadata: 'null', wait_for_network: 'null', assertions: 'null' },
    ];
    const result = recoverInterruptedRuns({
      ...makeDeps(repo),
      listLiveSteps: () => liveSteps,
      finalize,
    });

    expect(result).toBe(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    // step 行被还原成 TestStep（data/admin 保留标量字段，断言为 undefined）
    const params = finalize.mock.calls[0][1];
    expect(params.refinedSteps).toHaveLength(2);
    expect(params.refinedSteps[1]).toMatchObject({ action: 'fill', data: 'admin' });
    expect(params.suiteId).toBe('suite-1');
  });

  it('finalize 抛错时该 run 不计入恢复数，继续处理下一个', () => {
    const repo = makeMockRepo();
    repo.listStaleActiveRuns.mockReturnValue([
      makeStaleRun({ id: 'r-bad', result_case_id: 'case-bad' }),
      makeStaleRun({ id: 'r-good', result_case_id: 'case-good' }),
    ]);
    const badSteps = [{ id: 'b1', action: 'click', target: '#x', data: null, description: '', enabled: 1, metadata: 'null', wait_for_network: 'null', assertions: 'null' }];
    const goodSteps = [{ id: 'g1', action: 'click', target: '#y', data: null, description: '', enabled: 1, metadata: 'null', wait_for_network: 'null', assertions: 'null' }];
    const finalize = vi.fn()
      .mockImplementationOnce(() => { throw new Error('db locked'); })
      .mockImplementationOnce(() => {});

    const result = recoverInterruptedRuns({
      ...makeDeps(repo),
      listLiveSteps: (caseId) => caseId === 'case-bad' ? badSteps : goodSteps,
      finalize,
    });

    expect(result).toBe(1); // r-bad 抛错不计入；r-good 成功
    expect(finalize).toHaveBeenCalledTimes(2);
  });
});