/**
 * AIRecordingSession  — ?AI 驱动录制核心
 *
 * 整合 Stagehand (act/extract/observe) + PlaywrightRecorderAdapter (_enableRecorder)
 * + StepConsolidator + Refiner，实现从自然语言测试用例到可回放 draft suite 的完整流程 — ?
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §3.1
 *
 * 执行流程 — ?
 *   1. Stagehand init (verbose:0, 安全优先) + _enableRecorder 挂载
 *   2. 导航到起 — ?URL
 *   3.  — ?NL step: act() + lazy observe + extract() 验证 + _enableRecorder 捕获
 *   4. Flush consolidator  — ?Refiner 纯代码管道精 — ?
 *   5. 清理 Stagehand
 *
 * AutoReplay（第 6.5 步）已禁用：原设计在 Refiner 后执 — ?3 次回 — ?+ flaky 检测，
 * 因环境不稳定暂时关闭，恢复时取消 start() 方法中的对应注释即可 — ?
 *
 * Stagehand 通过动 — ?import 加载（@browserbasehq/stagehand 类型声明缺失，预存在问题） — ?
 */

import { z } from 'zod';
import type { Page, BrowserContext, Browser } from 'playwright';
import { chromium } from 'playwright';
import { PlaywrightRecorderAdapter } from './adapter.ts';
import { StepConsolidator } from './consolidation.ts';
import { translateAction } from './translator.ts';
import { refineDraftSuite, extractSecretValues, type RefinerOptions, type AiAssertionProposal } from './refiner.ts';
import { buildStepDescription } from './recording-bridge.ts';
import { collectEvidencePack, formatLegacyEnrichment, type EvidencePack } from './ground.ts';
import { deriveRuleProposals, findCoveringRule } from './compile/rules.ts';
import { createStagehandProposer, type ProposerAdapter } from './compile/proposer.ts';
import { passesGate, type GateProposal } from './compile/gate.ts';
import { getExpectationMapping, parseActionVerb, resolveIntentData, type NlStepIntent } from '../../shared/recording/nl-intent.ts';
import type { RecorderStepPayload, LocatorRef } from './protocol.ts';
import type {
  TestStep,
  TestCase,
  TestSuite,
  NlTestCase,
  NlTestCaseStep,
} from '../../shared/contracts/index.ts';
import type { DecryptedProviderConfig } from '../../shared/recording/protocol.ts';
import { findCaseStartUrl, normalizeExplicitStartUrl } from '../../shared/recording/start-url.ts';

// === 对外导出的类型（auto-replay.ts 会导 — ?ReplayReport 等类型）===

export interface NlStepBoundary {
  nlStepIndex: number;
  startStepIdx: number;
  endStepIdx: number;
}

/** 外部中止（AI_RECORDER_STOP）时 — ?start() 抛出，控制层据此上报"用户中止"而非错误 */
export class SessionAbortedError extends Error {
  constructor() {
    super('AI recording session aborted');
    this.name = 'SessionAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionAbortedError();
}

/** options.timeoutPerStep 缺省/非法时的单次 Stagehand 调用超时上限 */
const DEFAULT_TIMEOUT_PER_STEP_MS = 120_000;

/** 单次 Stagehand 调用（act/observe/extract）超 — ?timeoutPerStep 时抛出，按普通尝试失败计入重 — ?*/
class StepCallTimeoutError extends Error {
  constructor(op: string) {
    super(`Stagehand ${op} exceeded timeoutPerStep`);
    this.name = 'StepCallTimeoutError';
  }
}

export interface AIRecordingSessionParams {
  nlCase: NlTestCase;
  providerConfig: DecryptedProviderConfig;
  options: {
    headless?: boolean;
    maxRetriesPerStep?: number;
    timeoutPerStep?: number;
    /**
     * 编译管线（docs/07 §4-C）：规则层 → 覆盖裁决 → AI 提议 → 编译门。
     * 默认 false 走旧路径（行为零变更）；开启后断言生成与验证分离，
     * 规则可覆盖时不调 LLM，AI 不确定时只记日志不落库。
     * 确认回放（阶段 D）由 Server 端在会话结束后执行，Agent 不参与。
     */
    enableCompilePipeline?: boolean;
  };
  /** 中止信号：AI_RECORDER_STOP 触发 AbortController.abort() 后，session 在步骤边界终 — ?*/
  signal?: AbortSignal;
  /** 每个 consolidated step 的回调，由外部桥接层（RecordingBridge）负 — ?step+element 双发 — ?*/
  onConsolidatedStep: (step: RecorderStepPayload) => void;
  /** 生命周期事件回调（step:start / step:complete / step:failed / step:observe / recorder:fallback 等） */
  onEvent: (event: string, data: any) => void;
  /** Takeover 请求回调，仅 headless:false 时有 — ?*/
  onTakeoverRequest?: (nlStepIndex: number, instruction: string) => Promise<boolean>;
  /**
   * 显式起始 URL 覆盖。提供时跳过 — ?preconditions/testData 解析 — ?
   * 缺少协议时自动补 https://；非法值在会话启动即抛错 — ?
   */
  startUrl?: string;
  /**
   * AutoReplay 注入函数（可选） — ?
   * 不提供则使用默认 — ?autoReplayDraftSuite — ? 次回 — ?+ flaky 检测） — ?
   * 解耦设计：可通过 autoReplayFn 注入 mock，便于独立测试 — ?
   */
  autoReplayFn?: (suite: TestSuite, opts: { page: Page; startUrl: string }) => Promise<ReplayReport>;
}

export interface RecordingResult {
  steps: TestStep[];
  stepBoundaries: NlStepBoundary[];
  replayCandidateSuite: Partial<TestSuite>;
  replayReport?: ReplayReport;
}

// === ReplayReport 类型（Task 6  — ?auto-replay.ts 导入这些类型 — ?==

export type ReplayVerdict = 'pass' | 'fail' | 'flaky';

export interface SingleReplayResult {
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  stepResults: Array<{
    stepIndex: number;
    action: string;
    target: string;
    passed: boolean;
    error?: string;
  }>;
  durationMs: number;
}

export interface ReplayReport {
  runs: number;
  passCount: number;
  failCount: number;
  verdict: ReplayVerdict;
  results: SingleReplayResult[];
  overallPass: boolean;
  totalDurationMs: number;
  degraded?: boolean;
}

// === extract() 简化断言 schema ===
// success = AI 判断结论；reason = AI 给出的判断理由（实际观察到了什么） — ?
// 两者都会写入步骤日志，构成"期望 vs 实际"对照 — ?
// assertion = AI 顺手提出的结构化断言建议（验证时页面状态新鲜，零额外调用） — ?
//  — ?refiner 校验后挂载到 TestStep.assertions — ?
//  — ?schema 解析失败时，回退 — ?pageText 文本匹配 — ?
const EXTRACT_ASSERTION_SCHEMA = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
  assertion: z.object({
    source: z.enum([
      'UI_TEXT', 'UI_VALUE', 'UI_ATTRIBUTE', 'UI_PAGE_URL', 'UI_PAGE_TITLE',
      'UI_ELEMENT_VISIBLE', 'UI_ELEMENT_ENABLED', 'UI_ELEMENT_CHECKED', 'UI_ELEMENT_COUNT',
    ]),
    operator: z.enum(['EQUALS', 'CONTAINS', 'NOT_EQUALS', 'NOT_CONTAINS', 'EXISTS', 'MATCHES_REGEX']),
    expectedValue: z.string().optional(),
  }).optional(),
});

// === 辅助函数 ===

/**
 *  — ?NlTestCase 解析起始 URL（共享规则见 shared/recording/start-url.ts） — ?
 * 显式覆盖优先；否则回退 — ?preconditions / testData 解析，找不到抛可读错误 — ?
 */
function resolveRunStartUrl(nlCase: NlTestCase, override?: string): string {
  if (override != null) return normalizeExplicitStartUrl(override);
  const found = findCaseStartUrl(nlCase);
  if (!found) {
    throw new Error(
      `Cannot resolve startUrl from NlTestCase ${nlCase.id}: no URL found in preconditions or testData. ` +
        `Add a URL to preconditions or testData with key containing "url", or set a Start URL override in the recorder config.`,
    );
  }
  return found;
}

/**
 * 规则兜底断言：AI 未提出建议时，从边界内实际录制的 payload 确定性推导 — ?
 * - 最后一 — ?fill/selectOption  — ?UI_VALUE CONTAINS 实际输入值（回放时断言输入框内容）
 * - goto  — ?UI_PAGE_URL CONTAINS 实际跳转地址
 */
function ruleBasedAssertion(payloads: RecorderStepPayload[]): AiAssertionProposal | null {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i];
    if ((p.action === 'fill' || p.action === 'selectOption') && p.value) {
      return { source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: p.value };
    }
  }
  const goto = payloads.find(p => p.action === 'goto' && p.value);
  if (goto) return { source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: goto.value };
  return null;
}

/** 页面级断言 source 集合——不需要元素依托，verify 步骤可直接使用 */
const PAGE_LEVEL_SOURCES = new Set(['UI_PAGE_URL', 'UI_PAGE_TITLE', 'UI_TEXT']);

/**
 * 从 NlStepIntent 的结构化期望确定性推导断言提议（零 LLM）。
 * 旧路径（compilePipeline=false）下 verify/waitFor 步骤的唯一断言来源。
 * - 页面级期望（url/title/text-visible）：直接生成，无需元素依托
 * - api-body：生成 API_BODY_JSON（需配合 waitForNetwork 捕获响应体）
 * - element-visible/value/attribute/element-state：需要元素依托，旧路径无法提供，跳过
 * - network：不生成 StepAssertion，由 mounting 块的 waitForNetwork 配置处理
 * - transient：生成期即拒绝
 */
function intentBasedAssertion(
  intent: NlStepIntent | undefined,
  expected: string,
): AiAssertionProposal | null {
  if (!intent?.expectation) return null;
  const { kind, value, expression } = intent.expectation;
  if (!kind || kind === 'transient' || kind === 'network') return null;

  if (kind === 'api-body') {
    return {
      source: 'API_BODY_JSON',
      operator: 'CONTAINS',
      expectedValue: value,
      expression,
      origin: 'rule',
      confidence: 1,
      expectedText: expected,
    };
  }

  const mapping = getExpectationMapping(kind);
  if (mapping.sources.length === 0) return null;
  const source = mapping.sources[0];
  if (!PAGE_LEVEL_SOURCES.has(source)) return null;

  return {
    source,
    operator: 'CONTAINS',
    expectedValue: value,
    origin: 'rule',
    confidence: 1,
    expectedText: expected,
  };
}

export type NlStepKind = 'field' | 'navigation' | 'button' | 'generic';

/**
 *  — ?NL 步骤动作文本推断步骤种类，决定合法的断言 source — ?
 *   field       — ?输入框操作（enter/type/fill/select...）→ 只允 — ?UI_VALUE
 *   navigation  — ?页面跳转（navigate/go to/open...）→ 只允 — ?UI_PAGE_URL
 *   button      — ?按钮点击（click/tap/submit...）→ 禁止 value 类，允许页面级证 — ?
 */
function inferNlStepKind(action: string): NlStepKind {
  const a = action.toLowerCase();
  if (/\b(enter|type|input|fill|select|choose|check|toggle|upload)\b/.test(a)) return 'field';
  if (/\b(navigate|go to|open|visit|redirect)\b/.test(a)) return 'navigation';
  if (/\b(click|tap|press|submit|confirm)\b/.test(a)) return 'button';
  return 'generic';
}

/**
 * 按步骤种类规范化 AI 断言建议 — ?
 * - field：输入框的元素文本恒为空，UI_TEXT 无意 — ? — ?强制 UI_VALUE
 * - navigation：跳转类预期只能 — ?URL 断言  — ?强制 UI_PAGE_URL
 * - button/generic：按钮没 — ?value，value  — ?source  — ?AI 幻觉  — ?丢弃
 * 返回 null 表示该建议不可用（调用方走规则兜底或跳过） — ?
 */
function normalizeAssertionForKind(
  proposal: AiAssertionProposal,
  kind: NlStepKind,
): AiAssertionProposal | null {
  if (kind === 'field') {
    return { ...proposal, source: 'UI_VALUE' };
  }
  if (kind === 'navigation') {
    return { ...proposal, source: 'UI_PAGE_URL' };
  }
  if (kind === 'button' || kind === 'generic') {
    const pageLevel = new Set(['UI_PAGE_URL', 'UI_PAGE_TITLE', 'UI_TEXT', 'UI_ELEMENT_VISIBLE']);
    return pageLevel.has(proposal.source) ? proposal : null;
  }
  return proposal;
}

/**
 * 从验证上下文（collectVerificationText 产出 — ?"name: value" 行）提取实际输入值 — ?
 * 启发式：取最后一个非空值——刚被操作的输入框通常是最近交互的那个 — ?
 */
function lastFilledValue(enrichment: string): string | null {
  if (!enrichment) return null;
  const values = enrichment
    .split('\n')
    .map(line => line.split(':').slice(1).join(':').trim())
    .filter(v => v.length > 0);
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * 构建 Stagehand 模型名称 — ?provider/model" 格式） — ?
 * Stagehand v3 要求 provider 前缀：openai/、azure/、anthropic/、google/
 */
function buildStagehandModelName(config: DecryptedProviderConfig): string {
  switch (config.type) {
    case 'azure-openai':
      // Azure 模型 — ?= deployment  — ?
      return `azure/${config.deployment ?? config.model}`;
    case 'anthropic':
      return `anthropic/${config.model}`;
    case 'google':
      return `google/${config.model}`;
    case 'openai-compatible':
    default:
      return `openai/${config.model}`;
  }
}

/**
 * 构建 Stagehand modelClientOptions（API key、endpoint、apiVersion 等） — ?
 */
function buildModelClientOptions(config: DecryptedProviderConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = { apiKey: config.apiKey };
  if (config.endpoint) {
    opts.baseURL = config.endpoint;
  }
  if (config.apiVersion) {
    opts.apiVersion = config.apiVersion;
  }
  if (config.type === 'azure-openai') {
    // @ai-sdk/azure 默认拼接 ${baseURL}/v1，但 Azure OpenAI 真实路径 — ?
    // /openai/deployments/{deployment}/chat/completions（与 ai test gen  — ?provider.ts 一致） — ?
    opts.baseURL = `${config.endpoint.replace(/\/+$/, '')}/openai`;
    opts.useDeploymentBasedUrls = true;
  }
  return opts;
}

/**
 *  — ?refinedSteps 构建 suite skeleton，供 AutoReplay 消费 — ?
 */
function buildSuiteSkeleton(nlCase: NlTestCase, refinedSteps: TestStep[]): TestSuite {
  const caseId = `ai-case-${nlCase.id}`;
  const suiteId = `ai-suite-${nlCase.id}`;
  const testCase: TestCase = {
    id: caseId,
    name: nlCase.title,
    description: nlCase.title,
    steps: refinedSteps,
  };
  return {
    id: suiteId,
    projectId: nlCase.projectId,
    name: `AI Generated Suite - ${nlCase.title}`,
    description: `Auto-generated from NlTestCase ${nlCase.id}`,
    cases: [testCase],
  };
}

/**
 *  — ?RecorderStepPayload 转为 TestStep（Refiner 输入格式） — ?
 * 复用 recording-bridge.ts  — ?buildStepDescription 保持描述一致 — ?
 */
function payloadToTestStep(payload: RecorderStepPayload): TestStep {
  const locator = payload.locator;
  const meta = (payload.metadata ?? {}) as any;
  return {
    id: `step-${Math.random().toString(36).slice(2, 10)}`,
    action: payload.action,
    target: payload.action === 'goto' ? (payload.value || '') : (locator?.selector ?? ''),
    data: payload.value || '',
    description: buildStepDescription(payload.action, locator, payload.value),
    isVerified: true,
    // AI 生成 — ?API 断言（录制期间捕获的 XHR/Fetch  — ?waitForNetwork 期望 — ?
    ...(meta.waitForNetwork ? { waitForNetwork: { ...meta.waitForNetwork, extractors: meta.waitForNetwork.extractors ?? [] } } : {}),
    metadata: {
      recorder: {
        locator,
        locatorCandidates: payload.locatorCandidates,
        framePath: (payload.metadata?.framePath as string[]) || [],
        pageUrl: payload.pageUrl,
        timestamp: payload.timestamp,
      },
      // AI 断言建议（refiner.applyAiAssertions 校验后转 — ?StepAssertion — ?
      ...((payload.metadata as any)?.aiAssertion
        ? { aiAssertion: (payload.metadata as any).aiAssertion }
        : {}),
    },
  };
}

// === AIRecordingSession ===

export class AIRecordingSession {
  private stagehand: any | null = null;
  private consolidator = new StepConsolidator();
  private recordedSteps: RecorderStepPayload[] = [];
  /** 原始 payload 流（未经 consolidator 缓冲），按 nlStepIndex 分组——Ground 的元素清单来源 */
  private rawPayloadsByNlStep = new Map<number, RecorderStepPayload[]>();
  /** 各 NL 步骤边界采集的证据包，flush 后随断言一起挂载到最后一条 payload */
  private evidenceByNlStep = new Map<number, EvidencePack>();
  /** 编译管线开关与 AI 裁决 Seam（start 时装配） */
  private compilePipeline = false;
  private proposer: ProposerAdapter | null = null;
  private stepBoundaries: NlStepBoundary[] = [];
  private isHeadless = false;
  private timeoutMs = DEFAULT_TIMEOUT_PER_STEP_MS;
  /** 验证通过 — ?AI 顺手提出的断言建议，flush 后挂载到对应边界最后一 — ?payload */
  private pendingAssertions = new Map<number, AiAssertionProposal>();
  /** 当前正在执行 — ?NL 步骤索引 — ?-based），onActionAdded 产出 payload 时打 — ?*/
  private currentNlStepIndex = -1;
  /** NL 用例的 testData 键值对——用于解析 intent.data 里的 ${key} 引用 */
  private testDataParams: Record<string, string> = {};
  /** 录制期间捕获 — ?XHR/Fetch API 调用（按 NL 步骤打标），用于生成 API 断言（waitForNetwork — ?*/
  private capturedApis: Array<{
    nlStepIndex: number;
    method: string;
    url: string;
    status: number;
    responseBody?: string;
    capturedAt: number;
  }> = [];
  /** consolidated payload 回调（与 start() 的 onConsolidatedStep 同一实例），verify 生成的 assert 步骤也走此桥 */
  private onConsolidatedStep?: (step: RecorderStepPayload) => void;

  async start(params: AIRecordingSessionParams): Promise<RecordingResult> {
    const { nlCase, providerConfig, options, onConsolidatedStep, onEvent } = params;
    this.isHeadless = options.headless === true;
    this.timeoutMs = options.timeoutPerStep && options.timeoutPerStep > 0
      ? options.timeoutPerStep
      : DEFAULT_TIMEOUT_PER_STEP_MS;
    const maxRetries = options.maxRetriesPerStep ?? 2;
    this.pendingAssertions.clear();
    this.capturedApis = [];
    this.rawPayloadsByNlStep.clear();
    this.evidenceByNlStep.clear();
    this.currentNlStepIndex = -1;
    this.onConsolidatedStep = onConsolidatedStep;
    this.testDataParams = Object.fromEntries(
      (nlCase.testData ?? []).map((td) => [td.key, td.value]),
    );

    // Suppress AI SDK System messages warning (Stagehand passes system prompts in messages array)
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('allowSystemInMessages')) return;
      originalWarn.apply(console, args);
    };

    // 1. 自己启动浏览器（完全控制：最大化 + viewport null）
    //    不让 Stagehand 启动浏览器——Stagehand 会锁死视口在 1280x720。
    //    我们自己 launch + newContext({viewport:null}) + --start-maximized
    //    页面内容自然铺满最大化窗口。
    let executablePath: string | undefined;
    let browser: Browser | null = null;
    let adapter: PlaywrightRecorderAdapter | null = null;
    let cdpBrowser: Browser | null = null;
    let cdpContext: BrowserContext | null = null;
    try {
      executablePath = chromium.executablePath();
    } catch {
      // Fallback: let chrome-launcher find it
    }

    const DEBUG_PORT = 19222;
    try {
      browser = await chromium.launch({
        headless: this.isHeadless,
        args: [
          ...(this.isHeadless ? [] : ['--start-maximized']),
          `--remote-debugging-port=${DEBUG_PORT}`,
        ],
        ...(executablePath ? { executablePath } : {}),
      });
      const browserContext = await browser.newContext({ viewport: null });
      const page: Page = await browserContext.newPage();

    // 2. 解析起始 URL（校验提前：非法 URL 启动即抛错）
    throwIfAborted(params.signal);
    const startUrl = resolveRunStartUrl(nlCase, params.startUrl);

    // 3. 获取 CDP WebSocket URL，创建 Stagehand 连接到我们的浏览器
    //    Stagehand 不再启动自己的浏览器，而是通过 cdpUrl 连接到我们的。
    const debugRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const { webSocketDebuggerUrl: cdpUrl } = await debugRes.json() as { webSocketDebuggerUrl: string };

    const { Stagehand } = await import('@browserbasehq/stagehand');
    const modelName = buildStagehandModelName(providerConfig);
    console.log('[AI_SESSION] model:', modelName, 'endpoint:', providerConfig.endpoint);
    this.stagehand = new Stagehand({
      env: 'LOCAL' as const,
      verbose: 0,
      model: {
        modelName: modelName as any,
        ...buildModelClientOptions(providerConfig),
      },
      localBrowserLaunchOptions: { cdpUrl },
    });
    await this.stagehand.init();

    // 编译管线装配（Seam：AI 裁决 adapter 复用 withStepTimeout 超时保护）
    this.compilePipeline = options.enableCompilePipeline === true;
    this.proposer = this.compilePipeline
      ? createStagehandProposer(this.stagehand, (op, p) => this.withStepTimeout(op, p))
      : null;

    // 4. 挂载 _enableRecorder + 网络监视
    //    我们自己启动的浏览器，直接连接 CDP 挂载 _enableRecorder。
    //    网络监视挂在我们自己的 page 上（真实 Playwright page，支持所有事件）。
    try {
      cdpBrowser = await chromium.connectOverCDP({ wsEndpoint: cdpUrl });
      cdpContext = cdpBrowser.contexts()[0];
    } catch (err: any) {
      console.warn('[AI_SESSION] CDP connectOverCDP failed:', err?.message);
    }

    // 网络监视：捕获 XHR/Fetch 调用，按 NL 步骤打标，
    // 用于生成 API 断言（waitForNetwork）与步骤日志。
    // 我们的 page 是真实 Playwright page（自己 launch 的），直接支持 requestfinished。
    page.on('requestfinished', async (req) => {
      try {
        if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
        if (req.method() === 'OPTIONS') return;
        const nlStepIndex = this.currentNlStepIndex;
        const method = req.method();
        const response = await req.response();
        const status = response ? response.status() : 0;
        if (status === 0) return;
        let responseBody: string | undefined;
        if (response && ['POST', 'PUT', 'PATCH'].includes(method)) {
          try {
            const text = await response.text();
            responseBody = text.length > 10_000 ? text.slice(0, 10_000) : text;
          } catch { /* 响应体不可读 */ }
        }
        this.capturedApis.push({
          nlStepIndex,
          method,
          url: req.url(),
          status,
          responseBody,
          capturedAt: Date.now(),
        });
        // 实时网络日志（类似 Run Test）：请求完成即打印，不再等步骤结束
        try {
          const url = new URL(req.url());
          const pathname = url.pathname.length > 60 ? url.pathname.slice(0, 57) + '...' : url.pathname;
          const logMsg = `[net] ${method} ${pathname} → ${status}`;
          console.log(logMsg);
          // 同时写入步骤日志，step:complete 时随时间线一并上报
        } catch { /* URL 解析失败不阻断 */ }
      } catch {
        // 网络捕获失败不阻断录制
      }
    });

    if (cdpContext && PlaywrightRecorderAdapter.isAvailable(cdpContext)) {
      adapter = new PlaywrightRecorderAdapter({
        onActionAdded: (_page, actionInContext) => {
          const step = translateAction(actionInContext);
          if (!step) return;
          if (!step.pageUrl) step.pageUrl = _page.url();
          // 打标当前 NL 步骤索引：payload 经 consolidator 流式缓冲，
          // 必须在进 consolidator 前打标，断言挂载按此标记分组
          step.metadata = { ...(step.metadata ?? {}), nlStepIndex: this.currentNlStepIndex };
          // 原始流另存（consolidator 会缓冲 click/fill，验证时刻边界 payload 未必已产出）
          if (!this.rawPayloadsByNlStep.has(this.currentNlStepIndex)) this.rawPayloadsByNlStep.set(this.currentNlStepIndex, []);
          this.rawPayloadsByNlStep.get(this.currentNlStepIndex)!.push(step);
          for (const consolidated of this.consolidator.add(step)) {
            this.recordedSteps.push(consolidated);
            onConsolidatedStep(consolidated);
          }
        },
      });
      adapter.start(cdpContext);
    } else {
      // fallback：_enableRecorder 不可用时，act() 仍执行但步骤不被捕获
      onEvent('recorder:fallback', { reason: '_enableRecorder not available' });
    }

    // 3. 导航到起始页面
    //    必须在挂载 _enableRecorder 之后：导航事件会被录制成 goto 步骤（打开 URL）
    throwIfAborted(params.signal);
    console.log('[AI_SESSION] Navigating to startUrl:', startUrl);
    await page.goto(startUrl, { waitUntil: 'load' });
    console.log('[AI_SESSION] Navigation complete. currentUrl:', page.url());

    throwIfAborted(params.signal);

    // 4. 逐步骤执 — ?
      const sortedSteps = [...nlCase.steps].sort((a, b) => a.sequence - b.sequence);
      for (let i = 0; i < sortedSteps.length; i++) {
        // 每个步骤边界检查中止信号，保证 STOP 能终止剩余步 — ?
        throwIfAborted(params.signal);
        const boundary = await this.executeNlStep(
          i,
          sortedSteps[i],
          page,
          onEvent,
          maxRetries,
          params.onTakeoverRequest,
        );
        this.stepBoundaries.push(boundary);
      }

      // 中止后不 — ?flush consolidator（避免把半途状态落库）
      throwIfAborted(params.signal);

      // 5. Flush consolidator
      for (const flushed of this.consolidator.flush()) {
        this.recordedSteps.push(flushed);
        onConsolidatedStep(flushed);
      }

      // 5.5 AI 断言挂载：优先验证时 AI 顺手提出的建议，否则规则兜底
      //     （fill/selectOption  — ?UI_VALUE CONTAINS 实际值；goto  — ?UI_PAGE_URL CONTAINS 实际 URL） — ?
      //     挂到 — ?NL 步骤最后一 — ?payload  — ?metadata，由 refiner  — ?applyAiAssertions 校验落库 — ?
      //     分组依据 — ?payload 上的 nlStepIndex 标记（boundary 在流 — ?consolidator 下不可靠） — ?
      //
      // 5.6 API 断言（waitForNetwork）：该步骤期间捕获的 XHR/Fetch  — ?记录到步骤日志，
      //     并在最后一 — ?payload 上生 — ?waitForNetwork 期望（urlPattern/method/expectedStatus），
      //     回放 — ?ui-executor  — ?page.waitForResponse 校验——即 API 层断言 — ?
      {
        const nlIndexes = new Set<number>(this.stepBoundaries.map(b => b.nlStepIndex));
        for (const idx of this.pendingAssertions.keys()) nlIndexes.add(idx);
        for (const idx of this.capturedApis.map(a => a.nlStepIndex)) nlIndexes.add(idx);

        // 辅助：找 idx 或其前面最近的有 payload 的步骤索引（flush 后 payload 已全部就位）
        const findWithPayloads = (idx: number): { idx: number; payloads: RecorderStepPayload[] } => {
          for (let i = idx; i >= 0; i--) {
            const group = this.recordedSteps.filter(p => (p.metadata as any)?.nlStepIndex === i);
            if (group.length > 0) return { idx: i, payloads: group };
          }
          return { idx, payloads: [] };
        };

        for (const idx of nlIndexes) {
          // 无元素依托的步骤（如"等待响应"）向前归附到最近的按钮/输入步骤
          const { idx: targetIdx, payloads: groupPayloads } = findWithPayloads(idx);
          if (groupPayloads.length === 0) continue;
          const last = groupPayloads[groupPayloads.length - 1];
          const lastMeta = (last.metadata ?? {}) as any;

          // 断言挂载（AI 建议 > 规则兜底）。
          // 编译管线的提议带 targetPayloadIndex——精准落到它依托的 payload
          // （回放时该步骤的 target 即被观测元素）；旧路径无此字段，仍挂最后一条。
          const proposal = this.pendingAssertions.get(idx);
          const assertion = proposal ?? ruleBasedAssertion(groupPayloads);
          if (assertion) {
            const bindIdx = (assertion as any).targetPayloadIndex;
            const holder = (typeof bindIdx === 'number' && groupPayloads[bindIdx]) ? groupPayloads[bindIdx] : last;
            const holderMeta = ((holder.metadata ?? {}) as any);
            holderMeta.aiAssertion = assertion;
            const evidence = this.evidenceByNlStep.get(idx) ?? this.evidenceByNlStep.get(targetIdx);
            if (evidence) holderMeta.evidence = evidence;
            holder.metadata = holderMeta;
            const originTag = proposal ? `(${(proposal as any).origin ?? 'ai'})` : '(fallback)';
            console.log(`[ASSERT|step:${idx}${holder !== last ? `:bind${bindIdx}` : ''}→${targetIdx}] ${assertion.source} ${assertion.operator} "${assertion.expectedValue ?? ''}" ${originTag}`);
          }

          // API 断言：优先写操作，否则该步骤最后一个捕获的调用
          const stepApis = this.capturedApis.filter(a => a.nlStepIndex === idx);
          if (stepApis.length > 0) {
            const preferred =
              stepApis.find(a => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method)) ??
              stepApis[stepApis.length - 1];
            let pathname = preferred.url;
            try { pathname = new URL(preferred.url).pathname; } catch { /* keep raw */ }
            if (pathname.length > 1) {
              lastMeta.waitForNetwork = {
                enabled: true,
                urlPattern: pathname,
                method: preferred.method,
                expectedStatus: preferred.status,
                timeoutMs: 10000,
                extractors: [],
              };
              console.log(`[ASSERT|step:${idx}→${targetIdx}] waitForNetwork ${preferred.method} ${pathname} → ${preferred.status}`);
            }
          }
          last.metadata = lastMeta;
        }
        this.pendingAssertions.clear();
        this.capturedApis = [];
      }

      // 6. Refine（纯代码管道：去 — ? — ?断言映射  — ?AI 断言挂载  — ?参数 — ? — ?密码脱敏  — ?选择器展开  — ?Provenance — ?
      const refinerOptions: RefinerOptions & { runId: string } = {
        runId: nlCase.id,
        secrets: extractSecretValues(nlCase.testData),
        parameters: Object.fromEntries(nlCase.testData.map((td) => [td.key, td.value])),
      };
      const refined = refineDraftSuite(
        this.recordedSteps.map(payloadToTestStep),
        refinerOptions,
      );

      // 7. Confirm（阶段 D）已迁移至 Server 端：录制会话结束（浏览器关闭）后，
      //    由 finalize-run 用生产执行引擎对 Draft Suite 无头回放确认（docs/07）。
      //    Agent 仅上报带临时断言 + provenance 的 refined steps。
      const finalSteps = refined.steps;

      const suiteSkeleton = buildSuiteSkeleton(nlCase, finalSteps);

      return {
        steps: finalSteps,
        stepBoundaries: this.stepBoundaries,
        replayCandidateSuite: suiteSkeleton,
      };
    } finally {
      // 恢复 console.warn
      console.warn = originalWarn;
      // 清理：浏览器 + Stagehand + adapter + CDP 连接
      if (adapter) adapter.stop();
      if (cdpBrowser) cdpBrowser.close().catch(() => {});
      if (browser) browser.close().catch(() => {});
      if (this.stagehand) await this.stagehand.close().catch(() => {});
      this.stagehand = null;
    }
  }

  /**
   * 为单 — ?Stagehand 调用施加 timeoutPerStep 上限，防止挂起的 LLM/浏览器调用阻塞整个录制 — ?
   * 超时后放弃对底层 promise 的引用（附加 no-op catch 避免晚到 — ?rejection 变成 unhandled）；
   * 底层 SDK 挂起 — ?STOP abort 兜底 — ?
   */
  private async withStepTimeout<T = any>(op: string, promise: Promise<T>): Promise<T> {
    const ms = this.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepCallTimeoutError(op)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
      void promise.catch(() => {});
    }
  }

  private async executeNlStep(
    nlStepIndex: number,
    nlStep: NlTestCaseStep,
    page: Page,
    emit: (event: string, data: any) => void,
    maxRetries: number,
    onTakeoverRequest?: (nlStepIndex: number, instruction: string) => Promise<boolean>,
  ): Promise<NlStepBoundary> {
    const startStepIdx = this.recordedSteps.length;
    const stepStartedAt = Date.now();
    this.currentNlStepIndex = nlStepIndex;
    // 每步日志时间线：随终态事件上报， — ?UI 展开展示与历史回 — ?
    const stepLogs: Array<{ t: number; level: 'info' | 'warn' | 'error'; message: string }> = [];
    const log = (level: 'info' | 'warn' | 'error', message: string) => {
      stepLogs.push({ t: Date.now() - stepStartedAt, level, message });
    };

    log('info', `step start: ${nlStep.action}`);
    emit('step:start', {
      nlStepIndex,
      instruction: nlStep.action,
      expected: nlStep.expected,
    });

    // --- 阶段 0: 动作类型自 action 文本首词解析 + intent 分派（docs/08 §3.2） ---
    const intent = nlStep.intent;
    const verb = parseActionVerb(nlStep.action);
    if (intent) {
      log('info', `intent: action=${verb ?? '?'}${intent.expectation ? ` expectation.kind=${intent.expectation.kind}` : ''}`);
    }
    if (verb === 'navigate' && intent?.data) {
      // 导航直达——确定性 page.goto，省一次 Stagehand LLM 调用
      // intent.data 可能是 ${key} 引用（解析为 testData 实际 URL）、相对路径（基于 origin 解析）、或绝对 URL
      const rawTarget = resolveIntentData(intent.data, this.testDataParams) ?? intent.data;
      try {
        const target = /^https?:\/\//i.test(rawTarget)
          ? rawTarget
          : new URL(rawTarget, page.url()).href;
        await page.goto(target, { waitUntil: 'load' });
        log('info', `navigate: goto ${target}`);
      } catch (err: any) {
        log('error', `navigate failed: ${err?.message?.slice(0, 200)}`);
      }
      return this.finalizeStep(nlStepIndex, nlStep, startStepIdx, stepStartedAt, stepLogs, emit, page);
    }
    if (verb === 'verify') {
      // 纯验证步骤——不 act，直接取证+编译（解决"落盘消失"问题）
      log('info', 'verify: skipping act, proceeding to evidence + compile');
      return this.finalizeStep(nlStepIndex, nlStep, startStepIdx, stepStartedAt, stepLogs, emit, page);
    }
    if (verb === 'waitFor' && intent?.expectation?.kind === 'network') {
      // 等待网络响应——确定性 waitForResponse
      try {
        const urlPattern = intent.expectation.urlPattern || intent.expectation.value || '';
        const method = intent.expectation.method || '';
        log('info', `waitFor: network ${method} ${urlPattern}`);
        if (urlPattern) {
          await page.waitForResponse(
            (res) => (!method || res.request().method() === method) && res.url().includes(urlPattern),
            { timeout: 15_000 },
          ).catch(() => {});
        }
      } catch (err: any) {
        log('warn', `waitFor network failed: ${err?.message?.slice(0, 200)}`);
      }
      return this.finalizeStep(nlStepIndex, nlStep, startStepIdx, stepStartedAt, stepLogs, emit, page);
    }

    // --- 阶段 1: 执行 act()（带脏状态自愈重 — ?+ lazy observe — ?--
    let actSuccess = false;
    let observeHint: string | null = null;
    // intent.data 解析：将 ${key} 引用或裸键名解析为 testData 实际值
    const resolvedData = resolveIntentData(intent?.data, this.testDataParams);
    const dataSuffix = resolvedData ? ` (Input value: "${resolvedData}")` : '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const actInstruction = observeHint
          ? `${nlStep.action}${dataSuffix} (Context: ${observeHint})`
          : `${nlStep.action}${dataSuffix}`;
        console.log(`[ACT|step:${nlStepIndex}|attempt:${attempt}] instruction: ${actInstruction}`);
        log('info', `act attempt ${attempt}: ${actInstruction}`);
        await this.withStepTimeout('act', this.stagehand!.act(actInstruction, { page }));
        actSuccess = true;
        console.log(`[ACT|step:${nlStepIndex}|attempt:${attempt}] succeeded`);
        log('info', `act attempt ${attempt}: succeeded`);
        break;
      } catch (err: any) {
        let currentUrl = 'unknown';
        try { currentUrl = await page.url(); } catch { /* ignore */ }
        console.error(`[ACT|step:${nlStepIndex}|attempt:${attempt}] error url=${currentUrl} msg=${err?.message}`);
        log('error', `act attempt ${attempt}: failed  — ?${err?.message?.slice(0, 200)}`);
        // Lazy observe：仅在首次失败（attempt === 0）后触发一 — ?observe — ?
        // 不在后续重试中重 — ?observe，避免无限循环；也不 — ?act 前预检，避免浪 — ?LLM 调用 — ?
        if (attempt === 0) {
          try {
            const observations = await this.withStepTimeout(
              'observe',
              this.stagehand!.observe('find all interactive elements on the page', { page }),
            );
            console.log(`[OBSERVE|step:${nlStepIndex}] found ${observations.length} interactive elements`);
            log('info', `observe: found ${observations.length} interactive elements`);
            if (observations.length > 0) {
              observeHint = observations
                .filter((o: any) => o.selector || o.description)
                .map((o: any) => o.description || o.selector)
                .slice(0, 3)
                .join('; ');
              console.log(`[OBSERVE|step:${nlStepIndex}] hint: ${observeHint}`);
              if (observeHint) log('info', `observe hint: ${observeHint}`);
              emit('step:observe', {
                nlStepIndex,
                observationCount: observations.length,
              });
            }
          } catch (observeErr: any) {
            console.warn(`[OBSERVE|step:${nlStepIndex}] failed: ${observeErr.message}`);
            log('warn', `observe failed: ${observeErr?.message?.slice(0, 200)}`);
            /* observe 失败不阻断重 — ?*/
          }
        }

        if (attempt >= maxRetries) {
          let failedUrl = 'unknown';
          try { failedUrl = await page.url(); } catch { /* ignore */ }
          console.error(`[ACT|step:${nlStepIndex}] FAILED url=${failedUrl} msg=${err.message}`);
          log('error', `act failed after ${attempt + 1} attempt(s): ${err?.message?.slice(0, 200)}`);
          // Takeover 仅在 headless:false 时可用；headless 模式下用户无法操作浏览器
          if (onTakeoverRequest && !this.isHeadless) {
            emit('step:takeover', {
              nlStepIndex,
              instruction: nlStep.action,
              error: err.message,
            });
            log('warn', 'takeover requested  — ?waiting for manual completion');
            const takenOver = await onTakeoverRequest(nlStepIndex, nlStep.action);
            if (takenOver) {
              log('info', 'takeover completed by user');
              emit('step:complete', {
                nlStepIndex,
                instruction: nlStep.action,
                expected: nlStep.expected,
                recordedStepCount: this.recordedSteps.length - startStepIdx,
                durationMs: Date.now() - stepStartedAt,
                logs: [...stepLogs, ...this.apiLogEntries(nlStepIndex, stepStartedAt)],
              });
              return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
            }
            log('warn', 'takeover timed out or cancelled');
          }
          console.error(`[ACT|step:${nlStepIndex}] failed (no takeover): ${nlStep.action}`);
          emit('step:failed', {
            nlStepIndex,
            instruction: nlStep.action,
            expected: nlStep.expected,
            error: `act() failed: ${err.message}`,
            retryCount: attempt,
            logs: [...stepLogs, ...this.apiLogEntries(nlStepIndex, stepStartedAt)],
          });
          return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
        }
        // 脏状态自愈：extract 评估页面状 — ? — ?cleanup act  — ?重试
        try {
          const recoveryHint = await this.withStepTimeout(
            'extract',
            // 同样必须 — ?(instruction, schema) 两参形态，见下方验证调用说 — ?
            this.stagehand!.extract(
              `The previous action "${nlStep.action}" failed. Assess page state for blocking overlays, partial dropdowns. Describe what needs dismissal.`,
              z.object({
                needsCleanup: z.boolean(),
                cleanupInstruction: z.string().optional(),
              }),
            ),
          ) as { needsCleanup?: boolean; cleanupInstruction?: string };
          if (recoveryHint?.needsCleanup && recoveryHint.cleanupInstruction) {
            console.log(`[RECOVERY|step:${nlStepIndex}] cleanup: ${recoveryHint.cleanupInstruction}`);
            log('info', `recovery extract: needsCleanup=true  — ?${JSON.stringify(recoveryHint).slice(0, 300)}`);
            await this.withStepTimeout('act', this.stagehand!.act(recoveryHint.cleanupInstruction, { page }));
          } else if (recoveryHint) {
            log('info', `recovery extract: ${JSON.stringify(recoveryHint).slice(0, 300)}`);
          }
        } catch {
          /* 恢复失败不阻断重 — ?*/
        }
      }
    }

    // act 失败且无 takeover 时，已发 — ?step:failed，直接返 — ?
    if (!actSuccess) {
      return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
    }

    // --- 阶段 2: 验证 expected（advisory — ?--
    // 三层检校，日志 — ?期望 vs 实际"对照记录 — ?
    //   check llm-extract    — ?AI 看页面自主判断（返回 success + reason 理由 — ?
    //   check keyword-match  — ?expected 关键词表 vs 实际页面文本（树+输入 — ?可见文本 — ?
    //   check url-pattern    — ?expected 中的 URL 关键 — ?vs 实际 URL
    // 语义（录制器）：act() 成功即代表操作已被捕获，验证未通过不判失败 — ?
    // 而是 — ?step:complete + verificationWarning 呈现（UI 显示黄色提示） — ?
    if (nlStep.expected) {
      // 按动作类型推断步骤种类，决定合法的断言 source — ?
      //   field       — ?输入框：只能 UI_VALUE（用户填了什么，断言值）
      //   navigation  — ?跳转：只 — ?UI_PAGE_URL
      //   button      — ?点击按钮：按钮没 — ?value，禁 — ?UI_VALUE/UI_ATTRIBUTE — ?
      //                只允许页面级证据（UI_PAGE_URL/UI_PAGE_TITLE/UI_TEXT/UI_ELEMENT_VISIBLE — ?
      const stepKind = inferNlStepKind(nlStep.action);
      let actualUrl = '';
      try { actualUrl = await page.url(); } catch { /* ignore */ }
      log('info', `expected: "${nlStep.expected}"`);
      // Ground（阶段 B）：采集证据包，并派生旧版 enrichment 字符串保持验证逻辑兼容
      const evidence = await collectEvidencePack(page, {
        nlStepIndex,
        payloads: this.rawPayloadsByNlStep.get(nlStepIndex) ?? [],
        networkCalls: this.capturedApis.filter(a => a.nlStepIndex === nlStepIndex),
      });
      this.evidenceByNlStep.set(nlStepIndex, evidence);
      const enrichment = formatLegacyEnrichment(evidence);
      log('info', `actual page context: ${enrichment ? `${enrichment.length} chars  — ?excerpt: "${enrichment.slice(0, 300)}"` : 'unavailable'}`);

      let verified = false;
      let verifiedVia = '';
      // AI 在验证时顺手提出的断言建议（页面状态新鲜，零额外调用）
      let proposedAssertion: AiAssertionProposal | null = null;
      const kindHint: Record<string, string> = {
        field: 'The recorded action typed into an INPUT FIELD  — ?its value must be verified via UI_VALUE (not UI_TEXT; element text of an input is empty).',
        navigation: 'The recorded action navigated the browser  — ?verify via UI_PAGE_URL.',
        button: 'The recorded action CLICKED a button. Buttons hold no value, so NEVER propose UI_VALUE/UI_ATTRIBUTE/UI_ELEMENT_CHECKED; prefer UI_PAGE_URL (navigation outcomes) or UI_ELEMENT_VISIBLE/UI_TEXT only if the expected is about this button itself.',
        generic: '',
      };
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // 注意：Stagehand v3 的重载是 extract(instruction, schema) — ?
          // 误用 extract({instruction, schema}) 单对象形态会命中
          // "仅提 — ?pageText" 重载，LLM 判断根本不会执行 — ?
          const result = (await this.withStepTimeout(
            'extract',
            this.stagehand!.extract(
              `Verify this expected condition against the actual current page state: "${nlStep.expected}". ` +
                `Recorded action context: ${nlStep.action}. ${kindHint[stepKind] || ''} ` +
                `Look at what is actually on the page, then answer JSON: ` +
                `{"success": true, "reason": "<what you actually observed>"} if met, ` +
                `{"success": false, "reason": "<what you actually observed>"} if not. ` +
                `Additionally, if the condition can be checked with a repeatable UI assertion on this page, ` +
                `also propose one via the "assertion" field: pick a source appropriate for the recorded action type, ` +
                `operator from EQUALS/CONTAINS/EXISTS, and set expectedValue to the concrete value that should hold on page load.`,
              EXTRACT_ASSERTION_SCHEMA,
            ),
          )) as {
            success?: boolean;
            reason?: string;
            pageText?: string;
            assertion?: { source: string; operator: string; expectedValue?: string };
          };
          if (result?.assertion) {
            proposedAssertion = { ...result.assertion, expectedText: nlStep.expected };
            log('info', `ai assertion proposed: ${proposedAssertion.source} ${proposedAssertion.operator} "${proposedAssertion.expectedValue ?? ''}"`);
          }
          const aiAnswer = JSON.stringify({
            success: result?.success ?? null,
            reason: result?.reason ?? '(no reason returned)',
          });
          if (result?.success) {
            verified = true;
            verifiedVia = 'llm-extract';
            log('info', `check llm-extract (attempt ${attempt}): PASSED  — ?ai answer: ${aiAnswer.slice(0, 300)}`);
            break;
          }
          log('warn', `check llm-extract (attempt ${attempt}): NOT PASSED  — ?ai answer: ${aiAnswer.slice(0, 300)}`);
          // Fallback: schema 解析失败 — ?success=false 时，
          // 检查兜底文本是否包 — ?expected 中的关键词 — ?
          // 注意：按整词提取并剔除停用词；历史实现误用字符类
          // `/[I should see the]/gi` 会把句中所有该字母全部删除 — ?
          // 导致关键词全 — ? — ? 字符被过滤、兜底永远失败 — ?
          const rawText: string = [(result as any)?.pageText || '', enrichment].filter(Boolean).join('\n');
          if (rawText) {
            const STOPWORDS = new Set([
              'the', 'a', 'an', 'and', 'or', 'of', 'to', 'is', 'are', 'be',
              'been', 'was', 'were', 'with', 'without', 'for', 'on', 'in',
              'at', 'by', 'it', 'its', 'this', 'that', 'these', 'those',
              'should', 'see', 'shown', 'show', 'displayed', 'displays',
              'appear', 'appears', 'not', 'no', 'any', 'still', 'remain',
              'remains', 'user',
            ]);
            const keywords = nlStep.expected
              .split(/\s+/)
              .map((w) => w.toLowerCase().replace(/[^a-z0-9'-]/g, ''))
              .filter((w) => w.length > 2 && !STOPWORDS.has(w));
            const matchedKws = keywords.filter((kw) =>
              rawText.toLowerCase().includes(kw.toLowerCase()),
            );
            const missedKws = keywords.filter((kw) => !rawText.toLowerCase().includes(kw.toLowerCase()));
            const matchCount = matchedKws.length;
            if (keywords.length > 0 && matchCount / keywords.length >= 0.5) {
              verified = true;
              verifiedVia = 'keyword-match';
              log('info', `check keyword-match: PASSED  — ?expected keywords matched [${matchedKws.join(', ')}], missed [${missedKws.join(', ') || 'none'}] (${matchCount}/${keywords.length} >= 50%)`);
              break;
            }
            log('info', `check keyword-match: NOT PASSED  — ?matched [${matchedKws.join(', ') || 'none'}], missed [${missedKws.join(', ') || 'none'}] (${matchCount}/${keywords.length} < 50%); actual text excerpt: "${rawText.slice(0, 300)}"`);
          } else {
            log('info', 'check keyword-match: SKIPPED  — ?no page context available');
          }
          console.error(`[EXTRACT|step:${nlStepIndex}|attempt:${attempt}] success=${result?.success} result=${JSON.stringify(result).slice(0, 200)}`);
        } catch (err: any) {
          console.error(`[EXTRACT|step:${nlStepIndex}|attempt:${attempt}] threw: ${err?.message?.slice(0, 200)}`);
          log('error', `extract attempt ${attempt} threw: ${err?.message?.slice(0, 200)}`);
        }
      }
      // Check 3/3: URL 模式对照
      if (!verified) {
        try {
          const currentUrl = await page.url();
          const urlKeywords = nlStep.expected.match(/https?:\/\/[^\s"']+|login|page|home|dashboard/gi);
          if (!urlKeywords) {
            log('info', `check url-pattern: SKIPPED  — ?expected has no URL keywords; actual URL: ${currentUrl}`);
          } else {
            const matchedKw = urlKeywords.find((kw) => currentUrl.toLowerCase().includes(kw.toLowerCase()));
            if (matchedKw) {
              verified = true;
              verifiedVia = 'url-pattern';
              log('info', `check url-pattern: PASSED  — ?expected keyword "${matchedKw}" found in actual URL: ${currentUrl}`);
            } else {
              log('info', `check url-pattern: NOT PASSED  — ?expected url keywords [${urlKeywords.join(', ')}], actual URL: ${currentUrl}`);
            }
          }
        } catch { /* ignore */ }
      }
      if (!verified) {
        // 录制语义：操作已成功捕获，验证未通过只降级为警告，不判步骤失败 — ?
        if (this.compilePipeline) {
          log('info', 'compile skipped: expected not met at record time (no assertion compiled)');
        }
        const warning = `expected not met after all checks  — ?expected: "${nlStep.expected.slice(0, 120)}"`;
        console.warn(`[VERIFY|step:${nlStepIndex}] warning: ${warning}`);
        log('warn', `verification FAILED via all checks  — ?${warning}`);
        emit('step:complete', {
          nlStepIndex,
          instruction: nlStep.action,
          expected: nlStep.expected,
          recordedStepCount: this.recordedSteps.length - startStepIdx,
          durationMs: Date.now() - stepStartedAt,
          verificationWarning: warning,
          logs: [...stepLogs, ...this.apiLogEntries(nlStepIndex, stepStartedAt)],
        });
        return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
      }
      // 断言产出：编译管线（规则→覆盖裁决→AI 提议→编译门）或旧路径
      if (this.compilePipeline) {
        await this.compileAssertions(nlStepIndex, nlStep, evidence, page, log);
      } else {
      // 按动作类型规范化 AI 建议（field 强制 UI_VALUE；navigation 强制 UI_PAGE_URL — ?
      // button 禁止 value  — ?source），非法组合丢弃并用规则兜底 — ?
      let finalAssertion: AiAssertionProposal | null =
        proposedAssertion ? normalizeAssertionForKind(proposedAssertion, stepKind) : null;
      if (!finalAssertion) {
        // 规则兜底：field  — ?实际输入值（取最后非空输入）；navigation  — ?实际 URL
        if (stepKind === 'field') {
          const filledValue = lastFilledValue(enrichment);
          if (filledValue) {
            finalAssertion = { source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: filledValue };
            log('info', `rule assertion (field): UI_VALUE CONTAINS "${filledValue}"`);
          }
        } else if (stepKind === 'navigation' && actualUrl) {
          finalAssertion = { source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: actualUrl };
          log('info', `rule assertion (navigation): UI_PAGE_URL CONTAINS "${actualUrl}"`);
        }
      }
      if (finalAssertion) {
        this.pendingAssertions.set(nlStepIndex, { ...finalAssertion, expectedText: nlStep.expected });
        log('info', `assertion stored (${stepKind}): ${finalAssertion.source} ${finalAssertion.operator} "${finalAssertion.expectedValue ?? ''}"`);
      }
      }
      log('info', `verification PASSED via ${verifiedVia}`);
    }

    emit('step:complete', {
      nlStepIndex,
      instruction: nlStep.action,
      expected: nlStep.expected,
      recordedStepCount: this.recordedSteps.length - startStepIdx,
      durationMs: Date.now() - stepStartedAt,
      logs: [...stepLogs, ...this.apiLogEntries(nlStepIndex, stepStartedAt)],
    });
    return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
  }

  /**
   * finalizeStep：intent 分派的 verify/navigate/waitFor 步骤的收尾——
   * 取证 + 编译 + 发射 step:complete（复用主路径的验证后逻辑，但跳过 act 失败处理）。
   */
  private async finalizeStep(
    nlStepIndex: number,
    nlStep: NlTestCaseStep,
    startStepIdx: number,
    stepStartedAt: number,
    stepLogs: Array<{ t: number; level: 'info' | 'warn' | 'error'; message: string }>,
    emit: (event: string, data: any) => void,
    page: Page,
  ): Promise<NlStepBoundary> {
    const log = (level: 'info' | 'warn' | 'error', message: string) => {
      stepLogs.push({ t: Date.now() - stepStartedAt, level, message });
    };

    if (nlStep.expected && this.compilePipeline) {
      const evidence = await collectEvidencePack(page, {
        nlStepIndex,
        payloads: this.rawPayloadsByNlStep.get(nlStepIndex) ?? [],
        networkCalls: this.capturedApis.filter(a => a.nlStepIndex === nlStepIndex),
      });
      this.evidenceByNlStep.set(nlStepIndex, evidence);
      await this.compileAssertions(nlStepIndex, nlStep, evidence, page, log);
    } else if (nlStep.expected && parseActionVerb(nlStep.action) === 'verify') {
      // 旧路径：verify 步骤不产生 DOM 操作——直接生成独立 assert 步骤（Form B），
      // 使"纯验证步骤落盘即消失"问题彻底解决。元素依托断言由 intent.targetHint
      // 经 Stagehand observe 解析出选择器；页面级断言（url/title）无需元素。
      const created = await this.buildVerifyAssertStep(nlStepIndex, nlStep, page, log);
      if (!created) {
        // 生成失败（缺 targetHint / 选择器解析失败 / 非元素类）→ 回退页面级 intent 挂载
        const proposal = intentBasedAssertion(nlStep.intent, nlStep.expected);
        if (proposal) {
          this.pendingAssertions.set(nlStepIndex, proposal);
          log('info', `intent assertion (${proposal.origin}): ${proposal.source} ${proposal.operator} "${proposal.expectedValue ?? ''}"`);
        }
      }
    } else if (nlStep.expected) {
      // 旧路径：navigate/waitFor 步骤从 intent 确定性推导断言（零 LLM）
      const proposal = intentBasedAssertion(nlStep.intent, nlStep.expected);
      if (proposal) {
        this.pendingAssertions.set(nlStepIndex, proposal);
        log('info', `intent assertion (${proposal.origin}): ${proposal.source} ${proposal.operator} "${proposal.expectedValue ?? ''}"`);
      }
    }

    emit('step:complete', {
      nlStepIndex,
      instruction: nlStep.action,
      expected: nlStep.expected,
      recordedStepCount: this.recordedSteps.length - startStepIdx,
      durationMs: Date.now() - stepStartedAt,
      logs: [...stepLogs, ...this.apiLogEntries(nlStepIndex, stepStartedAt)],
    });
    return { nlStepIndex, startStepIdx, endStepIdx: this.recordedSteps.length };
  }

  /**
   * 期望分类 → assert 动作映射（docs/08 断言承载模型）。
   * requiresElement=true 时需解析 targetHint 为选择器；dataValue 是 assert 步骤的 data。
   * network / api-body / transient 返回 null——网络断言走 waitForNetwork，响应体断言走 intent 挂载。
   */
  private expectationKindToAssertAction(
    kind: string,
    expectation: { value?: string; expression?: string } | undefined,
  ): { action: string; requiresElement: boolean; dataValue?: string } | null {
    switch (kind) {
      case 'element-visible':
        return { action: 'assertVisible', requiresElement: true };
      case 'element-hidden':
        return { action: 'assertInvisible', requiresElement: true };
      case 'value':
        return { action: 'assertValue', requiresElement: true, dataValue: expectation?.value };
      case 'text-visible':
        return { action: 'assertText', requiresElement: true, dataValue: expectation?.value };
      case 'attribute':
        return expectation?.expression && expectation?.value !== undefined
          ? { action: 'assertAttribute', requiresElement: true, dataValue: `${expectation.expression}=${expectation.value}` }
          : null;
      case 'element-state': {
        const v = expectation?.value;
        if (v === 'enabled') return { action: 'assertEnabled', requiresElement: true };
        if (v === 'disabled') return { action: 'assertDisabled', requiresElement: true };
        if (v === 'checked') return { action: 'assertChecked', requiresElement: true };
        if (v === 'unchecked') return { action: 'assertUnchecked', requiresElement: true };
        return null;
      }
      case 'url':
        return { action: 'assertUrl', requiresElement: false, dataValue: expectation?.value };
      case 'title':
        return { action: 'assertTitle', requiresElement: false, dataValue: expectation?.value };
      default:
        return null;
    }
  }

  /**
   * 用 Stagehand observe 把 intent.targetHint（自然语言）解析为稳定选择器。
   * 解析失败返回 null（调用方回退页面级挂载或跳过）。
   */
  private async resolveTargetSelector(targetHint: string, page: Page): Promise<string | null> {
    try {
      const observations = await this.withStepTimeout(
        'observe',
        this.stagehand!.observe(
          `Find the element on the current page described as: "${targetHint}". ` +
            `Return the most specific stable selector for it (prefer data-testid, id, or accessible role).`,
          { page },
        ),
      );
      const el = Array.isArray(observations) ? observations[0] : null;
      const selector = el?.selector;
      return typeof selector === 'string' && selector ? selector : null;
    } catch {
      return null;
    }
  }

  /**
   * 旧路径下 verify 步骤生成独立 assert 步骤（Form B）：
   * 元素依托断言 → 解析 targetHint 得选择器，创建 assertVisible/assertValue/... payload；
   * 页面级断言（url/title）→ 创建 assertUrl/assertTitle payload（无需元素）。
   * payload 进入 recordedSteps 与 onConsolidatedStep 桥，落库后由 saveSuite 的
   * normalizeAssertSteps 转成显式 StepAssertion（稳定 ID + provenance=rule）。
   * 返回 null 表示无法生成（调用方回退页面级 intent 挂载）。
   */
  private async buildVerifyAssertStep(
    nlStepIndex: number,
    nlStep: NlTestCaseStep,
    page: Page,
    log: (level: 'info' | 'warn' | 'error', message: string) => void,
  ): Promise<RecorderStepPayload | null> {
    const expectation = nlStep.intent?.expectation;
    if (!expectation) return null;
    const mapping = this.expectationKindToAssertAction(expectation.kind, expectation);
    if (!mapping) return null;

    let locator: LocatorRef | undefined;
    if (mapping.requiresElement) {
      if (!nlStep.intent?.targetHint) {
        log('warn', `verify: element-bound expectation missing targetHint — no assert step created`);
        return null;
      }
      const selector = await this.resolveTargetSelector(nlStep.intent.targetHint, page);
      if (!selector) {
        log('warn', `verify: could not resolve selector for "${nlStep.intent.targetHint}" — no assert step created`);
        return null;
      }
      locator = { kind: 'css', selector };
    }

    const payload: RecorderStepPayload = {
      action: mapping.action,
      locator,
      locatorCandidates: [],
      pageUrl: page.url(),
      timestamp: Date.now(),
      ...(mapping.dataValue !== undefined ? { value: mapping.dataValue } : {}),
      metadata: {
        nlStepIndex,
        verifySource: nlStep.action,
        verifyExpected: nlStep.expected,
      },
    };
    this.recordedSteps.push(payload);
    if (this.onConsolidatedStep) this.onConsolidatedStep(payload);
    log(
      'info',
      `assert step created: ${mapping.action}${locator ? ` ${locator.selector}` : ''}${mapping.dataValue !== undefined ? ` data="${mapping.dataValue}"` : ''}`,
    );
    return payload;
  }

  /**
   * Compile（阶段 C）：规则层 → 覆盖裁决 → AI 提议 → 编译门。
   * 产物写入 pendingAssertions；任何降级路径只记日志，不硬塞（docs/07 §4-C）。
   */
  private async compileAssertions(
    nlStepIndex: number,
    nlStep: NlTestCaseStep,
    evidence: EvidencePack,
    page: Page,
    log: (level: 'info' | 'warn' | 'error', message: string) => void,
  ): Promise<void> {
    const payloads = this.rawPayloadsByNlStep.get(nlStepIndex) ?? [];
    const ruleProps = deriveRuleProposals(payloads);

    // verify/waitFor 类步骤无自身 payload——向前回退到最近有动作的边界，
    // 复用其证据（actedElements）与依托序号，元素依托断言才有过编译门的资格。
    let effEvidence = evidence;
    let effPayloads = payloads;
    if (payloads.length === 0) {
      for (let i = nlStepIndex - 1; i >= 0; i--) {
        const g = this.rawPayloadsByNlStep.get(i);
        if (g && g.length > 0) {
          effPayloads = g;
          effEvidence = this.evidenceByNlStep.get(i) ?? evidence;
          log('info', `compile: elementless boundary — walked back to step ${i} for evidence/target`);
          break;
        }
      }
    }

    let candidate: GateProposal | null = null;

    // 0. intent 驱动（docs/08 §3.2）：有结构化期望分类时按映射表定 source，零 LLM
    // 但 API/URL 相关期望必须由该边界**真实的网络捕获**（capturedApis）背书——
    // AI 的 urlPattern / URL 期望只作候选，不匹配真实捕获就丢弃，不硬猜。
    const intent = nlStep.intent;
    const intentKind = intent?.expectation?.kind;

    // 网络相关期望（network / api-body）必须由真实捕获背书——
    // AI 的 urlPattern 只作候选，不匹配真实捕获就丢弃，不硬猜。
    // url 期望是页面 URL 变更，不是网络调用，不走此校验。
    const boundaryApis = effEvidence.networkCalls ?? [];
    if (intentKind === 'network' || intentKind === 'api-body') {
      const want = intent?.expectation?.urlPattern ?? intent?.expectation?.value ?? '';
      const wantMethod = intent?.expectation?.method ?? '';
      const matched = boundaryApis.some(a =>
        wantMethod ? a.method === wantMethod && a.url.includes(want) : a.url.includes(want) || a.pathname.includes(want),
      );
      if (!matched && boundaryApis.length === 0) {
        log('warn', `compile: intent ${intentKind} has NO captured network calls — refusing to fabricate (expected API must be backed by real capture)`);
        return;  // 不落断言，只记日志
      }
      if (want && !matched && boundaryApis.length > 0) {
        log('warn', `compile: intent ${intentKind} urlPattern "${want}" NOT in captured APIs [${boundaryApis.map(a => a.pathname).join('; ')}] — refusing to fabricate`);
        return;
      }
      log('info', `compile: intent ${intentKind} backed by ${boundaryApis.length}真实网络捕获 ✓`);
    }

    if (intentKind && intentKind !== 'transient' && intentKind !== 'network') {
      if (intentKind === 'api-body') {
        // U5: API 响应体断言——API_BODY_JSON + JSONPath expression
        candidate = {
          source: 'API_BODY_JSON',
          operator: 'CONTAINS',
          expectedValue: intent?.expectation?.value,
          expression: intent?.expectation?.expression,
          origin: 'rule',
          confidence: 1,
          rationale: `from intent expectation.kind=api-body, expression=${intent?.expectation?.expression ?? '?'}`,
        };
        log('info', `compile: intent-driven api-body → API_BODY_JSON ${intent?.expectation?.expression ?? ''} CONTAINS "${intent?.expectation?.value ?? ''}"`);
      } else {
        const mapping = getExpectationMapping(intentKind);
        if (mapping.sources.length > 0) {
          const expectedValue = intent?.expectation?.value;
          const lastPayloadIdx = effPayloads.length > 0 ? effPayloads.length - 1 : undefined;
          candidate = {
            source: mapping.sources[0],
            operator: 'CONTAINS',
            expectedValue,
            targetPayloadIndex: lastPayloadIdx,
            origin: 'rule',
            confidence: 1,
            rationale: `from intent expectation.kind=${intentKind}`,
          };
          log('info', `compile: intent-driven → ${candidate.source} CONTAINS "${expectedValue ?? ''}" (kind=${intentKind})`);
        }
      }
    }

    // 1. 确定性覆盖裁决：expected 已被规则覆盖 → 零 LLM
    if (!candidate) {
      candidate = findCoveringRule(nlStep.expected, ruleProps);
      if (candidate) {
        log('info', `compile: rule covers expected → ${candidate.source} ${candidate.operator} "${candidate.expectedValue ?? ''}"`);
      } else {
        // 2. AI 裁决（一次专用调用）；null/unverifiable 即"不确定"——只记日志
        const adjudication = await this.proposer?.adjudicate({
          expected: nlStep.expected,
          actionText: nlStep.action,
          evidence: effEvidence,
          ruleCandidates: ruleProps,
        });
        if (!adjudication || adjudication.verdict === 'unverifiable') {
          const why = adjudication?.rationale ? `, ${adjudication.rationale.slice(0, 120)}` : '';
          log('warn', `compile: no reliable assertion (verdict=${adjudication?.verdict ?? 'null'}${why}) — logged for review only`);
          return;
        }
        if (adjudication.verdict === 'covered') {
          const idx = adjudication.bindsRuleCandidate ?? 0;
          candidate = ruleProps[idx] ?? null;
          log('info', `compile: ai confirms rule candidate [${idx}]`);
        } else if (adjudication.proposal) {
          const refRaw = adjudication.proposal.elementRefId;
          candidate = {
            source: adjudication.proposal.source,
            operator: adjudication.proposal.operator,
            expectedValue: adjudication.proposal.expectedValue,
            targetPayloadIndex: refRaw != null && /^\d+$/.test(refRaw) ? Number(refRaw) : undefined,
            origin: 'ai',
            confidence: adjudication.confidence ?? 0.5,
            rationale: adjudication.rationale,
          };
          log('info', `compile: ai proposed ${candidate.source} ${candidate.operator} "${candidate.expectedValue ?? ''}" (confidence=${(candidate.confidence ?? 0).toFixed(2)})`);
        }
      }
    }
    if (!candidate) return;

    // 3. 编译门：任一不过即丢弃并记原因
    const gateResult = await passesGate(candidate, effEvidence, page);
    if (!gateResult.ok) {
      log('warn', `compile gate rejected (${candidate.source}): ${gateResult.reason}`);
      return;
    }
    this.pendingAssertions.set(nlStepIndex, { ...gateResult.proposal, expectedText: nlStep.expected });
    log('info', `assertion compiled (${gateResult.proposal.origin}): ${gateResult.proposal.source} ${gateResult.proposal.operator} "${gateResult.proposal.expectedValue ?? ''}"`);
  }

  /**
   * 美化响应体：JSON 缩进输出；非 JSON 文本截断；超长截断到 MAX_RESP_CHARS。
   * 供步骤日志与 api-body 佐证阅读。
   */
  private static formatResponseBody(body: string): string {
    const MAX = 600;
    try {
      const parsed = JSON.parse(body);
      const pretty = JSON.stringify(parsed, null, 2);
      return pretty.length > MAX ? pretty.slice(0, MAX) + '\n  …(truncated)' : pretty;
    } catch {
      return body.length > MAX ? body.slice(0, MAX) + '…' : body;
    }
  }

  /**
   * 该 NL 步骤期间捕获的 XHR/Fetch 调用，转为步骤日志条目。
   * 由终态事件发射时合并进 logs，UI 展开即可看到 API 调用时间线。
   * 方法 + pathname + 状态码；POST/PUT/PATCH 附格式化响应体（独立行，缩进，可读）。
   */
  private apiLogEntries(nlStepIndex: number, stepStartedAt: number): Array<{ t: number; level: string; message: string }> {
    return this.capturedApis
      .filter(a => a.nlStepIndex === nlStepIndex)
      .map(a => {
        let pathname = a.url;
        try { pathname = new URL(a.url).pathname; } catch { /* keep raw */ }
        const base = `api: ${a.method} ${pathname} → ${a.status}`;
        if (a.responseBody) {
          const pretty = AIRecordingSession.formatResponseBody(a.responseBody);
          return {
            t: Math.max(0, a.capturedAt - stepStartedAt),
            level: a.status >= 400 ? 'warn' as const : 'info' as const,
            // 请求行与响应体分行展示，响应体缩进，避免挤在一行看不清
            message: `${base}\n  resp:\n${pretty.split('\n').map(l => `    ${l}`).join('\n')}`,
          };
        }
        return {
          t: Math.max(0, a.capturedAt - stepStartedAt),
          level: a.status >= 400 ? 'warn' as const : 'info' as const,
          message: base,
        };
      });
  }
}
