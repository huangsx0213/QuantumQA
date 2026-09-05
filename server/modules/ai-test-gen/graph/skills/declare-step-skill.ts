/**
 * declare_step / declare_case 工具 —— Tool Use 强制结构化输出 (Stage 1+2)
 *
 * 核心目标：保证 Designer LLM 写出的每一步 action 都在 action 词表内。
 * 通过把动作拆成 `verb` (enum) + `targetHint` (text) + `data` (text) + `expectation` (struct)，
 * 并要求 LLM 通过工具调用声明（而非自由文本），让 schema 在 API 层就强制约束：
 * - verb 必须是 GENERATABLE_ACTION_VERBS 之一（enum，API 层拒任何非词表值）
 * - fill/select/navigate/upload/press 必须携带 data（superRefine 在工具层拒）
 * - verify/waitFor 必须携带 expectation（同上）
 *
 * 这些强制发生在 LLM 调用工具时——比"写完再校验"早一步，让 LLM 当场拿到反馈自纠，
 * 不再因整批拒绝而浪费 3 次 Phase 2 重试。
 *
 * 工具本身不做事（仅返回 ack），真正的工作是 Phase 1-declare-extract
 * （utils.ts callLLMWithStructuredOutput）从 toolCallRecords 中收集 declare_* 调用，
 * 拼装成 draftTestCases JSON，喂给 DesignerRuntimeSchema.parse 验证。
 */
import { z } from 'zod';
import {
  GENERATABLE_ACTION_VERBS,
  ASSERTABLE_EXPECTATION_KINDS,
  type ActionVerb,
  type ExpectationKind,
} from 'shared/recording/nl-intent.ts';
import type { SkillDefinition } from '../nodes/types.ts';
import { Log } from '../../../../shared/services/logger.ts';

// 与 validateStepContract (shared/recording/nl-intent.ts) 保持一致；该常量
// 在 shared 内部未导出，复制一份并以注释标明一致性铁律对接点。
const DATA_REQUIRED_VERBS = ['fill', 'select', 'navigate', 'upload', 'press'] as const;
const ELEMENT_STATE_VALUES = ['enabled', 'disabled', 'checked', 'unchecked'] as const;

// === Schema: 共享的 expectation 子结构 ===
const expectationSchema = z.object({
  kind: z.enum(ASSERTABLE_EXPECTATION_KINDS as unknown as [ExpectationKind, ...ExpectationKind[]]),
  value: z.string().max(500).optional(),
  expression: z.string().max(200).optional(),
  method: z.string().max(20).optional(),
  urlPattern: z.string().max(300).optional(),
});

// === Schema: 单个 step 的子结构（单步模式与批量 steps 数组共用） ===
// verb 强制 enum —— API 层拒任何非词表动词。data/expectation 强制按 verb 配对。
const stepBodySchema = z.object({
  stepNumber: z.number().int().min(1).max(999).optional().describe(
    'Optional 1-based step number within the case. Omit to auto-number in array order.',
  ),
  verb: z.enum(GENERATABLE_ACTION_VERBS as unknown as [ActionVerb, ...ActionVerb[]]).describe(
    'The vocabulary verb — FIRST word of the action sentence. MUST be from the closed enum; the API rejects any other value.',
  ),
  targetHint: z.string().min(1).max(500).describe(
    'The human-readable target description (e.g. "username input field", "Sign in button").',
  ),
  data: z.string().max(500).optional().describe(
    'Required for fill/select/navigate/upload/press: input value, URL, option value, key name, or file path. Optional for other verbs.',
  ),
  expectation: expectationSchema.optional().describe(
    'Required for verify/waitFor (asserts an existing state). Optional for other verbs.',
  ),
  expected: z.string().max(500).optional().describe(
    'Human-readable expected outcome of the step (e.g. "The username field displays \'admin\' with no client-side validation error."). The Quality layer and Recorder surface this; the schema requires it as a non-empty string, so the system defaults to "" if you omit it. Prefer to provide it for human-readable clarity.',
  ),
});

function validateStepBody(val: z.infer<typeof stepBodySchema>, ctx: z.RefinementCtx): void {
  // data 必填动词：空串也视为缺失（"" 表示"清空"，应由 clear/verify 表达；
  // 若放行则 constructStep 丢弃空串 → validateStepContract 报 fill 缺 data → 整批回退 JSON）。
  if (DATA_REQUIRED_VERBS.includes(val.verb as any) && (val.data == null || val.data === '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: `verb "${val.verb}" requires a non-empty data value (input value / URL / key name / file path). For empty-field steps use "clear <target>" or "verify <target> is empty" instead of "${val.verb}" with an empty value.`,
    });
  }
  if ((val.verb === 'verify' || val.verb === 'waitFor') && !val.expectation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectation'],
      message: `verb "${val.verb}" is assertion-only and MUST carry an expectation. Populate the expectation field.`,
    });
  }
  if (val.expectation?.kind === 'element-state' && (!val.expectation.value || !ELEMENT_STATE_VALUES.includes(val.expectation.value as any))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectation', 'value'],
      message: `expectation.value for element-state must be one of: ${ELEMENT_STATE_VALUES.join(', ')}.`,
    });
  }
  if (val.verb === 'navigate' && val.data && /\s/.test(val.data.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: `navigate data must be a URL or space-free app-relative path (e.g. "/login"). Got "${val.data}".`,
    });
  }
}

// === declare_step：支持两种形态 ===
//   1. 批量（推荐）：一次声明整个 case 的全部 steps ── `steps` 数组，
//      stepNumber 缺省时按数组顺序自动编号。LLM 一次调用即可完成一个 case，
//      不再需要每步一次调用 → 大幅减少 ReAct 轮数（MAX_REACT_ROUNDS 相应提高）。
//   2. 单步（向后兼容）：`verb`+`targetHint`（+可选 stepNumber），一次声明一步。
// 两种形态二选一（都有或都没有都会被 superRefine 拒绝）。
const declareStepArgsSchema = z.object({
  caseId: z.string().min(1).max(200).describe(
    'The test case id these steps belong to (e.g. "TC-001"). Must match the `id` of a prior declare_case call.',
  ),
  steps: z.array(stepBodySchema).min(1).max(200).optional().describe(
    'ALL steps of this test case, in order. `stepNumber` may be omitted — it auto-numbers as 1,2,3… in array order. Prefer this batch form to declare the entire case in ONE call when a case has 2+ steps (single-step cases may also use the flat verb/targetHint fields below).',
  ),
  stepNumber: z.number().int().min(1).max(999).optional().describe(
    '1-based step number within the case (single-step form only).',
  ),
  verb: z.enum(GENERATABLE_ACTION_VERBS as unknown as [ActionVerb, ...ActionVerb[]]).optional().describe(
    'Vocabulary verb (single-step form only).',
  ),
  targetHint: z.string().min(1).max(500).optional().describe(
    'Human-readable target description (single-step form only).',
  ),
  data: z.string().max(500).optional().describe(
    'Input value / URL / key (single-step form only; required for fill/select/navigate/upload/press).',
  ),
  expectation: expectationSchema.optional().describe(
    'Expectation for verify/waitFor (single-step form only).',
  ),
  expected: z.string().max(500).optional().describe(
    'Human-readable expected outcome (single-step form only).',
  ),
}).superRefine((val, ctx) => {
  const hasBatch = Array.isArray(val.steps) && val.steps.length > 0;
  const hasSingle = val.verb != null || val.targetHint != null;
  if (hasBatch === hasSingle) {
    // 只能二选一：批量 steps 数组，或单步 verb/targetHint。
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasBatch ? ['verb'] : ['steps'],
      message: hasBatch
        ? 'declare_step accepts EITHER the flat single-step fields (verb/targetHint) OR the `steps` array — not both. To declare a multi-step case in one call, use the `steps` array; for a single step use verb/targetHint.'
        : 'declare_step must declare at least one step: either the flat single-step fields (verb/targetHint) or the `steps` array (all steps of the case).',
    });
    return;
  }
  if (hasBatch) {
    for (let i = 0; i < val.steps!.length; i++) {
      const s = val.steps![i];
      validateStepBody(s, { addIssue: (issue) => ctx.addIssue({ ...issue, path: ['steps', i, ...(issue.path ?? [])] }) } as any);
    }
  } else {
    validateStepBody(val as z.infer<typeof stepBodySchema>, ctx);
  }
});

// === Schema: declare_case 一次声明一个 case 的元数据 ===
const declareCaseArgsSchema = z.object({
  id: z.string().min(1).max(200).describe('Test case id (e.g. "TC-001"). Must be unique within the batch.'),
  title: z.string().min(1).max(500),
  conditionId: z.string().min(1).max(200),
  requirementId: z.string().min(1).max(200),
  coveredConditions: z.array(z.string().min(1).max(200)).default([]),
  referencedComponentConditions: z.array(z.string().min(1).max(200)).default([]),
  priority: z.string().min(1).max(50),
  category: z.string().min(1).max(50),
  testLevel: z.enum(['component', 'integration']).describe('Must be "component" or "integration" (lowercase).'),
  techniqueApplied: z.string().min(1).max(200),
  preconditions: z.array(z.string()).default([]),
  testData: z.array(z.string()).default([]),
  postconditions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

const log = Log.for('skill:declare');

/**
 * Ack function — declare_step 和 declare_case 都不做实际工作，仅返回确认。
 * 真正的工作由 Phase 1-declare-extract (utils.ts) 从 toolCallRecords 收集。
 * 返回结构包含 ok=true 和递增的 step 计数，让 LLM 看到"调用成功"的反馈。
 */
function buildDeclareAck(toolName: string, caseId: string, stepNumber?: number, stepCount?: number) {
  const detail = stepCount != null
    ? `${stepCount} steps`
    : stepNumber != null ? `step=${stepNumber}` : '';
  log.kv(toolName, `caseId=${caseId} ${detail} ── ack`);
  return {
    ok: true,
    caseId,
    stepNumber,
    stepCount,
    message: toolName === 'declare_step'
      ? stepCount != null
        ? `${stepCount} steps for case ${caseId} recorded. Case complete — move to the next case or finish.`
        : `Step ${stepNumber} for case ${caseId} recorded. Continue with the next step or the next case.`
      : `Case ${caseId} recorded. Now call declare_step for its steps.`,
  };
}

export const declareCaseSkill: SkillDefinition = {
  name: 'declare_case',
  description: 'Register a draft test case\'s metadata. Call this ONCE per test case BEFORE calling declare_step for that case. The `id` you provide here is referenced by subsequent declare_step calls via their `caseId` field. testLevel must be "component" or "integration" (lowercase).',
  schema: declareCaseArgsSchema,
  func: async (args) => buildDeclareAck('declare_case', String(args.id)),
  summarizeForState: (input) => ({ input, output: { caseId: (input as any)?.id, ack: true } }),
};

export const declareStepSkill: SkillDefinition = {
  name: 'declare_step',
  description: 'Declare the steps of a draft test case. PREFER the BATCH form: pass `caseId` + a `steps` array containing ALL steps of the case in order (omit `stepNumber` — it auto-numbers 1,2,3…). Declare the ENTIRE case in ONE call to minimize ReAct rounds. For a single-step case you may instead use the flat fields (stepNumber/verb/targetHint/data/expectation). verb MUST be a vocabulary verb (closed enum: navigate/fill/clear/select/press/click/doubleClick/rightClick/hover/drag/toggle/check/uncheck/upload/scroll/switchTo/dialog/waitFor/verify/extract) — any other value is rejected by the API. data is required for fill/select/navigate/upload/press; expectation is required for verify/waitFor. The full action sentence is reconstructed as `${verb} ${targetHint}` (with data appended if present).',
  schema: declareStepArgsSchema,
  func: async (args) => {
    const stepCount = Array.isArray(args.steps) ? args.steps.length : undefined;
    return buildDeclareAck('declare_step', String(args.caseId), stepCount != null ? undefined : Number(args.stepNumber), stepCount);
  },
  summarizeForState: (input) => ({
    input,
    output: {
      caseId: (input as any)?.caseId,
      stepCount: Array.isArray((input as any)?.steps) ? (input as any).steps.length : undefined,
      stepNumber: (input as any)?.stepNumber,
      verb: (input as any)?.verb,
      ack: true,
    },
  }),
};

export type DeclareStepArgs = z.infer<typeof declareStepArgsSchema>;
export type DeclareCaseArgs = z.infer<typeof declareCaseArgsSchema>;
