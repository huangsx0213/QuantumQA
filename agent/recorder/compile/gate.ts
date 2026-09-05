/**
 * Compile · 编译门（转化管线阶段 C3，见 docs/07 §4-C）
 *
 * 提议落库前的纯代码校验，任一不过即降级（丢弃 + 原因入日志），不硬塞：
 *   1 枚举合法  2 expectedValue 必备(EXISTS 类除外)  3 confidence 达标或证据实证通过
 *   4 source 与元素类型相容（相容性矩阵）        5 targetRef 当前页唯一解析
 */
import type { Page } from 'playwright';
import type { AssertionSource, AssertionOperator } from '../../../shared/contracts/index.ts';
import type { EvidencePack, ActedElementEvidence } from '../ground.ts';

export const GATE_SOURCES: readonly AssertionSource[] = [
  'UI_TEXT', 'UI_VALUE', 'UI_ATTRIBUTE', 'UI_PAGE_URL', 'UI_PAGE_TITLE',
  'UI_ELEMENT_VISIBLE', 'UI_ELEMENT_ENABLED', 'UI_ELEMENT_CHECKED', 'UI_ELEMENT_COUNT',
  'API_BODY_JSON',
];
export const GATE_OPERATORS: readonly AssertionOperator[] = [
  'EQUALS', 'CONTAINS', 'NOT_EQUALS', 'NOT_CONTAINS', 'EXISTS', 'MATCHES_REGEX',
];

export const DEFAULT_MIN_CONFIDENCE = 0.7;

export interface GateProposal {
  source: string;
  operator: string;
  expectedValue?: string;
  expression?: string;
  /** 元素依托：边界内原始 payload 序号；页面级 source 可缺省 */
  targetPayloadIndex?: number;
  origin: 'rule' | 'ai';
  confidence?: number;
  rationale?: string;
}

/**
 * 单形状结果（非判别联合）：仓库 tsconfig 未启用 strictNullChecks，
 * 布尔字面量联合无法收窄，故 reason 恒有值、proposal 仅 ok=true 时存在。
 */
export interface GateResult {
  ok: boolean;
  /** ok=false 时的拒绝原因；ok=true 时为空串 */
  reason: string;
  /** 仅 ok=true 时存在 */
  proposal?: GateProposal;
}

/** 相容性矩阵：tag 已知时强校验；未知（探测失败）放行——缺证据不定罪 */
export function sourceCompatibleWithTag(source: string, tag?: string): boolean | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  switch (source) {
    case 'UI_VALUE':
      return t === 'input' || t === 'textarea' || t === 'select';
    case 'UI_TEXT':
      return t !== 'input';
    case 'UI_ELEMENT_CHECKED':
      return t === 'input';
    default:
      return true;
  }
}

export interface GateOptions {
  minConfidence?: number;
  /**
   * 目标唯一性解析注入（测试用）。默认 page.locator(selector).count()。
   * 返回 -1 表示无法解析（等同不唯一）。
   */
  resolveCount?: (selector: string) => Promise<number>;
}

function actedElementFor(evidence: EvidencePack, payloadIndex?: number): ActedElementEvidence | undefined {
  if (payloadIndex === undefined) return undefined;
  return evidence.actedElements.find((el) => el.payloadIndex === payloadIndex);
}

const ELEMENT_BOUND_SOURCES = new Set([
  'UI_TEXT', 'UI_VALUE', 'UI_ATTRIBUTE',
  'UI_ELEMENT_VISIBLE', 'UI_ELEMENT_ENABLED', 'UI_ELEMENT_CHECKED', 'UI_ELEMENT_COUNT',
]);

/**
 * 证据实证：编译时刻用证据包直接验证提议与观测事实是否一致。
 * 返回 true=实证通过（置信度不再是门槛）；null=该 source/operator 无法实证。
 * 原则与确认运行一致："AI 说的不算，观测到的才算"——模型自报置信度不可靠
 * （实测出现过对显而易见事实自报 0.32 的情况），能用证据证明的就不问模型。
 */
export function verifyAgainstEvidence(proposal: GateProposal, evidence: EvidencePack): boolean | null {
  const expected = proposal.expectedValue?.toLowerCase();
  if (!expected) return null;
  const el = actedElementFor(evidence, proposal.targetPayloadIndex);
  const contains = (actual: string | undefined) => actual != null && actual.toLowerCase().includes(expected);
  const equals = (actual: string | undefined) => actual != null && actual.toLowerCase() === expected;
  switch (proposal.source) {
    case 'UI_PAGE_URL':
    case 'UI_PAGE_TITLE': {
      const actual = proposal.source === 'UI_PAGE_URL' ? evidence.pageUrl : evidence.pageTitle;
      if (proposal.operator === 'CONTAINS') return contains(actual);
      if (proposal.operator === 'EQUALS') return equals(actual);
      return null;
    }
    case 'UI_TEXT': {
      if (!el) return null;
      if (proposal.operator === 'CONTAINS') return contains(el.text);
      if (proposal.operator === 'EQUALS') return equals(el.text);
      return null;
    }
    case 'UI_VALUE': {
      if (!el) return null;
      if (proposal.operator === 'CONTAINS') return contains(el.value);
      if (proposal.operator === 'EQUALS') return equals(el.value);
      return null;
    }
    case 'UI_ELEMENT_VISIBLE': {
      if (!el) return null;
      return el.visible === true;
    }
    default:
      return null;
  }
}

/** 纯校验部分（枚举/必备值/置信度或证据实证/元素依托存在性），供单测与异步门复用 */
export function checkProposalStatic(
  proposal: GateProposal,
  evidence: EvidencePack,
  opts: GateOptions = {},
): GateResult {
  const fail = (reason: string): GateResult => ({ ok: false, reason, proposal: undefined });
  if (!GATE_SOURCES.includes(proposal.source as AssertionSource)) return fail(`illegal source: ${proposal.source}`);
  if (!GATE_OPERATORS.includes(proposal.operator as AssertionOperator)) return fail(`illegal operator: ${proposal.operator}`);
  const needsValue = proposal.operator !== 'EXISTS' && proposal.operator !== 'NOT_EXISTS';
  if (needsValue && (!proposal.expectedValue || typeof proposal.expectedValue !== 'string')) {
    return fail(`operator ${proposal.operator} requires expectedValue`);
  }
  let effective = proposal;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const reported = proposal.confidence ?? (proposal.origin === 'rule' ? 1 : 0);
  if (reported < minConfidence) {
    // 置信度不足时给证据实证一次机会：观测事实背书的提议不依赖模型自报
    const verified = verifyAgainstEvidence(proposal, evidence);
    if (verified !== true) {
      return fail(`confidence ${reported.toFixed(2)} below threshold ${minConfidence} and not evidence-verifiable`);
    }
    effective = {
      ...proposal,
      confidence: 1,
      rationale: `${proposal.rationale ? `${proposal.rationale} ; ` : ''}verified against evidence at compile time`,
    };
  }
  if (ELEMENT_BOUND_SOURCES.has(effective.source)) {
    const el = actedElementFor(evidence, effective.targetPayloadIndex);
    if (!el) return fail(`${effective.source} requires an element binding present in evidence (targetPayloadIndex=${effective.targetPayloadIndex})`);
    const compat = sourceCompatibleWithTag(effective.source, el.tag);
    if (compat === false) {
      return fail(`source ${effective.source} incompatible with element tag ${el.tag}`);
    }
  }
  return { ok: true, reason: '', proposal: effective };
}

/** 完整编译门：静态校验 + targetRef 当前页唯一解析 */
export async function passesGate(
  proposal: GateProposal,
  evidence: EvidencePack,
  page: Page | null,
  opts: GateOptions = {},
): Promise<GateResult> {
  const staticResult = checkProposalStatic(proposal, evidence, opts);
  if (!staticResult.ok) return staticResult;

  if (ELEMENT_BOUND_SOURCES.has(proposal.source)) {
    const el = actedElementFor(evidence, proposal.targetPayloadIndex)!;
    if (!el.selector) return { ok: false, reason: 'element binding has no selector in evidence', proposal: undefined };
    let count: number;
    try {
      count = opts.resolveCount
        ? await opts.resolveCount(el.selector)
        : await page!.locator(el.selector).count();
    } catch (err: any) {
      return { ok: false, reason: `target resolution failed: ${err?.message?.slice(0, 120)}`, proposal: undefined };
    }
    if (count !== 1) {
      return { ok: false, reason: `target not uniquely resolvable (${count} matches): ${el.selector}`, proposal: undefined };
    }
  }
  return { ok: true, reason: '', proposal: staticResult.proposal! };
}
