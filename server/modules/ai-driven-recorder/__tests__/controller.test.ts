import { describe, expect, it, vi, beforeEach } from 'vitest';

// === Mocks ===

vi.mock('../../../shared/services/websocketService.ts', () => ({
  wsService: { broadcast: vi.fn() },
}));

vi.mock('../../agent/registry.ts', () => ({
  agentRegistry: {
    getActiveConnections: vi.fn(() => new Map()),
  },
}));

vi.mock('../../nl-cases/repository.ts', () => ({
  nlCaseRepo: {
    get: vi.fn(),
    save: vi.fn(),
  },
}));

vi.mock('../../suites/repository.ts', () => ({
  saveSuite: vi.fn(),
}));

import { saveSuite } from '../../suites/repository.ts';

vi.mock('../../../shared/utils/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/utils/index.ts')>();
  return {
    ...actual,
    randomId: (prefix: string) => `${prefix}-mock-id`,
  };
});

import { AiDrivenRecorderController } from '../controller.ts';
import { SSEGateway } from '../../ai-test-gen/sse-gateway.ts';
import { AiDrivenRecorderRepository } from '../repository.ts';
import { nlCaseRepo } from '../../nl-cases/repository.ts';
import { agentRegistry } from '../../agent/registry.ts';
import { wsService } from '../../../shared/services/websocketService.ts';
import {
  AI_RECORDER_START_EVENT,
  AI_RECORDER_STOP_EVENT,
} from '../../../../shared/recording/protocol.ts';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../shared/http/errors.ts';
import { registerLocalRun, unregisterLocalRun } from '../run-registry.ts';

// === Helpers ===

function makeApprovedNlCase() {
  return {
    id: 'nl-1',
    projectId: 'proj-1',
    title: 'Login Test',
    status: 'APPROVED' as const,
    preconditions: ['https://app.example.com/login'],
    testData: [],
    steps: [
      { sequence: 1, action: 'open login page', expected: 'page loaded' },
      { sequence: 2, action: 'input credentials', expected: 'inputs filled' },
    ],
    generatedSuiteId: undefined,
  };
}

function makeMockRepo() {
  return {
    createRun: vi.fn(() => 'run-mock-id'),
    getRun: vi.fn(),
    getRunsByProject: vi.fn(() => []),
    updateRunStatus: vi.fn(),
    updateRunResult: vi.fn(),
    updateRunProgress: vi.fn(),
    deleteRun: vi.fn(),
    getDecryptedProviderConfig: vi.fn(),
    insertStepLog: vi.fn(),
    getStepLogs: vi.fn(() => []),
  };
}

function makeValidStartBody(overrides: Record<string, unknown> = {}) {
  return { nlCaseId: 'nl-1', providerConfigId: 'pc-1', ...overrides };
}

function makeMockAgent(ws?: { send: ReturnType<typeof vi.fn> }) {
  return {
    id: 'agent-1',
    status: 'idle',
    ws: ws ?? { send: vi.fn() },
  };
}

function makeStubLocalRunner() {
  return { assertCapacity: vi.fn(), start: vi.fn() };
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('AiDrivenRecorderController', () => {
  let sseGateway: SSEGateway;
  let repository: ReturnType<typeof makeMockRepo>;
  let controller: AiDrivenRecorderController;

  beforeEach(() => {
    vi.clearAllMocks();
    sseGateway = new SSEGateway({ cleanupEvents: ['run:complete', 'run:error'], checkpointEvent: null });
    repository = makeMockRepo() as any;
    controller = new AiDrivenRecorderController(sseGateway, repository as any);
  });

  describe('startRun', () => {
    it('成功路径：校验通过 + 创建 run + 下发 AI_RECORDER_START', () => {
      const nlCase = makeApprovedNlCase();
      vi.mocked(nlCaseRepo.get).mockReturnValue(nlCase as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1',
        name: 'openai',
        type: 'azure-openai', // certified
        apiKey: 'sk-test',
        model: 'gpt-4',
      });
      const mockWs = { send: vi.fn() };
      const agent = makeMockAgent(mockWs);
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(new Map([['agent-1', agent as any]]));

      // 先注册监听再触发：startRun 内的 run:start 是同步 emit，事后订阅收不到
      const events: any[] = [];
      sseGateway.getEmitter('run-mock-id').on('sse', (e: string, d: any) => events.push({ event: e, data: d }));

      const result = controller.startRun('proj-1', {
        nlCaseId: 'nl-1',
        providerConfigId: 'pc-1',
        options: { headless: true },
      });

      expect(result).toEqual({
        runId: 'run-mock-id',
        suiteId: 'ai-draft-suite-mock-id',
        caseId: 'ai-draft-case-mock-id',
        status: 'started',
      });

      // 创建了 run 记录
      expect(repository.createRun).toHaveBeenCalledWith({
        projectId: 'proj-1',
        nlCaseId: 'nl-1',
        providerConfigId: 'pc-1',
        options: { headless: true },
        executionMode: 'agent',
      });

      // 下发了 AI_RECORDER_START
      const sentPacket = mockWs.send.mock.calls[0][0] as string;
      const parsed = JSON.parse(sentPacket);
      expect(parsed.event).toBe(AI_RECORDER_START_EVENT);
      expect(parsed.data).toEqual({
        runId: 'run-mock-id',
        projectId: 'proj-1',
        nlCase,
        providerConfigId: 'pc-1',
        options: { headless: true },
        caseId: 'ai-draft-case-mock-id',
        suiteId: 'ai-draft-suite-mock-id',
      });

      // SSE 广播了 run:start
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'run:start',
          data: expect.objectContaining({ runId: 'run-mock-id', nlCaseId: 'nl-1' }),
        }),
      );
    });

    it('NlCase 不存在时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(undefined);

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nonexistent', providerConfigId: 'pc-1' },
      ));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 404, message: 'NlCase not found: nonexistent' });
    });

    it('NlCase 不属于该项目时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue({ ...makeApprovedNlCase(), projectId: 'other-project' } as any);

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'pc-1' },
      ));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({
        statusCode: 404,
        message: 'NlCase does not belong to this project',
      });
    });

    it('NlCase 状态非 APPROVED 时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue({ ...makeApprovedNlCase(), status: 'DRAFT' } as any);

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'pc-1' },
      ));
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        message: 'NlCase must be APPROVED, current: DRAFT',
      });
});

    it('providerConfig 不存在时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue(undefined);

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'nonexistent' },
      ));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({
        statusCode: 404,
        message: 'Provider config not found: nonexistent',
      });
    });

    it('providerConfig 类型为 unverified 时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1',
        name: 'local',
        type: 'openai-compatible', // unverified
        apiKey: 'sk-test',
        model: 'gpt-4',
      });

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'pc-1' },
      ));
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        message: 'Provider type openai-compatible is not allowed for AI recording (unverified)',
      });
    });

    it('已有进行中的 run 时抛错', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      repository.getRunsByProject.mockReturnValue([
        { id: 'old-run', nl_case_id: 'nl-1', status: 'running' },
      ]);

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'pc-1' },
      ));
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        message: 'NlCase already has an active run: old-run',
      });
    });

    it('无 idle Agent 时抛错并标记 run failed', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(new Map());

      const error = captureError(() => controller.startRun(
        'proj-1',
        { nlCaseId: 'nl-1', providerConfigId: 'pc-1' },
      ));

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(error).toMatchObject({ statusCode: 503, message: 'No idle agent available' });
      expect(repository.updateRunStatus).toHaveBeenCalledWith('run-mock-id', 'failed', 'No idle agent available');
    });

    it('缺少 nlCaseId 时抛错', () => {
      const error = captureError(() => controller.startRun(
        'proj-1',
        { providerConfigId: 'pc-1' },
      ));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ statusCode: 400, message: 'nlCaseId is required' });
    });

    it('缺少 providerConfigId 时抛错', () => {
      const error = captureError(() => controller.startRun('proj-1', { nlCaseId: 'nl-1' }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ statusCode: 400, message: 'providerConfigId is required' });
    });

    it('rejects invalid executionMode before any side effect', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });

      const error = captureError(() =>
        controller.startRun('proj-1', makeValidStartBody({ executionMode: 'cloud' })),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(saveSuite).not.toHaveBeenCalled();
      expect(repository.createRun).not.toHaveBeenCalled();
    });

    it('records local mode on the run row and exposes it', () => {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      // 注入 stub runner，避免 production wiring 真正拉起录制 session
      const runner = makeStubLocalRunner();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, runner as any);

      const res = ctrl.startRun('proj-1', makeValidStartBody({ executionMode: 'local' }));

      expect(repository.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: 'local' }),
      );
      repository.getRun.mockReturnValue({
        id: res.runId,
        project_id: 'proj-1',
        nl_case_id: 'nl-1',
        status: 'running',
        total_steps: 0,
        completed_steps: 0,
        failed_steps: 0,
        execution_mode: 'local',
      });
      const status = ctrl.getRun('proj-1', res.runId);
      expect(status).toMatchObject({ executionMode: 'local' });
    });
  });

  describe('startRun — local/agent dispatch', () => {
    function setupValidWiring() {
      const nlCase = makeApprovedNlCase();
      vi.mocked(nlCaseRepo.get).mockReturnValue(nlCase as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      return nlCase;
    }

    it('local 模式：分发到 localRunner.start 且不触碰 agent 选择/ws 下发', () => {
      const nlCase = setupValidWiring();
      // 即使有空闲 agent 存在，local 模式也不得使用
      const mockWs = { send: vi.fn() };
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent(mockWs) as any]]),
      );
      const runner = makeStubLocalRunner();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, runner as any);
      const emitSpy = vi.spyOn(sseGateway, 'emit');

      const res = ctrl.startRun(
        'proj-1',
        makeValidStartBody({ executionMode: 'local', options: { headless: false } }),
      );

      expect(runner.assertCapacity).toHaveBeenCalledTimes(1);
      expect(runner.start).toHaveBeenCalledWith({
        runId: 'run-mock-id',
        projectId: 'proj-1',
        nlCase,
        providerConfig: expect.objectContaining({ id: 'pc-1' }),
        options: { headless: false },
        caseId: 'ai-draft-case-mock-id',
        suiteId: 'ai-draft-suite-mock-id',
      });

      // 不走 agent 路径
      expect(agentRegistry.getActiveConnections).not.toHaveBeenCalled();
      expect(mockWs.send).not.toHaveBeenCalled();
      expect(wsService.broadcast).not.toHaveBeenCalled();

      // run:start SSE 广播在 dispatch 之后保持不变
      expect(emitSpy).toHaveBeenCalledWith('run-mock-id', 'run:start', expect.objectContaining({
        runId: 'run-mock-id',
        nlCaseId: 'nl-1',
      }));
      emitSpy.mockRestore();
    });

    it('local 模式容量已满：409 先于所有副作用（不建 draft suite、不建 run）', () => {
      setupValidWiring();
      const runner = {
        assertCapacity: vi.fn(() => {
          throw new ConflictError('Local recorder is busy: concurrent local run limit reached');
        }),
        start: vi.fn(),
      };
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, runner as any);

      const error = captureError(() =>
        ctrl.startRun('proj-1', makeValidStartBody({ executionMode: 'local' })),
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        message: 'Local recorder is busy: concurrent local run limit reached',
      });
      expect(runner.assertCapacity).toHaveBeenCalledTimes(1);
      expect(saveSuite).not.toHaveBeenCalled();
      expect(repository.createRun).not.toHaveBeenCalled();
    });

    it('agent 模式（默认）：路径不变，不经过 localRunner', () => {
      setupValidWiring();
      const mockWs = { send: vi.fn() };
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent(mockWs) as any]]),
      );
      const runner = makeStubLocalRunner();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, runner as any);

      const res = ctrl.startRun('proj-1', makeValidStartBody());

      expect(res.status).toBe('started');
      expect(runner.assertCapacity).not.toHaveBeenCalled();
      expect(runner.start).not.toHaveBeenCalled();

      const sentPacket = mockWs.send.mock.calls[0][0] as string;
      expect(JSON.parse(sentPacket).event).toBe(AI_RECORDER_START_EVENT);
    });
  });

  describe('startRun — start URL preflight', () => {
    function setupCaseWithoutUrl() {
      vi.mocked(nlCaseRepo.get).mockReturnValue({
        ...makeApprovedNlCase(),
        preconditions: [],
        testData: [],
      } as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent() as any]]),
      );
    }

    function setupCaseWithUrl() {
      vi.mocked(nlCaseRepo.get).mockReturnValue(makeApprovedNlCase() as any);
      repository.getDecryptedProviderConfig.mockReturnValue({
        id: 'pc-1', name: 'azure', type: 'azure-openai', apiKey: 'sk', model: 'gpt-4',
      });
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent() as any]]),
      );
    }

    it('无覆盖且用例无可解析 URL：400 且零副作用', () => {
      setupCaseWithoutUrl();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, makeStubLocalRunner() as any);

      const error = captureError(() => ctrl.startRun('proj-1', makeValidStartBody({ executionMode: 'local' })));

      expect(error).toMatchObject({ statusCode: 400, message: expect.stringContaining('no resolvable start URL') });
      expect(saveSuite).not.toHaveBeenCalled();
      expect(repository.createRun).not.toHaveBeenCalled();
    });

    it('提供 startUrl 覆盖：跳过用例解析并透传到 agent WS 载荷', () => {
      setupCaseWithoutUrl();
      const mockWs = { send: vi.fn() };
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent(mockWs) as any]]),
      );
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, makeStubLocalRunner() as any);

      ctrl.startRun('proj-1', makeValidStartBody({ startUrl: 'staging.app.dev/signin' }));

      const payload = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(payload.data.startUrl).toBe('https://staging.app.dev/signin');
    });

    it('startUrl 覆盖透传到 localRunner', () => {
      setupCaseWithoutUrl();
      const runner = makeStubLocalRunner();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, runner as any);

      ctrl.startRun('proj-1', makeValidStartBody({ executionMode: 'local', startUrl: 'https://override.com/home' }));

      expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ startUrl: 'https://override.com/home' }));
    });

    it('非法 startUrl：400 且零副作用', () => {
      setupCaseWithUrl();
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, makeStubLocalRunner() as any);

      const error = captureError(() => ctrl.startRun('proj-1', makeValidStartBody({ startUrl: 'not a url' })));

      expect(error).toMatchObject({ statusCode: 400, message: expect.stringContaining('Invalid start URL') });
      expect(saveSuite).not.toHaveBeenCalled();
      expect(repository.createRun).not.toHaveBeenCalled();
    });

    it('agent 模式 ws 载荷在未提供覆盖时不含 startUrl 字段（契约不变）', () => {
      setupCaseWithUrl();
      const mockWs = { send: vi.fn() };
      vi.mocked(agentRegistry.getActiveConnections).mockReturnValue(
        new Map([['agent-1', makeMockAgent(mockWs) as any]]),
      );
      const ctrl = new AiDrivenRecorderController(sseGateway, repository as any, makeStubLocalRunner() as any);

      ctrl.startRun('proj-1', makeValidStartBody());

      const payload = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(payload.data).not.toHaveProperty('startUrl');
    });
  });

  describe('getRun', () => {
    it('返回 run 状态', () => {
      repository.getRun.mockReturnValue({
        id: 'run-1',
        project_id: 'proj-1',
        nl_case_id: 'nl-1',
        status: 'completed',
        total_steps: 5,
        completed_steps: 5,
        failed_steps: 0,
        result_suite_id: 'suite-1',
        result_case_id: 'case-1',
        replay_report: JSON.stringify({ verdict: 'pass' }),
        error: null,
      });

      const result = controller.getRun('proj-1', 'run-1');

      expect(result).toEqual({
        runId: 'run-1',
        nlCaseId: 'nl-1',
        status: 'completed',
        progress: { total: 5, completed: 5, failed: 0 },
        result: { suiteId: 'suite-1', caseId: 'case-1' },
        replayReport: { verdict: 'pass' },
      });
    });

    it('run 不存在时抛错', () => {
      repository.getRun.mockReturnValue(undefined);

      const error = captureError(() => controller.getRun('proj-1', 'nonexistent'));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 404, message: 'Run not found: nonexistent' });
    });

    it('run 不属于该项目时抛错', () => {
      repository.getRun.mockReturnValue({
        id: 'run-1',
        project_id: 'other-project',
        nl_case_id: 'nl-1',
        status: 'running',
        total_steps: 0,
        completed_steps: 0,
        failed_steps: 0,
      });

      const error = captureError(() => controller.getRun('proj-1', 'run-1'));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({
        statusCode: 404,
        message: 'Run does not belong to this project',
      });
    });

    it('replay_report 为非法 JSON 时返回 undefined', () => {
      repository.getRun.mockReturnValue({
        id: 'run-1',
        project_id: 'proj-1',
        nl_case_id: 'nl-1',
        status: 'completed',
        total_steps: 0,
        completed_steps: 0,
        failed_steps: 0,
        replay_report: 'not-json',
      });

      const result = controller.getRun('proj-1', 'run-1');

      expect(result.replayReport).toBeUndefined();
    });
  });

  describe('listRuns', () => {
    it('返回项目的所有 run', () => {
      repository.getRunsByProject.mockReturnValue([
        {
          id: 'run-1',
          nl_case_id: 'nl-1',
          status: 'completed',
          total_steps: 5,
          completed_steps: 5,
          failed_steps: 0,
          result_suite_id: 'suite-1',
          result_case_id: 'case-1',
          replay_report: null,
          error: null,
        },
        {
          id: 'run-2',
          nl_case_id: 'nl-2',
          status: 'failed',
          total_steps: 3,
          completed_steps: 2,
          failed_steps: 1,
          result_suite_id: null,
          result_case_id: null,
          replay_report: null,
          error: 'stagehand failed',
        },
      ]);

      const result = controller.listRuns('proj-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        runId: 'run-1',
        nlCaseId: 'nl-1',
        status: 'completed',
        progress: { total: 5, completed: 5, failed: 0 },
        result: { suiteId: 'suite-1', caseId: 'case-1' },
        replayReport: undefined,
        error: undefined,
      });
      expect(result[1].error).toBe('stagehand failed');
    });
  });

  describe('deleteRun', () => {
    it('进行中的 run：发送 STOP + SSE 广播 run:error + cleanup + 软删除(状态置 failed)', () => {
      repository.getRun.mockReturnValue({
        id: 'run-1',
        project_id: 'proj-1',
        status: 'running',
      });

      const result = controller.deleteRun('proj-1', 'run-1');

      expect(result).toEqual({ success: true });
      expect(wsService.broadcast).toHaveBeenCalledWith(AI_RECORDER_STOP_EVENT, { runId: 'run-1' });
      expect(repository.updateRunStatus).toHaveBeenCalledWith('run-1', 'failed', 'Run aborted by user');
      expect(repository.deleteRun).not.toHaveBeenCalled();
    });

    it('已完成的 run：硬删除历史记录（不发送 STOP 不改状态）', () => {
      repository.getRun.mockReturnValue({
        id: 'run-1',
        project_id: 'proj-1',
        status: 'completed',
      });

      controller.deleteRun('proj-1', 'run-1');

      expect(wsService.broadcast).not.toHaveBeenCalled();
      expect(repository.updateRunStatus).not.toHaveBeenCalled();
      expect(repository.deleteRun).toHaveBeenCalledWith('run-1');
    });

    it('已失败的 run：硬删除历史记录', () => {
      repository.getRun.mockReturnValue({
        id: 'run-failed',
        project_id: 'proj-1',
        status: 'failed',
      });

      controller.deleteRun('proj-1', 'run-failed');

      expect(wsService.broadcast).not.toHaveBeenCalled();
      expect(repository.updateRunStatus).not.toHaveBeenCalled();
      expect(repository.deleteRun).toHaveBeenCalledWith('run-failed');
    });

    it('run 不存在时抛错，不改状态不删除', () => {
      repository.getRun.mockReturnValue(undefined);

      const error = captureError(() => controller.deleteRun('proj-1', 'nonexistent'));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 404, message: 'Run not found: nonexistent' });
      expect(repository.updateRunStatus).not.toHaveBeenCalled();
      expect(repository.deleteRun).not.toHaveBeenCalled();
    });

    it('local 运行中的 run：通过注册句柄 abort，不向 agent 广播 STOP', () => {
      repository.getRun.mockReturnValue({
        id: 'run-local',
        project_id: 'proj-1',
        status: 'running',
        execution_mode: 'local',
      });
      const handle = { abort: vi.fn(), resolveTakeover: vi.fn() };
      registerLocalRun('run-local', handle);

      try {
        controller.deleteRun('proj-1', 'run-local');

        expect(handle.abort).toHaveBeenCalledTimes(1);
        expect(wsService.broadcast).not.toHaveBeenCalledWith(
          AI_RECORDER_STOP_EVENT,
          { runId: 'run-local' },
        );
        expect(repository.updateRunStatus).toHaveBeenCalledWith('run-local', 'failed', 'Run aborted by user');
        expect(repository.deleteRun).not.toHaveBeenCalled();
      } finally {
        unregisterLocalRun('run-local');
      }
    });

    it('agent 运行中的 run：仍广播 STOP（跨模式互不影响）', () => {
      repository.getRun.mockReturnValue({
        id: 'run-agent',
        project_id: 'proj-1',
        status: 'running',
        execution_mode: 'agent',
      });
      const handle = { abort: vi.fn(), resolveTakeover: vi.fn() };
      registerLocalRun('run-other-local', handle);

      try {
        controller.deleteRun('proj-1', 'run-agent');

        expect(wsService.broadcast).toHaveBeenCalledWith(AI_RECORDER_STOP_EVENT, { runId: 'run-agent' });
        expect(handle.abort).not.toHaveBeenCalled();
      } finally {
        unregisterLocalRun('run-other-local');
      }
    });
  });
});
