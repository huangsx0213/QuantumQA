/**
 * emit_case 工具 —— Tool Use 强制结构化输出 (Stage 1+2)
 *
 * 核心目标：保证 Designer LLM 写出的每一个 draft case 的每一步 action 都在 action 词表内。
 *
 * `emit_case` 一次声明一个完整的 draft test case（骨架元数据 + 内嵌的 `steps` 数组），
 * 替代旧的 `declare_case`（骨架）+ `declare_step`（步骤）两个工具：
 * - 调用次数减半：N 个 case = N 次调用（旧方案 = 2N 次）
 * - 通过把动作拆成 `verb` (enum) + `targetHint` + `data` + `expectation`，并让 schema
 *   在 API 层强制约束：verb 必须是 GENERATABLE_ACTION_VERBS 之一（enum 拒非词表值）、
 *   fill/select/navigate/upload/press 必须带 data、verify/waitFor 必须带 expectation。
 * - 这些强制发生在 LLM 调用工具时——比"写完再校验"早一步，让 LLM 当场自纠。
 * - 幂等覆盖：同一 `id` 多次 emit_case，后写覆盖前写（Phase 1-emit-extract 的 last-write-wins）。
 *
 * 工具本身只返回 ack（真正的工作是 Phase 1-emit-extract 从 toolCallRecords 收集并
 * 拼装成 draftTestCases JSON，喂给 DesignerRuntimeSchema.parse 验证）。
 */
import { z } from 'zod';
import {
  GENERATABLE_ACTION_VERBS,
  ASSERTABLE_EXPECTATION_KINDS,
  type ActionVerb,
  type ExpectationKind,
} from 'shared/recording/nl-intent.ts';
import type { SkillDefinition } from '../nodes/types.ts';

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

// === Schema: 单个 step 的子结构（emitter-case 的 steps 数组共用） ===
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
    'Human-readable expected outcome of the step. The Quality layer and Recorder surface this; prefer to provide it for clarity.',
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

// === Schema: emit_case 一次声明一个完整 case（骨架 + 内嵌 steps 数组） ===
const emitCaseArgsSchema = z.object({
  id: z.string().min(1).max(200).describe('Test case id (e.g. "TC-001"). Must be unique within the batch; repeating it overwrites the previous declaration.'),
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
  steps: z.array(stepBodySchema).min(1).max(200).describe(
    'ALL steps of this test case, in order. `stepNumber` may be omitted — it auto-numbers as 1,2,3… in array order.',
  ),
}).superRefine((val, ctx) => {
  for (let i = 0; i < val.steps.length; i++) {
    const s = val.steps[i];
    validateStepBody(s, { addIssue: (issue) => ctx.addIssue({ ...issue, path: ['steps', i, ...(issue.path ?? [])] }) } as any);
  }
});

/**
 * Ack function —— emit_case 不做实际工作，仅返回确认。
 * 真正的工作由 Phase 1-emit-extract (emit-extract.ts) 从 toolCallRecords 收集。
 * 返回 ok=true 让 LLM 看到"调用成功"的反馈。
 * Per-call ack 日志由 ReAct 循环按批合并打印（emit_case 常整轮连发，逐条打印刷屏）。
 */
function buildEmitAck(caseId: string, stepCount: number) {
  return {
    ok: true,
    caseId,
    stepCount,
    message: `Case ${caseId} emitted with ${stepCount} step(s). Emit the next case or finish when all cases are declared.`,
  };
}

export const emitCaseSkill: SkillDefinition = {
  name: 'emit_case',
  description: 'Emit ONE complete draft test case: its metadata (id, title, conditionId, requirementId, ...) AND its entire steps array (in order: verb + targetHint + data/expectation) in ONE call. Call this ONCE per test case. testLevel must be "component" or "integration" (lowercase). verb MUST be a vocabulary verb (closed enum: navigate/fill/clear/select/press/click/doubleClick/rightClick/hover/drag/toggle/check/uncheck/upload/scroll/switchTo/dialog/waitFor/verify/extract) — any other value is rejected by the API. data is required for fill/select/navigate/upload/press; expectation is required for verify/waitFor. The action sentence is reconstructed as "verb targetHint" (with data appended if present).',
  schema: emitCaseArgsSchema,
  func: async (args) => buildEmitAck(String(args.id), Array.isArray(args.steps) ? args.steps.length : 0),
  summarizeForState: (input) => ({
    input,
    output: {
      caseId: (input as any)?.id,
      stepCount: Array.isArray((input as any)?.steps) ? (input as any).steps.length : undefined,
      ack: true,
    },
  }),
};

export type EmitCaseArgs = z.infer<typeof emitCaseArgsSchema>;

// ============================================================
// F8a: bound emit_case factory — call-time reference validation
// ============================================================
// The static `emitCaseSkill` validates verb/data/expectation coupling at call
// time (the ReAct loop's schema check). This factory adds conditionId
// existence, requirementId consistency and referencedComponentConditions
// (F12) validation on top — so a dangling conditionId is caught BEFORE the
// model writes steps, and the model self-corrects in the next ReAct round
// at near-zero cost (no Phase 1.25 emit-repair / Phase 2 round trip).

export interface EmitCaseConditionInfo {
  id: string;
  requirementId: string;
  conditionType?: 'component' | 'flow';
  expectedTestLevel?: 'component' | 'integration';
}

export function createEmitCaseSkill(
  expectedConditions: EmitCaseConditionInfo[] = [],
  externalComponentReferenceIds: string[] = [],
): SkillDefinition {
  if (expectedConditions.length === 0 && externalComponentReferenceIds.length === 0) {
    return emitCaseSkill;
  }

  const byId = new Map(expectedConditions.map((c) => [c.id, c]));
  const externalRefs = new Set(externalComponentReferenceIds);

  const boundSchema = emitCaseArgsSchema.superRefine((val, ctx) => {
    const cond = byId.get(val.conditionId);
    if (!cond) {
      const validIds = [...byId.keys()].slice(0, 30).join(', ');
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditionId'],
        message: `conditionId "${val.conditionId}" is not in the current batch conditions. Valid ids: ${validIds}.`,
      });
      return;
    }
    if (val.requirementId !== cond.requirementId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirementId'],
        message: `requirementId "${val.requirementId}" does not match condition ${cond.id}'s requirement "${cond.requirementId}". Set requirementId to "${cond.requirementId}".`,
      });
    }
    if (cond.expectedTestLevel && val.testLevel !== cond.expectedTestLevel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['testLevel'],
        message: `testLevel "${val.testLevel}" but condition ${cond.id} expects "${cond.expectedTestLevel}". Honor the Analyst's tag.`,
      });
    }
    for (let i = 0; i < val.referencedComponentConditions.length; i++) {
      const refId = val.referencedComponentConditions[i];
      if (externalRefs.has(refId)) continue;
      const ref = byId.get(refId);
      if (!ref) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['referencedComponentConditions', i],
          message: `"${refId}" is not a known condition id or external component reference. Remove it or use a valid id.`,
        });
      } else if (ref.conditionType !== 'component') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['referencedComponentConditions', i],
          message: `"${refId}" is a ${ref.conditionType} condition — only component-typed conditions can be referenced. Move it to coveredConditions.`,
        });
      }
    }
  });

  return {
    ...emitCaseSkill,
    schema: boundSchema,
  };
}