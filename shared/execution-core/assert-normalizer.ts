/**
 * Assert 步骤归一化（docs/08 统一测试标准 · 断言承载模型）
 *
 * Test Design 里以 assert 开头的动作（assertVisible/assertText/...）本质是"承载断言"，
 * 而非 DOM 操作。本归一化把它们转成显式 StepAssertion（稳定 ID + provenance），
 * 二选一落库：
 *
 *   Form A · 内联断言 —— assert 的目标元素与前面某动作步骤相同（页面级则归附最近
 *             动作步骤），断言合并进该步骤的 assertions[]，assert 步骤本身删除。
 *             例：fill #username → assertValue #username 合并为 fill 步骤 + UI_VALUE 断言。
 *   Form B · 独立断言步骤 —— 无合并目标时保留为独立 assert 步骤，但携带显式
 *             StepAssertion（稳定 ID `assert-${step.id}` + provenance=rule），
 *             运行期不再靠随机 UUID 运行时转换。
 *
 * 幂等：已携带显式断言的 assert 步骤视为已归一化，不再重复转换。
 */
import type { TestStep, StepAssertion } from '../contracts/index.ts';

export const ASSERT_ACTIONS = new Set([
  'assertVisible', 'assertHidden', 'assertInvisible', 'assertAttribute',
  'assertEnabled', 'assertDisabled', 'assertChecked', 'assertUnchecked',
  'assertText', 'assertValue', 'assertUrl', 'assertTitle', 'assertNotExist',
]);

/** 向后搜索合并目标时跳过的动作（不承载可依托的页面/元素状态） */
const SKIP_FOR_MERGE = new Set([
  ...ASSERT_ACTIONS, 'verify',
  'waitForTimeout', 'waitForVisible', 'waitForHidden',
  'switchToWindow', 'switchToFrame', 'acceptDialog', 'dismissDialog',
  'extractVar', 'highlight', 'evaluate',
]);

export function isAssertAction(action: string): boolean {
  return ASSERT_ACTIONS.has(action);
}

function isPageLevelSource(source: string): boolean {
  return source === 'UI_PAGE_URL' || source === 'UI_PAGE_TITLE';
}

/**
 * assert 动作 → StepAssertion 的确定性转换（ID 稳定：`assert-${stepId}`）。
 * 与 ui-executor 的 builtinActionToAssertion 保持同一映射，仅 ID 改为确定性生成。
 * 返回 null 表示无法转换（如 assertText 缺 data、assertAttribute 格式非法）。
 */
export function actionToAssertion(action: string, data: string | undefined, stepId: string): StepAssertion | null {
  const id = `assert-${stepId}`;
  switch (action) {
    case 'assertVisible':
      return { id, source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertHidden':
    case 'assertInvisible':
      return { id, source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertEnabled':
      return { id, source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertDisabled':
      return { id, source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertChecked':
      return { id, source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'true' };
    case 'assertUnchecked':
      return { id, source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'false' };
    case 'assertText':
      return data === undefined ? null : { id, source: 'UI_TEXT', operator: 'EQUALS', expectedValue: data };
    case 'assertValue':
      return data === undefined ? null : { id, source: 'UI_VALUE', operator: 'EQUALS', expectedValue: data };
    case 'assertUrl':
      return data === undefined ? null : { id, source: 'UI_PAGE_URL', operator: 'EQUALS', expectedValue: data };
    case 'assertTitle':
      return data === undefined ? null : { id, source: 'UI_PAGE_TITLE', operator: 'EQUALS', expectedValue: data };
    case 'assertAttribute': {
      if (!data || !data.includes('=')) return null;
      const eqIdx = data.indexOf('=');
      const attrName = data.slice(0, eqIdx).trim();
      const expectedValue = data.slice(eqIdx + 1).trim();
      if (!attrName) return null;
      return { id, source: 'UI_ATTRIBUTE', expression: attrName, operator: 'EQUALS', expectedValue };
    }
    default:
      return null;
  }
}

/** 步骤的规范化元素标识（target 或 recorder locator selector，归一后比较） */
function canonicalSelector(step: TestStep): string | undefined {
  const raw = step.target ?? (step.metadata as any)?.recorder?.locator?.selector;
  if (!raw) return undefined;
  return String(raw).trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 找合并目标：
 * - 元素绑定断言 → 最近的、目标元素相同的动作步骤
 * - 页面级断言（URL/Title）→ 最近的动作步骤（页面状态变化由它触发）
 */
function findMergeTarget(
  preceding: TestStep[],
  assertion: StepAssertion,
  assertStep: TestStep,
): { index: number; step: TestStep } | null {
  const assertSel = canonicalSelector(assertStep);
  for (let i = preceding.length - 1; i >= 0; i--) {
    const s = preceding[i];
    if (SKIP_FOR_MERGE.has(s.action)) continue;
    if (isPageLevelSource(assertion.source)) {
      return { index: i, step: s };
    }
    if (assertSel && canonicalSelector(s) === assertSel) {
      return { index: i, step: s };
    }
  }
  return null;
}

function withRuleAssertion(step: TestStep, assertion: StepAssertion): TestStep {
  const provenance = ((step.metadata as any)?.assertionProvenance ?? {}) as Record<string, string>;
  return {
    ...step,
    assertions: [...(step.assertions ?? []), assertion],
    metadata: {
      ...(step.metadata ?? {}),
      assertionProvenance: { ...provenance, [assertion.id]: 'rule' },
    },
  };
}

/**
 * 归一化管道入口：把 assert 动作步骤收敛为内联断言或独立断言步骤。
 * 返回新数组，不修改输入。幂等——已归一化的步骤原样保留。
 */
export function normalizeAssertSteps(steps: TestStep[]): TestStep[] {
  const out: TestStep[] = [];
  for (const step of steps) {
    if (!isAssertAction(step.action)) {
      out.push(step);
      continue;
    }
    // assertNotExist 由执行引擎原生处理，保持独立步骤
    if (step.action === 'assertNotExist') {
      out.push(step);
      continue;
    }
    // 已携带显式断言 = 已归一化，保持原样（幂等）
    if (step.assertions && step.assertions.length > 0) {
      out.push(step);
      continue;
    }
    const assertion = actionToAssertion(step.action, step.data, step.id);
    if (!assertion) {
      out.push(step);
      continue;
    }

    const target = findMergeTarget(out, assertion, step);
    if (target) {
      out[target.index] = withRuleAssertion(target.step, assertion);
    } else {
      // Form B · 独立断言步骤：保留 assert 动作 + 显式断言；
      // 页面级断言的目标不是元素选择器，清空避免运行期误解析。
      const standalone: TestStep = isPageLevelSource(assertion.source)
        ? { ...step, target: undefined }
        : step;
      out.push(withRuleAssertion(standalone, assertion));
    }
  }
  return out;
}