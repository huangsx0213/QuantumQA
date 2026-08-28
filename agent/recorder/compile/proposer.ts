/**
 * Compile · AI 裁决/提议（转化管线阶段 C2，Seam）
 *
 * 仅当规则层无法确定性覆盖 expected 时触发一次专用调用。
 * 硬约束（写进 schema 与 prompt）：
 *   - 断言必须溯源到 expected 原文
 *   - 元素依托只能引用证据包里的 payloadIndex，不得自行发明选择器
 *   - 页面状态不足以支撑可靠断言时必须答 unverifiable（"不确定只记日志"的机制入口）
 *
 * adapter 当前为 Stagehand extract；替换模型/SDK 只动本文件。
 */
import { z } from 'zod';
import type { EvidencePack } from '../ground.ts';
import type { RuleProposal } from './rules.ts';

export const ADJUDICATION_SOURCES = [
  'UI_TEXT', 'UI_VALUE', 'UI_ATTRIBUTE', 'UI_PAGE_URL', 'UI_PAGE_TITLE',
  'UI_ELEMENT_VISIBLE', 'UI_ELEMENT_ENABLED', 'UI_ELEMENT_CHECKED', 'UI_ELEMENT_COUNT',
] as const;

export const ADJUDICATION_OPERATORS = [
  'EQUALS', 'CONTAINS', 'NOT_EQUALS', 'NOT_CONTAINS', 'EXISTS', 'MATCHES_REGEX',
] as const;

export const AdjudicationSchema = z.object({
  verdict: z.enum(['covered', 'propose', 'unverifiable']),
  /** verdict=covered 时指向规则候选序号 */
  bindsRuleCandidate: z.number().int().min(0).optional(),
  proposal: z
    .object({
      source: z.enum(ADJUDICATION_SOURCES),
      operator: z.enum(ADJUDICATION_OPERATORS),
      expectedValue: z.string().optional(),
      /** 必须是证据包 actedElements 里的 payloadIndex 字符串形式 */
      elementRefId: z.string().optional(),
    })
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

export type Adjudication = z.infer<typeof AdjudicationSchema>;

export interface AdjudicationInput {
  /** NL 步骤期望结果原文（溯源锚点） */
  expected: string;
  /** NL 步骤动作原文 */
  actionText: string;
  evidence: EvidencePack;
  /** 规则候选清单（index 即 bindsRuleCandidate 的取值域） */
  ruleCandidates: RuleProposal[];
}

export interface ProposerAdapter {
  /** 解析失败/调用失败一律返回 null（调用方按 unverifiable 处理并记日志） */
  adjudicate(input: AdjudicationInput): Promise<Adjudication | null>;
}

/** 有界截断工具 */
function clip(s: string | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function buildAdjudicationPrompt(input: AdjudicationInput): string {
  const { expected, actionText, evidence, ruleCandidates } = input;
  const elements = evidence.actedElements
    .map((el) =>
      `  [${el.payloadIndex}] action=${el.action} tag=${el.tag ?? '?'} value=${clip(el.value, 60) || '-'} text=${clip(el.text, 60) || '-'} visible=${el.visible ?? '?'}`,
    )
    .join('\n');
  const inputs = evidence.inputValues
    .map((i) => `  ${i.name}: ${clip(i.value, 80)}`)
    .join('\n');
  const rules = ruleCandidates
    .map((r, i) => `  [${i}] ${r.source} ${r.operator} "${r.expectedValue ?? ''}"`)
    .join('\n');
  return (
    `You are compiling a UI assertion for a recorded test step.\n` +
    `Recorded action: "${actionText}"\n` +
    `Expected result (the assertion MUST trace back to this sentence): "${expected}"\n\n` +
    `Evidence pack (ground truth observed right after the action):\n` +
    `pageUrl: ${evidence.pageUrl}\n` +
    `pageTitle: ${evidence.pageTitle ?? '-'}\n` +
    `input values:\n${inputs || '  (none)'}\n` +
    `acted elements:\n${elements || '  (none)'}\n` +
    `pre-derived rule candidates:\n${rules || '  (none)'}\n\n` +
    `Answer JSON strictly matching the schema:\n` +
    `- verdict "covered": one of the rule candidates already verifies the expected result; set bindsRuleCandidate to its index.\n` +
    `- verdict "propose": no rule candidate fits; provide proposal with source/operator(/expectedValue), and elementRefId MUST be one of the acted element ids above when the assertion targets an element. Never invent selectors.\n` +
    `- verdict "unverifiable": the current page state cannot support a repeatable assertion for this expectation (e.g. transient toast, async data not loaded). Prefer this over guessing.\n` +
    `Set confidence (0-1) for propose; include a short rationale.`
  );
}

/**
 * Stagehand adapter。timeout 包装器复用 session 的 withStepTimeout。
 * 注意：Stagehand v3 必须用 (instruction, schema) 两参形态。
 */
export function createStagehandProposer(
  stagehand: any,
  withTimeout: <T>(op: string, promise: Promise<T>) => Promise<T>,
): ProposerAdapter {
  return {
    async adjudicate(input) {
      try {
        const raw = await withTimeout(
          'extract',
          stagehand.extract(buildAdjudicationPrompt(input), AdjudicationSchema),
        );
        const parsed = AdjudicationSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
