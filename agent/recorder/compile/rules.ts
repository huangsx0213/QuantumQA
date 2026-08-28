/**
 * Compile · 规则层（转化管线阶段 C1，见 docs/07 §4-C）
 *
 * 由录制事实确定性推导断言提议，零 LLM。
 * 步骤种类不再解析 NL 文本——payload 动作集合本身就是事实（P3/P4 的修复）。
 */
import type { RecorderStepPayload } from '../protocol.ts';
import type { AssertionSource, AssertionOperator } from '../../../shared/contracts/index.ts';

export interface RuleProposal {
  source: AssertionSource;
  operator: AssertionOperator;
  expectedValue?: string;
  /** 依托的边界内原始 payload 序号（ground.actedElements 同键） */
  targetPayloadIndex?: number;
  origin: 'rule';
  confidence: number;
  rationale: string;
}

/** 提取值中有比对意义的词元（长度>2 的字母数字串） */
function valueTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 2 || /[\u4e00-\u9fff]/.test(t));
}

/**
 * 纯函数：从边界 payload 推导规则断言提议（可返回多条，互不排斥）：
 *   - 最近一次非空 fill/selectOption → UI_VALUE CONTAINS 实际输入值
 *   - goto → UI_PAGE_URL CONTAINS 实际 URL
 *   - check/uncheck → UI_ELEMENT_CHECKED EQUALS true/false
 */
export function deriveRuleProposals(payloads: RecorderStepPayload[]): RuleProposal[] {
  const out: RuleProposal[] = [];
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i];
    if ((p.action === 'fill' || p.action === 'selectOption') && p.value) {
      out.push({
        source: 'UI_VALUE',
        operator: 'CONTAINS',
        expectedValue: p.value,
        targetPayloadIndex: i,
        origin: 'rule',
        confidence: 1,
        rationale: `recorded ${p.action} with value`,
      });
      break;
    }
  }
  const goto = payloads.find((p) => p.action === 'goto' && p.value);
  if (goto) {
    out.push({
      source: 'UI_PAGE_URL',
      operator: 'CONTAINS',
      expectedValue: goto.value,
      origin: 'rule',
      confidence: 1,
      rationale: 'recorded navigation',
    });
  }
  const checkIdx = payloads.findIndex((p) => p.action === 'check' || p.action === 'uncheck');
  if (checkIdx >= 0) {
    const p = payloads[checkIdx];
    out.push({
      source: 'UI_ELEMENT_CHECKED',
      operator: 'EQUALS',
      expectedValue: p.action === 'check' ? 'true' : 'false',
      targetPayloadIndex: checkIdx,
      origin: 'rule',
      confidence: 1,
      rationale: `recorded ${p.action}`,
    });
  }
  return out;
}

/**
 * 纯函数：确定性覆盖裁决——expected 是否已被某条规则提议覆盖。
 * 判据保守：值类规则要求 expected 原文包含该值；URL 类要求 expected 包含
 * 主机名或路径末段。判定不出才升级到 AI 裁决（宁可多问，不可错盖）。
 */
export function findCoveringRule(expected: string, rules: RuleProposal[]): RuleProposal | null {
  const exp = expected.toLowerCase();
  for (const rule of rules) {
    const val = rule.expectedValue?.toLowerCase();
    if (!val) continue;
    if (rule.source === 'UI_PAGE_URL') {
      let hostOrPath = '';
      try {
        const u = new URL(rule.expectedValue!);
        hostOrPath = `${u.hostname} ${u.pathname}`;
      } catch {
        hostOrPath = val.replace(/^https?:\/\//, '');
      }
      const segments = hostOrPath.split(/[\s/.]+/).filter((s) => s.length > 2);
      if (segments.some((s) => exp.includes(s))) return rule;
      continue;
    }
    if (exp.includes(val)) return rule;
    const tokens = valueTokens(val);
    if (tokens.length > 0 && tokens.every((t) => exp.includes(t))) return rule;
  }
  return null;
}
