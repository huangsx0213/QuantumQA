/**
 * AutoReplay — Agent 端自动回放验证
 *
 * 在 AIRecordingSession.start() 第 6.5 步执行（Refiner 之后、Stagehand.close() 之前），
 * 复用 Stagehand 已打开的浏览器上下文，对 refined draft suite 回放 N 次（默认 3），
 * 检测 flaky test。
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §3.5
 *
 * 设计要点：
 *   - 策略 B：Agent 端执行，复用 Stagehand 浏览器，避免重新启动开销
 *   - 3 次回放 + flaky 检测（pass/flaky/fail），业界最佳实践（Mabl/Reflect）
 *   - 提前终止：连续 2 次全 fail 则不再跑第 3 次
 *   - 降级支持：资源不足时可只跑 1 次，degraded=true
 */

import type { Page } from 'playwright';
import type { TestSuite, TestStep } from '../../shared/contracts/index.ts';
import type { LocatorRef } from './protocol.ts';
import type {
  ReplayReport,
  ReplayVerdict,
  SingleReplayResult,
} from './ai-recording-session.ts';

const DEFAULT_REPLAY_RUNS = 3;
const STEP_TIMEOUT = 10000;

/**
 * 自动回放 draft suite。
 *
 * @param suite refinedSteps 构建的 suite skeleton
 * @param options.page Stagehand 当前 page（复用浏览器上下文）
 * @param options.startUrl 每次回放前重置到的起始 URL
 * @param options.replayRuns 回放次数，默认 3
 */
export async function autoReplayDraftSuite(
  suite: TestSuite,
  options: {
    page: Page;
    startUrl: string;
    replayRuns?: number;
  },
): Promise<ReplayReport> {
  const targetRuns = options.replayRuns ?? DEFAULT_REPLAY_RUNS;
  const results: SingleReplayResult[] = [];
  const startTime = Date.now();

  // 收集所有 case 的 steps（suite 可能有多个 case，按顺序回放）
  const allSteps = suite.cases.flatMap(c => c.steps ?? []);

  for (let run = 0; run < targetRuns; run++) {
    const result = await replayOnce(allSteps, options.page, options.startUrl);
    results.push(result);

    // 提前终止：连续 2 次都有 failedSteps，无需跑完确认是 fail
    if (
      run >= 1 &&
      results[run].failedSteps > 0 &&
      results[run - 1].failedSteps > 0
    ) {
      break;
    }
  }

  const passCount = results.filter(r => r.failedSteps === 0).length;
  const failCount = results.length - passCount;

  let verdict: ReplayVerdict;
  if (passCount === results.length) verdict = 'pass';
  else if (failCount === results.length) verdict = 'fail';
  else verdict = 'flaky';

  return {
    runs: results.length,
    passCount,
    failCount,
    verdict,
    results,
    overallPass: verdict === 'pass',
    totalDurationMs: Date.now() - startTime,
    degraded: results.length < targetRuns,
  };
}

/**
 * 执行单次回放。
 * 每次回放前重置到起始 URL，然后逐步执行。
 */
async function replayOnce(
  steps: TestStep[],
  page: Page,
  startUrl: string,
): Promise<SingleReplayResult> {
  const startTime = Date.now();
  const stepResults: SingleReplayResult['stepResults'] = [];

  // 重置到起始 URL
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.enabled === false) {
      stepResults.push({
        stepIndex: i,
        action: step.action,
        target: step.target ?? '',
        passed: true,
      });
      continue;
    }

    try {
      await executeStepOnPage(step, page);
      stepResults.push({
        stepIndex: i,
        action: step.action,
        target: step.target ?? '',
        passed: true,
      });
    } catch (err: any) {
      stepResults.push({
        stepIndex: i,
        action: step.action,
        target: step.target ?? '',
        passed: false,
        error: err?.message ?? String(err),
      });
      // fail-fast：步骤失败则终止本次回放
      break;
    }
  }

  return {
    totalSteps: steps.length,
    passedSteps: stepResults.filter(r => r.passed).length,
    failedSteps: stepResults.filter(r => !r.passed).length,
    stepResults,
    durationMs: Date.now() - startTime,
  };
}

/**
 * 在 Playwright Page 上执行单个 TestStep（confirm/run.ts 复用）。
 *
 * 支持 AI 录制产出的常见 action：click, fill, goto/navigate, selectOption,
 * press, check, uncheck, hover, waitForTimeout, waitForVisible, evaluate。
 *
 * 选择器解析优先级：
 *   1. metadata.recorder.allLocators（Refiner 展开的多候选选择器，容错尝试）
 *   2. metadata.recorder.locator（主选择器）
 *   3. step.target（原始选择器或 URL）
 */
export async function executeStepOnPage(step: TestStep, page: Page): Promise<void> {
  const recorder = (step.metadata as any)?.recorder;
  const allLocators: LocatorRef[] | undefined = recorder?.allLocators;
  const primaryLocator: LocatorRef | undefined = recorder?.locator;

  // 构建候选选择器列表（去重）
  const candidates: LocatorRef[] = [];
  if (primaryLocator) candidates.push(primaryLocator);
  if (Array.isArray(allLocators)) {
    for (const loc of allLocators) {
      if (!candidates.some(c => c.selector === loc.selector)) {
        candidates.push(loc);
      }
    }
  }

  // 解析 frame path（如果录制时在 iframe 内）
  const framePath: string[] = Array.isArray(recorder?.framePath)
    ? recorder.framePath.filter((v: unknown) => typeof v === 'string' && v.trim().length > 0)
    : [];

  let locatorRoot: any = page;
  for (const frameSelector of framePath) {
    locatorRoot = locatorRoot.frameLocator(frameSelector);
  }

  // 获取 Playwright Locator（带候选选择器容错）
  const getLocator = async (): Promise<any> => {
    if (candidates.length === 0) {
      throw new Error(`No locator for action: ${step.action}`);
    }
    let lastError: any;
    for (const cand of candidates) {
      try {
        const locator = locatorRoot.locator(cand.selector);
        // 快速检查元素是否存在（不等待 actionability）
        await locator.waitFor({ state: 'attached', timeout: 2000 });
        return locator;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('All candidate locators failed');
  };

  const action = step.action;
  const data = step.data ?? '';

  switch (action) {
    case 'goto':
    case 'navigate':
    case 'pageLoad': {
      const url = step.target || data;
      if (!url) throw new Error('URL required for navigation');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    }

    case 'click': {
      const locator = await getLocator();
      await locator.click({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'dblclick': {
      const locator = await getLocator();
      await locator.dblclick({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'fill': {
      if (data === undefined) throw new Error('Data required for fill');
      const locator = await getLocator();
      await locator.fill(data, { timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'clear': {
      const locator = await getLocator();
      await locator.clear({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'hover': {
      const locator = await getLocator();
      await locator.hover({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'check': {
      const locator = await getLocator();
      await locator.check({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'uncheck': {
      const locator = await getLocator();
      await locator.uncheck({ timeout: STEP_TIMEOUT, force: true });
      break;
    }

    case 'selectOption': {
      if (!data) throw new Error('Data required for selectOption');
      const locator = await getLocator();
      await locator.selectOption(data, { timeout: STEP_TIMEOUT });
      break;
    }

    case 'press': {
      if (step.target) {
        const locator = await getLocator();
        await locator.focus({ timeout: STEP_TIMEOUT });
      }
      await page.keyboard.press(data || step.target || 'Enter');
      break;
    }

    case 'waitForTimeout': {
      const ms = parseInt(data, 10);
      if (!isNaN(ms)) await page.waitForTimeout(ms);
      break;
    }

    case 'waitForVisible': {
      const locator = await getLocator();
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      break;
    }

    case 'waitForHidden': {
      const locator = await getLocator();
      await locator.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
      break;
    }

    case 'scrollIntoView': {
      const locator = await getLocator();
      await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
      break;
    }

    case 'evaluate': {
      if (data) await page.evaluate(data);
      break;
    }

    // Assertion actions — 检查元素状态但不修改页面
    case 'assertVisible': {
      const locator = await getLocator();
      await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      break;
    }

    case 'assertHidden':
    case 'assertInvisible': {
      const locator = await getLocator();
      await locator.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
      break;
    }

    case 'assertText': {
      if (!data) throw new Error('Data required for assertText');
      const locator = await getLocator();
      const text = await locator.textContent({ timeout: STEP_TIMEOUT });
      if (text?.trim() !== data) {
        throw new Error(`Text mismatch: expected "${data}", got "${text?.trim()}"`);
      }
      break;
    }

    case 'assertValue': {
      if (!data) throw new Error('Data required for assertValue');
      const locator = await getLocator();
      const value = await locator.inputValue({ timeout: STEP_TIMEOUT });
      if (value !== data) {
        throw new Error(`Value mismatch: expected "${data}", got "${value}"`);
      }
      break;
    }

    case 'assertChecked': {
      const locator = await getLocator();
      const checked = await locator.isChecked({ timeout: STEP_TIMEOUT });
      if (!checked) throw new Error('Expected checked but was unchecked');
      break;
    }

    case 'assertUnchecked': {
      const locator = await getLocator();
      const checked = await locator.isChecked({ timeout: STEP_TIMEOUT });
      if (checked) throw new Error('Expected unchecked but was checked');
      break;
    }

    case 'assertEnabled': {
      const locator = await getLocator();
      const enabled = await locator.isEnabled({ timeout: STEP_TIMEOUT });
      if (!enabled) throw new Error('Expected enabled but was disabled');
      break;
    }

    case 'assertDisabled': {
      const locator = await getLocator();
      const enabled = await locator.isEnabled({ timeout: STEP_TIMEOUT });
      if (enabled) throw new Error('Expected disabled but was enabled');
      break;
    }

    case 'assertUrl': {
      if (!data) throw new Error('Data required for assertUrl');
      const url = page.url();
      if (url !== data && !url.includes(data)) {
        throw new Error(`URL mismatch: expected "${data}", got "${url}"`);
      }
      break;
    }

    case 'assertTitle': {
      if (!data) throw new Error('Data required for assertTitle');
      const title = await page.title();
      if (title !== data && !title.includes(data)) {
        throw new Error(`Title mismatch: expected "${data}", got "${title}"`);
      }
      break;
    }

    default: {
      // 未知 action — 跳过而非报错，避免阻断回放
      // 调用方可通过 stepResults 中的 action 字段识别跳过的步骤
    }
  }
}
