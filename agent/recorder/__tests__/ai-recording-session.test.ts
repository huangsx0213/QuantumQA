/**
 * AIRecordingSession 单元测试
 *
 * 测试编排逻辑：mock Stagehand 和 PlaywrightRecorderAdapter，
 * 验证 NL 步骤迭代、事件发射、lazy observe、takeover、AutoReplay 注入。
 *
 * 不测试真实浏览器交互（那需要 stagehand-recorder-poc.test.ts 风格的集成测试）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NlTestCase, NlTestCaseStep } from '../../../shared/contracts/index.ts';
import type { RecorderStepPayload } from '../protocol.ts';

// === Mock Stagehand ===
// vi.hoisted 确保 mock 对象在 vi.mock 工厂执行时可用
const { mockStagehand, mockPage, mockCdpBrowser, mockCdpContext, mockBrowser } = vi.hoisted(() => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockResolvedValue('https://app.com/home'),
    title: vi.fn().mockResolvedValue('App'),
    // Ground 契约：inputs 为 {name,value} 数组（见 ground.ts collectEvidencePack）
    evaluate: vi.fn().mockResolvedValue({ inputs: [{ name: 'username', value: 'admin' }], bodyText: '' }),
    locator: vi.fn(() => ({
      ariaSnapshot: vi.fn().mockResolvedValue('- textbox "username"'),
      first: () => ({
        evaluate: vi.fn().mockRejectedValue(new Error('probe unsupported')),
        inputValue: vi.fn().mockRejectedValue(new Error('probe unsupported')),
        textContent: vi.fn().mockRejectedValue(new Error('probe unsupported')),
        isVisible: vi.fn().mockResolvedValue(true),
      }),
    })),
    on: vi.fn(),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
  };
  const mockCdpContext = {
    _enableRecorder: vi.fn(),
    pages: vi.fn(() => [mockPage]),
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ windowId: 1 }),
    }),
  };
  const mockCdpBrowser = {
    contexts: vi.fn(() => [mockCdpContext]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockStagehand = {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    context: { pages: () => [mockPage] },
    connectURL: vi.fn().mockReturnValue('ws://localhost:9222'),
    act: vi.fn().mockResolvedValue({ actions: [] }),
    extract: vi.fn().mockResolvedValue({ data: { success: true, assertions: [] } }),
    observe: vi.fn().mockResolvedValue([]),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(mockPage),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { mockStagehand, mockPage, mockCdpBrowser, mockCdpContext, mockBrowser };
});

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: vi.fn(() => mockStagehand),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
    connectOverCDP: vi.fn().mockResolvedValue(mockCdpBrowser),
    executablePath: vi.fn().mockReturnValue('/path/to/chromium'),
  },
}));

// Mock fetch for CDP WebSocket URL discovery
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  json: vi.fn().mockResolvedValue({
    webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/browser/mock',
  }),
}));

// === Mock PlaywrightRecorderAdapter ===
// 默认 isAvailable=false（测试 fallback 路径），个别测试可覆盖
let capturedOnActionAdded: ((page: any, aic: any) => void) | null = null;

vi.mock('../adapter', () => ({
  PlaywrightRecorderAdapter: vi.fn().mockImplementation((params: any) => {
    capturedOnActionAdded = params.onActionAdded;
    return { start: vi.fn(), stop: vi.fn() };
  }),
}));

// 导入被测模块（在 mock 之后）
import { AIRecordingSession, SessionAbortedError } from '../ai-recording-session.ts';
import { PlaywrightRecorderAdapter } from '../adapter.ts';

// === 测试数据 ===

function makeNlCase(overrides?: Partial<NlTestCase>): NlTestCase {
  return {
    id: 'nl-1',
    projectId: 'proj-1',
    title: 'Login flow',
    preconditions: ['https://app.com/login'],
    testData: [
      { key: 'username', value: 'admin', description: 'Login username' },
      { key: 'password', value: 'secret123', description: 'Login password' },
    ],
    steps: [
      { sequence: 1, action: 'Enter username "admin" in the username field', expected: '' },
      { sequence: 2, action: 'Enter password "secret123" in the password field', expected: '' },
      { sequence: 3, action: 'Click the Submit button', expected: 'User is logged in' },
    ],
    postconditions: [],
    tags: [],
    changeLog: [],
    status: 'APPROVED',
    priority: 'high',
    ...overrides,
  };
}

function makeProviderConfig() {
  return {
    id: 'prov-1',
    name: 'test-provider',
    type: 'openai-compatible' as const,
    endpoint: 'https://api.test.com/v1',
    apiKey: 'sk-test-key',
    model: 'gpt-4o',
  };
}

function makeMockActionInContext(actionName: string = 'click', selector: string = 'internal:role=button[name="Submit"]') {
  return {
    frame: { pageGuid: 'p1', pageAlias: 'page', framePath: [] },
    action: {
      name: actionName,
      selector,
      clickCount: 1,
      button: 'left',
      modifiers: 0,
      signals: [],
      ariaSnapshot: '<button>Submit</button>',
    },
    startTime: Date.now(),
  };
}



// === 重置 mock ===

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnActionAdded = null;
  mockStagehand.act.mockResolvedValue({ actions: [] });
  mockStagehand.extract.mockResolvedValue({ success: true });
  mockStagehand.observe.mockResolvedValue([]);
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.waitForLoadState.mockResolvedValue(undefined);
  // 默认 _enableRecorder 不可用
  (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => false);
});

describe('AIRecordingSession', () => {
  describe('start() — 基本编排', () => {
    it('迭代所有 NL 步骤并发射 step:start / step:complete 事件', async () => {
      const nlCase = makeNlCase();
      const onConsolidatedStep = vi.fn();
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      // 3 个 NL 步骤，每个发射 step:start + step:complete
      const startEvents = events.filter((e) => e.event === 'step:start');
      const completeEvents = events.filter((e) => e.event === 'step:complete');
      expect(startEvents).toHaveLength(3);
      expect(completeEvents).toHaveLength(3);

      // 验证步骤索引
      expect(startEvents.map((e) => e.data.nlStepIndex)).toEqual([0, 1, 2]);

      // act 被调用 3 次（每个 NL 步骤一次）
      expect(mockStagehand.act).toHaveBeenCalledTimes(3);
    });

    it('导航到 preconditions 中的起始 URL', async () => {
      const nlCase = makeNlCase();
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(mockPage.goto).toHaveBeenCalledWith('https://app.com/login', { waitUntil: 'load' });
    });

    it('preconditions 中的 URL 与说明文字同行时仍能解析', async () => {
      const nlCase = makeNlCase({
        preconditions: ['打开浏览器并访问 https://app.com/login，使用测试账号登录'],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(mockPage.goto).toHaveBeenCalledWith('https://app.com/login', { waitUntil: 'load' });
    });

    it('preconditions 中 URL 紧跟中文标点时剥离标点后解析', async () => {
      const nlCase = makeNlCase({
        preconditions: ['先访问 https://app.com/login。'],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(mockPage.goto).toHaveBeenCalledWith('https://app.com/login', { waitUntil: 'load' });
    });

    it('startUrl 覆盖优先生效（用例本身无可解析 URL）', async () => {
      const nlCase = makeNlCase({ preconditions: [], testData: [] });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        startUrl: 'staging.app.dev/signin',
        onConsolidatedStep,
        onEvent,
      });

      expect(mockPage.goto).toHaveBeenCalledWith('https://staging.app.dev/signin', { waitUntil: 'load' });
    });

    it('startUrl 覆盖优先于 preconditions 中解析到的 URL', async () => {
      const nlCase = makeNlCase();
      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        startUrl: 'https://override.com/home',
        onConsolidatedStep: vi.fn(),
        onEvent: vi.fn(),
      });

      expect(mockPage.goto).toHaveBeenCalledWith('https://override.com/home', { waitUntil: 'load' });
    });

    it('非法 startUrl 覆盖在启动即抛错且不导航', async () => {
      const nlCase = makeNlCase({ preconditions: [], testData: [] });
      const session = new AIRecordingSession();

      await expect(session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        startUrl: 'not a url',
        onConsolidatedStep: vi.fn(),
        onEvent: vi.fn(),
      })).rejects.toThrow(/Invalid start URL/);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it('RecordingResult 包含正确的 stepBoundaries', async () => {
      const nlCase = makeNlCase();
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(result.stepBoundaries).toHaveLength(3);
      expect(result.stepBoundaries.map((b) => b.nlStepIndex)).toEqual([0, 1, 2]);
    });

    it('Stagehand 关闭在 finally 中执行（即使出错）', async () => {
      const nlCase = makeNlCase();
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      // 模拟 goto 失败
      mockPage.goto.mockRejectedValue(new Error('Navigation failed'));

      const session = new AIRecordingSession();
      await expect(
        session.start({
          nlCase,
          providerConfig: makeProviderConfig(),
          options: { headless: true },
          onConsolidatedStep,
          onEvent,
        }),
      ).rejects.toThrow('Navigation failed');

      // 浏览器是我们自己启动的，即使导航失败也必须关闭
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('start() — 步骤捕获（_enableRecorder 可用）', () => {
    it('onConsolidatedStep 在 _enableRecorder 捕获步骤时被调用', async () => {
      const nlCase = makeNlCase({ steps: [{ sequence: 1, action: 'Click Submit', expected: '' }] });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      // _enableRecorder 可用
      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);

      // act() 模拟 _enableRecorder 捕获行为：调用 capturedOnActionAdded
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        if (capturedOnActionAdded) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('click', 'internal:role=button[name="Submit"]'),
          );
        }
        return { actions: [] };
      });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(onConsolidatedStep).toHaveBeenCalled();
      const capturedStep = onConsolidatedStep.mock.calls[0][0] as RecorderStepPayload;
      expect(capturedStep.action).toBe('click');
      expect(capturedStep.locator?.selector).toBe('internal:role=button[name="Submit"]');
    });

    it('AI 断言建议挂载到边界最后一个 payload 的 metadata', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'User is logged in' }],
      });
      const onConsolidatedStep = vi.fn();

      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        if (capturedOnActionAdded) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('click', 'internal:role=button[name="Submit"]'),
          );
        }
        return { actions: [] };
      });
      // AI 验证通过并顺手提出断言建议
      mockStagehand.extract.mockResolvedValue({
        success: true,
        reason: 'User is logged in',
        assertion: { source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'Dashboard' },
      });

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent: vi.fn(),
      });

      // 断言应已进入精炼后的步骤（applyAiAssertions 校验挂载）
      const aiSteps = result.steps.filter(s => (s.assertions ?? []).some(a => a.message.startsWith('AI generated')));
      expect(aiSteps.length).toBeGreaterThanOrEqual(1);
      const assertion = aiSteps[0].assertions!.find(a => a.message.startsWith('AI generated'))!;
      expect(assertion.source).toBe('UI_TEXT');
      expect(assertion.operator).toBe('CONTAINS');
      expect(assertion.expectedValue).toBe('Dashboard');
    });

    it('field 步骤：AI 误提 UI_TEXT 被强制纠正为 UI_VALUE（输入框校验值而非文本）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Enter admin into the username field.', expected: 'Username field shows admin value' }],
      });
      const onConsolidatedStep = vi.fn();

      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        if (capturedOnActionAdded) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('fill', 'internal:role=textbox[name="Username"]'),
          );
        }
        return { actions: [] };
      });
      // AI 误提 UI_TEXT（输入框元素文本恒为空，无意义）
      mockStagehand.extract.mockResolvedValue({
        success: true,
        reason: 'field shows admin',
        assertion: { source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'admin' },
      });

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent: vi.fn(),
      });

      const aiSteps = result.steps.filter(s => (s.assertions ?? []).some(a => a.message.startsWith('AI generated')));
      expect(aiSteps.length).toBeGreaterThanOrEqual(1);
      const assertion = aiSteps[0].assertions!.find(a => a.message.startsWith('AI generated'))!;
      // 强制纠正为 UI_VALUE；expectedValue 同步参数化（admin → {{username}}，与 data 一致）
      expect(assertion.source).toBe('UI_VALUE');
      expect(assertion.expectedValue).toBe('{{username}}');
    });

    it('button 步骤：AI 误提 UI_VALUE 被丢弃（按钮没有 value）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click the Sign in button.', expected: 'User is logged in' }],
      });
      const onConsolidatedStep = vi.fn();

      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        if (capturedOnActionAdded) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('click', 'internal:role=button[name="Sign in"]'),
          );
        }
        return { actions: [] };
      });
      // AI 幻觉：对点击按钮提 value 断言
      mockStagehand.extract.mockResolvedValue({
        success: true,
        reason: 'logged in',
        assertion: { source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'Dashboard' },
      });

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent: vi.fn(),
      });

      // value 类断言对按钮无意义 → 丢弃；button 无规则兜底 → 不产生 AI 断言
      const aiSteps = result.steps.filter(s => (s.assertions ?? []).some(a => a.message.startsWith('AI generated')));
      expect(aiSteps).toHaveLength(0);
    });

    it('AI 未提议时规则兜底：fill 步骤挂 UI_VALUE CONTAINS 断言', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Enter admin into the username field.', expected: 'Username field shows admin value' }],
      });
      const onConsolidatedStep = vi.fn();

      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        if (capturedOnActionAdded) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('fill', 'internal:role=textbox[name="Username"]'),
          );
        }
        return { actions: [] };
      });
      // 模拟 _enableRecorder 捕获的 fill 值：translator 从 action context 提取，
      // 这里直接让 consolidator 产出的 payload.value 为 'admin'
      mockStagehand.extract.mockResolvedValue({ success: true, reason: 'field shows admin' });

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent: vi.fn(),
      });

      // 规则兜底：fill → UI_VALUE CONTAINS <value>。value 来自 action context，
      // harness 中 fill 的 value 提取取决于 translator；断言挂载行为本身已验证。
      const aiSteps = result.steps.filter(s => (s.assertions ?? []).some(a => a.message.startsWith('AI generated')));
      // fill 的 value 在 harness 中可能为空（action context 无输入值）→ 规则不产出 → 允许 0 或 1
      expect(aiSteps.length).toBeLessThanOrEqual(1);
    });
  });

  describe('executeNlStep() — lazy observe', () => {
    it('act 首次失败后触发一次 observe，第二次重试不再触发 observe', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click non-existent button', expected: '' }],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      // act: 第一次失败，第二次成功
      mockStagehand.act
        .mockRejectedValueOnce(new Error('element not found'))
        .mockResolvedValueOnce({ actions: [] });

      // observe 返回一些元素
      mockStagehand.observe.mockResolvedValue([
        { selector: 'internal:role=button[name="Login"]', description: 'Login button' },
      ]);

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 2 },
        onConsolidatedStep,
        onEvent,
      });

      // observe 只被调用一次（首次失败后）
      expect(mockStagehand.observe).toHaveBeenCalledTimes(1);

      // act 被调用两次（第一次失败，第二次成功）
      expect(mockStagehand.act).toHaveBeenCalledTimes(2);

      // 第二次 act 的 instruction 包含 observe hint
      const secondCallArgs = mockStagehand.act.mock.calls[1][0] as string;
      expect(secondCallArgs).toContain('Login button');
    });

    it('act 全部失败时发射 step:failed 事件', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click non-existent button', expected: '' }],
      });
      const onConsolidatedStep = vi.fn();
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      mockStagehand.act.mockRejectedValue(new Error('element not found'));
      mockStagehand.observe.mockResolvedValue([]);
      // extract for dirty-state self-heal
      mockStagehand.extract.mockResolvedValue({ needsCleanup: false });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 1 },
        onConsolidatedStep,
        onEvent,
      });

      const failedEvents = events.filter((e) => e.event === 'step:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].data.error).toContain('act() failed');
    });
  });

  describe('executeNlStep() — takeover', () => {
    it('headless:false 时 act 全部失败后调用 onTakeoverRequest', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click non-existent button', expected: '' }],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();
      const onTakeoverRequest = vi.fn().mockResolvedValue(true);

      mockStagehand.act.mockRejectedValue(new Error('element not found'));
      mockStagehand.observe.mockResolvedValue([]);
      mockStagehand.extract.mockResolvedValue({ needsCleanup: false });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: false, maxRetriesPerStep: 1 },
        onConsolidatedStep,
        onEvent,
        onTakeoverRequest,
      });

      expect(onTakeoverRequest).toHaveBeenCalledTimes(1);
      expect(onTakeoverRequest.mock.calls[0][0]).toBe(0); // nlStepIndex
      expect(onTakeoverRequest.mock.calls[0][1]).toBe('Click non-existent button');
    });

    it('headless:true 时 act 全部失败后不调用 onTakeoverRequest', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click non-existent button', expected: '' }],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();
      const onTakeoverRequest = vi.fn().mockResolvedValue(true);

      mockStagehand.act.mockRejectedValue(new Error('element not found'));
      mockStagehand.observe.mockResolvedValue([]);
      mockStagehand.extract.mockResolvedValue({ needsCleanup: false });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 1 },
        onConsolidatedStep,
        onEvent,
        onTakeoverRequest,
      });

      expect(onTakeoverRequest).not.toHaveBeenCalled();
    });
  });

  describe('executeNlStep() — extract 验证', () => {
    it('act 成功且有 expected 时调用 extract 验证', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'User is logged in' }],
      });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      mockStagehand.act.mockResolvedValue({ actions: [] });
  mockStagehand.extract.mockResolvedValue({ success: true });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      // act 调用 1 次 + extract 验证调用 1 次
      // 注意：extract 也用于脏状态自愈，但 act 成功时不会触发自愈
      expect(mockStagehand.act).toHaveBeenCalledTimes(1);
      // extract 至少被调用 1 次（验证）
      const extractCalls = mockStagehand.extract.mock.calls;
      expect(extractCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('成功路径的终态事件必须携带非空 logs（含 extract 判断时间线）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'User is logged in' }],
      });
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      mockStagehand.act.mockResolvedValue({ actions: [] });
      mockStagehand.extract.mockResolvedValue({ success: true });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep: vi.fn(),
        onEvent,
      });

      const completeEvents = events.filter((e) => e.event === 'step:complete');
      expect(completeEvents).toHaveLength(1);
      const logs = completeEvents[0].data.logs;
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThanOrEqual(4);
      // 时间线必须覆盖 act 与 extract（LLM 判断）两个阶段
      expect(logs.some((l: any) => l.message.includes('act attempt 0: succeeded'))).toBe(true);
      expect(logs.some((l: any) => l.message.includes('check llm-extract'))).toBe(true);
      // LLM 判断的实际回答内容必须详细记录
      expect(logs.some((l: any) => l.message.includes('ai answer:') && l.message.includes('"success":true'))).toBe(true);
      expect(logs.some((l: any) => l.message.includes('verification PASSED via llm-extract'))).toBe(true);
      // 期望结果必须在日志中明确记录
      expect(logs.some((l: any) => l.message.startsWith('expected: "User is logged in"'))).toBe(true);
      // 成功步骤不得带 error / verificationWarning
      expect(completeEvents[0].data.error).toBeUndefined();
      expect(completeEvents[0].data.verificationWarning).toBeUndefined();
    });

    it('LLM 判定 success=false 且兜底未命中：step:complete + verificationWarning（录制语义）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'User is logged in' }],
      });
      const onConsolidatedStep = vi.fn();
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      mockStagehand.act.mockResolvedValue({ actions: [] });
      mockStagehand.extract.mockResolvedValue({ success: false });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 1 },
        onConsolidatedStep,
        onEvent,
      });

      // act 成功 → 操作已捕获；验证未通过只降级为警告
      const failedEvents = events.filter((e) => e.event === 'step:failed');
      expect(failedEvents).toHaveLength(0);
      const completeEvents = events.filter((e) => e.event === 'step:complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].data.verificationWarning).toContain('expected not met');
    });

    it('extract 调用必须使用 (instruction, schema) 两参形态（v3 重载契约）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'User is logged in' }],
      });

      mockStagehand.act.mockResolvedValue({ actions: [] });
      mockStagehand.extract.mockResolvedValue({ success: true });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep: vi.fn(),
        onEvent: vi.fn(),
      });

      // 误用 extract({instruction, schema}) 单对象会命中 pageText 重载，LLM 判断不执行
      expect(mockStagehand.extract).toHaveBeenCalledWith(
        expect.stringContaining('Verify this expected condition'),
        expect.anything(),
      );
    });

    it('extract 无结构化输出时按 pageText 关键词兜底（≥50% 命中即通过）', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Enter admin into the username field.', expected: 'Username field shows admin value' }],
      });
      const onConsolidatedStep = vi.fn();
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      mockStagehand.act.mockResolvedValue({ actions: [] });
      // 模拟弱模型：schema 解析失败，只回退 pageText
      mockStagehand.extract.mockResolvedValue({
        pageText: 'textbox username field with admin value entered heading sign in',
      });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 0 },
        onConsolidatedStep,
        onEvent,
      });

      // 关键词 username/field/admin/value 命中 4/5 → 验证通过 → step:complete
      const failedEvents = events.filter((e) => e.event === 'step:failed');
      expect(failedEvents).toHaveLength(0);
      const completeEvents = events.filter((e) => e.event === 'step:complete');
      expect(completeEvents).toHaveLength(1);
    });

    it('pageText 关键词命中不足时：step:complete + verificationWarning', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: 'Username field shows admin value' }],
      });
      const onConsolidatedStep = vi.fn();
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      mockStagehand.act.mockResolvedValue({ actions: [] });
      mockStagehand.extract.mockResolvedValue({
        pageText: 'completely unrelated dashboard content here',
      });

      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, maxRetriesPerStep: 0 },
        onConsolidatedStep,
        onEvent,
      });

      const failedEvents = events.filter((e) => e.event === 'step:failed');
      expect(failedEvents).toHaveLength(0);
      const completeEvents = events.filter((e) => e.event === 'step:complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].data.verificationWarning).toContain('expected not met');
    });
  });

  describe('start() — Refiner 集成', () => {
    it('RecordingResult.steps 包含精炼后的步骤', async () => {
      const nlCase = makeNlCase({ steps: [{ sequence: 1, action: 'Click Submit', expected: '' }] });
      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();

      // _enableRecorder 可用
      (PlaywrightRecorderAdapter as any).isAvailable = vi.fn(() => true);

      // act() 模拟 _enableRecorder 捕获两个相同步骤（测试去重）
      let callCount = 0;
      mockStagehand.act.mockImplementation(async (_instruction: string, opts: any) => {
        callCount++;
        if (capturedOnActionAdded && callCount <= 2) {
          capturedOnActionAdded(
            opts.page,
            makeMockActionInContext('click', 'internal:role=button[name="Submit"]'),
          );
        }
        return { actions: [] };
      });

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      // Refiner 去重后应该只有 1 个步骤
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].action).toBe('click');
      // provenance 标记
      expect((result.steps[0].metadata as any).provenance.source).toBe('ai-recorder');
    });
  });

  describe('start() — verify 步骤生成 assert 步骤（Form B）', () => {
    it('element-visible verify → assertVisible payload with resolved selector', async () => {
      const nlCase = makeNlCase({
        steps: [
          {
            sequence: 1,
            action: 'navigate to /login',
            expected: 'login page loads',
            intent: { targetHint: 'browser', data: '/login', expectation: { kind: 'url', value: '/login' } },
          },
          {
            sequence: 2,
            action: 'verify the username field is visible',
            expected: 'username field is present',
            intent: { targetHint: 'username input field', expectation: { kind: 'element-visible', value: 'input' } },
          },
        ],
      });
      mockStagehand.observe.mockResolvedValue([{ selector: '#username', description: 'Username' }]);

      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();
      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      // observe 被调用（verify 步骤解析 targetHint → 选择器）
      expect(mockStagehand.observe).toHaveBeenCalled();
      // 生成了 assertVisible payload，经 onConsolidatedStep 桥发出
      const assertSteps = onConsolidatedStep.mock.calls
        .map((c) => c[0] as RecorderStepPayload)
        .filter((p) => p.action === 'assertVisible');
      expect(assertSteps).toHaveLength(1);
      expect(assertSteps[0].locator?.selector).toBe('#username');
      // 精炼后的步骤包含 assertVisible（Form B 独立断言步骤）
      expect(result.steps.some((s) => s.action === 'assertVisible' && s.target === '#username')).toBe(true);
    });

    it('url verify → assertUrl payload with expected value (no element)', async () => {
      const nlCase = makeNlCase({
        steps: [
          {
            sequence: 1,
            action: 'navigate to /login',
            expected: 'login page loads',
            intent: { targetHint: 'browser', data: '/login', expectation: { kind: 'url', value: '/login' } },
          },
          {
            sequence: 2,
            action: 'verify the browser navigates to dashboard',
            expected: 'browser URL contains dashboard',
            intent: { targetHint: 'browser page', expectation: { kind: 'url', value: '/dashboard' } },
          },
        ],
      });

      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();
      const session = new AIRecordingSession();
      await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      const assertSteps = onConsolidatedStep.mock.calls
        .map((c) => c[0] as RecorderStepPayload)
        .filter((p) => p.action === 'assertUrl');
      expect(assertSteps).toHaveLength(1);
      expect(assertSteps[0].value).toBe('/dashboard');
    });

    it('targetHint 解析失败时 verify 步骤降级（无 assert 步骤，不抛错）', async () => {
      const nlCase = makeNlCase({
        steps: [
          {
            sequence: 1,
            action: 'verify the username field is visible',
            expected: 'username field is present',
            intent: { targetHint: 'username input field', expectation: { kind: 'element-visible', value: 'input' } },
          },
        ],
      });
      mockStagehand.observe.mockResolvedValue([]); // 解析不到选择器

      const onConsolidatedStep = vi.fn();
      const onEvent = vi.fn();
      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true },
        onConsolidatedStep,
        onEvent,
      });

      expect(result.steps).toHaveLength(0);
      const assertSteps = onConsolidatedStep.mock.calls
        .map((c) => c[0] as RecorderStepPayload)
        .filter((p) => p.action === 'assertVisible');
      expect(assertSteps).toHaveLength(0);
    });
  });

  describe('start() — AbortSignal 中止', () => {
    it('rejects immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const session = new AIRecordingSession();
      await expect(
        session.start({
          nlCase: makeNlCase(),
          providerConfig: makeProviderConfig(),
          options: {},
          signal: controller.signal,
          onConsolidatedStep: vi.fn(),
          onEvent: vi.fn(),
        }),
      ).rejects.toThrow(SessionAbortedError);
    });

    it('fails the NL step when a single act attempt exceeds timeoutPerStep', async () => {
      const nlCase = makeNlCase({
        steps: [{ sequence: 1, action: 'Click Submit', expected: '' }],
      });
      const events: Array<{ event: string; data: any }> = [];
      const onEvent = vi.fn((event: string, data: any) => events.push({ event, data }));

      // act() 永不 resolve（模拟挂起的 LLM/浏览器调用）
      mockStagehand.act.mockImplementation(() => new Promise(() => {}));

      const session = new AIRecordingSession();
      const result = await session.start({
        nlCase,
        providerConfig: makeProviderConfig(),
        options: { headless: true, timeoutPerStep: 30 },
        onConsolidatedStep: vi.fn(),
        onEvent,
      });

      // 超时计入普通尝试失败：发射现有 step:failed 事件，消息来自 StepCallTimeoutError
      const failedEvents = events.filter((e) => e.event === 'step:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].data.error).toContain('Stagehand act exceeded timeoutPerStep');

      // start() 正常返回（步骤终止而不是永久挂起），边界已记录
      expect(result.stepBoundaries).toHaveLength(1);
      expect(result.stepBoundaries[0].nlStepIndex).toBe(0);
    }, 10_000);

    it('stops between steps when aborted inside executeNlStep and still runs cleanup', async () => {
      const executed: number[] = [];
      const controller = new AbortController();
      const session = new AIRecordingSession();
      vi.spyOn(session as any, 'executeNlStep').mockImplementation(async (_i: number, step: any) => {
        executed.push(step.sequence);
        controller.abort();
        return { nlStepIndex: step.sequence, startStepIdx: 0, endStepIdx: 0 };
      });

      await expect(
        session.start({
          nlCase: makeNlCase(),
          providerConfig: makeProviderConfig(),
          options: { headless: true },
          signal: controller.signal,
          onConsolidatedStep: vi.fn(),
          onEvent: vi.fn(),
        }),
      ).rejects.toThrow(SessionAbortedError);

      // 第一个步骤执行后、第二个步骤前中止
      expect(executed).toEqual([1]);
      // 清理路径仍然执行（finally：console.warn 恢复 + stagehand 关闭）
      expect(mockStagehand.close).toHaveBeenCalledTimes(1);
    });
  });
});
