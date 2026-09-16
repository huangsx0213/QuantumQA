import { z } from 'zod';
import { nlStepIntentSchema, validateStepContract, parseActionVerb, type NlStepIntent } from 'shared/recording/nl-intent.ts';
import { draftTestCaseContractSchema, draftStepContractSchema, type DraftTestCaseContract } from 'shared/recording/agent-contracts.ts';
import { makeSchemaOpenAICompatible, zodToJsonSchema, tryExtractFromEmitTools } from '../nodes/utils.ts';
import {
  arrayFromRecordValues,
  coerceNumber,
  coercedStringSchema,
  formatZodValidationError,
  normalizeNlStepIntent,
  normalizeTestLevel,
  nullToEmptyArray,
  wrapSingleObjectInArray,
} from './helpers.ts';
import type { StructuredOutputProfile } from './profile.ts';
import { throwRepairGaps, type RepairGap } from './repair-plan.ts';

// ============================================================
// DraftCase 步骤：from draftStepContractSchema
// F3: step-atomicity style constraints (compound signals, semicolons in
// expected) moved OUT of the schema superRefine into a compile gate in
// normalize(). The schema only retains length caps (true structural
// constraints). A step that writes "fill X, then click Y" is usable —
// rejecting 19 good cases for 1 style violation is the wrong trade.
// ============================================================
const DesignerStepSchema = draftStepContractSchema.extend({
  action: z.string().max(500).superRefine((val, ctx) => {
    const v = String(val ?? '').trim();
    if (v.length > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `action must be a single operation (<= 200 chars), got ${v.length} chars. Split into multiple steps. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
      });
    }
  }),
  expected: z.string().max(500).superRefine((val, ctx) => {
    const v = String(val ?? '');
    if (v.length > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected must be a single observable outcome (<= 200 chars), got ${v.length} chars. Split into multiple steps. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
      });
    }
  }),
});

const DesignerStepsSchema = z.array(DesignerStepSchema).min(1).superRefine((steps, ctx) => {
  // docs/08：动作类型自 action 首词解析，与 intent 的 data/expectation 交叉校验（通用，不逐词写死）。
  for (const step of steps) {
    const issues = validateStepContract(
      String(step.action ?? ''),
      step.intent as NlStepIntent | undefined,
    );
    for (const issue of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: issue,
      });
    }
  }
});

// ============================================================
// DraftCase：from draftTestCaseContractSchema（SSOT）
//   局部覆盖：steps（F18 门）、testData（coercedString）、
//   selfReview（default/catch 截断容忍）
// ============================================================
const DesignerCaseSchema = z.object({
  ...draftTestCaseContractSchema.shape,
  testData: z.array(coercedStringSchema),
  steps: DesignerStepsSchema,
  selfReview: z.object({
    score: z.number().min(1).max(10),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    suggestions: z.array(z.string()),
  }).default({ score: 7, strengths: [], weaknesses: [], suggestions: [] })
    .catch({ score: 7, strengths: [], weaknesses: [], suggestions: [] }),
});

const DesignerRuntimeSchema = z.object({
  draftTestCases: z.array(DesignerCaseSchema).min(1),
});

type DesignerRuntimeOutput = z.infer<typeof DesignerRuntimeSchema>;

interface ConditionInfo {
  id: string;
  requirementId: string;
  expectedTestLevel?: 'component' | 'integration';
  conditionType?: 'component' | 'flow';
}

function validateConditionCoverage(
  parsed: DesignerRuntimeOutput,
  expectedConditions: ConditionInfo[],
  gaps: RepairGap[],
  issues: z.core.$ZodIssue[],
): DesignerRuntimeOutput {
  if (expectedConditions.length === 0) return parsed;

  const expectedByCondition = new Map(expectedConditions.map((condition) => [condition.id, condition]));
  const seenCaseIds = new Set<string>();
  const coveredConditionIds = new Set<string>();
  for (const testCase of parsed.draftTestCases) {
    if (seenCaseIds.has(testCase.id)) {
      gaps.push({ type: 'identity-mismatch', entityId: testCase.id, field: 'id', fix: `rename this case to a unique id (duplicate: ${testCase.id})` });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Duplicate draft test case id: ${testCase.id}`, input: testCase });
      continue;
    }
    seenCaseIds.add(testCase.id);

    const expected = expectedByCondition.get(testCase.conditionId);
    if (!expected) {
      gaps.push({ type: 'identity-mismatch', entityId: testCase.id, field: 'conditionId', badValue: testCase.conditionId, fix: 'set conditionId to a real analyst condition id' });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} uses conditionId "${testCase.conditionId}" outside the current Analyst conditions`, input: testCase });
      continue;
    }
    for (let ci = 0; ci < testCase.coveredConditions.length; ci++) {
      const conditionId = testCase.coveredConditions[ci];
      if (expectedByCondition.has(conditionId)) {
        coveredConditionIds.add(conditionId);
        continue;
      }
      // Auto-fix: LLM 常把 requirementId（如 req-aut-auth-session-invalid）
      // 误塞进 coveredConditions（应放 condition ID 如 C-008）。flow condition 的
      // requirementId 就是 flow AC id，如果唯一匹配，remap 到那个 condition 的 id。
      const matches = expectedConditions.filter((c) => c.requirementId === conditionId);
      if (matches.length === 1) {
        testCase.coveredConditions[ci] = matches[0].id;
        coveredConditionIds.add(matches[0].id);
        continue;
      }
      gaps.push({ type: 'bad-reference', entityId: testCase.id, field: 'coveredConditions', badValue: conditionId, fix: `coveredConditions must contain condition IDs (e.g. "C-008"), not requirement IDs (e.g. "req-..."). Remove "${conditionId}" or replace with the matching condition id` });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} includes conditionId "${conditionId}" in coveredConditions outside the current Analyst conditions`, input: testCase });
    }
    coveredConditionIds.add(testCase.conditionId);

    if (testCase.requirementId !== expected.requirementId) {
      gaps.push({ type: 'identity-mismatch', entityId: testCase.id, field: 'requirementId', badValue: testCase.requirementId, fix: `set requirementId to "${expected.requirementId}"` });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} has requirementId "${testCase.requirementId}" but condition ${testCase.conditionId} belongs to requirement "${expected.requirementId}"`, input: testCase });
    }
    if (expected.expectedTestLevel && testCase.testLevel !== expected.expectedTestLevel) {
      gaps.push({ type: 'wrong-value', entityId: testCase.id, field: 'testLevel', badValue: testCase.testLevel, fix: `set testLevel to "${expected.expectedTestLevel}"` });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} has testLevel "${testCase.testLevel}" but condition ${testCase.conditionId} was tagged "${expected.expectedTestLevel}" by the Analyst. Honor the Analyst's tag.`, input: testCase });
    }
  }
  const missingConditionIds = expectedConditions
    .filter((c) => !coveredConditionIds.has(c.id))
    .map((c) => c.id);

  if (missingConditionIds.length > 0) {
    gaps.push({ type: 'missing-entity', entityId: missingConditionIds.join(','), field: 'draftTestCases', fix: `emit a test case covering each missing condition: ${missingConditionIds.join(', ')}` });
    issues.push({ code: 'custom', path: ['draftTestCases'], message: `Missing draft test cases for conditionIds: ${missingConditionIds.join(', ')}`, input: parsed });
  }

  return parsed;
}

function wrapDesignerRoot(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    if ('draftTestCases' in input) return input;
    if ('steps' in input || 'conditionId' in input || 'title' in input) {
      return { draftTestCases: wrapSingleObjectInArray(input) };
    }
    // Handle array-like objects: { "0": {...}, "1": {...}, ... }
    // Some LLMs serialize an array as an object with numeric string keys.
    const keys = Object.keys(input);
    if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
      return { draftTestCases: arrayFromRecordValues(input) };
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

/**
 * 非动词首词 action 的确定性改写：LLM 常写 "leave/ensure the username field
 * empty/is empty" 这类断言式动作，parseActionVerb 无法解析出动词，
 * validateStepContract 会拒绝整个 draft 并触发 Phase 2 三次重跑（实测一次
 * 白烧 127k tokens / 3.6 分钟）。这里把明确且安全的模式改写为合法断言
 * （verify + 合成 expectation），既保语义又不浪费重试。零 LLM、确定性，
 * 与 docs/08「LLM 只在作者期当编译器」原则一致。
 * 返回 null 表示无匹配（保持原样，交给重试链路）。
 */
type SynthesizedExpectation = { kind: 'value' | 'element-visible' | 'element-hidden' | 'element-state'; value?: string };

const STATE_TO_EXPECTATION: Readonly<Record<string, SynthesizedExpectation>> = {
  'empty': { kind: 'value', value: '' },
  'visible': { kind: 'element-visible' },
  'hidden': { kind: 'element-hidden' },
  'not visible': { kind: 'element-hidden' },
  'not present': { kind: 'element-hidden' },
  'absent': { kind: 'element-hidden' },
  'checked': { kind: 'element-state', value: 'checked' },
  'unchecked': { kind: 'element-state', value: 'unchecked' },
  'enabled': { kind: 'element-state', value: 'enabled' },
  'disabled': { kind: 'element-state', value: 'disabled' },
};

function rewriteNonVerbAction(action: string): { action: string; expectation: SynthesizedExpectation } | null {
  const trimmed = String(action ?? '').trim();
  if (parseActionVerb(trimmed)) return null;
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

  // "leave <target> empty"（无 is）—— 既有模式，保留兼容
  const leaveEmpty = /^leave\s+(.+?)\s+empty$/i.exec(trimmed);
  if (leaveEmpty) {
    return { action: `verify ${collapse(leaveEmpty[1])} is empty`, expectation: { kind: 'value', value: '' } };
  }

  // "ensure/leave/make sure <target> is <state>" —— LLM 最高频的非法断言首词
  // （designer-rules 旧版曾以 "Ensure the X field is empty" 作为拆分正例，直接
  // 教 LLM 产出被拒输出）。此处确定性收口。
  const ensureState = /^(?:ensure|leave|make\s+sure)\s+(.+?)\s+is\s+(empty|visible|hidden|not\s+visible|not\s+present|absent|checked|unchecked|enabled|disabled)$/i.exec(trimmed);
  if (ensureState) {
    const target = collapse(ensureState[1]);
    const state = ensureState[2].toLowerCase();
    const expectation = STATE_TO_EXPECTATION[state];
    if (expectation) return { action: `verify ${target} is ${state}`, expectation };
  }

  return null;
}

// === intent.data 确定性提取（处理 "fill X with 'Y'" 这类值在文本但未结构化的情况） ===

/**
 * 与 validateStepContract 一致的"需要 data 的动词"闭表（shared 内部未导出，
 * 在此保持一致）。validateStepContract 是唯一消费方（recorder 不依赖），
 * 但为防止词表漂移，注释指明一致性铁律的对接点。
 */
const DATA_REQUIRED_VERBS: readonly string[] = ['fill', 'select', 'navigate', 'upload', 'press'];

function unwrapQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return t.slice(1, -1);
  }
  return t;
}

/**
 * 从 action 文本中确定性提取 intent.data 的候选值。
 * 返回 string（含 ""）或 null（无法可靠提取）。
 * 设计原则：仅在模式明确时提取（带引号 > 明确的位置 > 单 token），宁可漏提让 gate 兜底。
 */
function extractDataFromAction(verb: string, action: string): string | null {
  const a = String(action ?? '').trim();

  // 1. "with '<value>'" / 'with "<value>"' — 最可靠：fill/upload/press 都常见
  const withQuoted = /\bwith\s+['"]([^'"]*)['"]/i.exec(a);
  if (withQuoted) return withQuoted[1];

  // 2. "fill '<value>' into <target>" — fill 的另一常用变体
  if (verb === 'fill') {
    const intoQuoted = /\bfill\s+['"]([^'"]*)['"]\s+(?:into|in|to)\b/i.exec(a);
    if (intoQuoted) return intoQuoted[1];
  }

  // 3. "select '<value>' from <target>"
  if (verb === 'select') {
    const fromQuoted = /\bselect\s+['"]([^'"]*)['"]\s+from\b/i.exec(a);
    if (fromQuoted) return fromQuoted[1];
  }

  // 4. navigate: 仅提取真正的 URL / 绝对路径（"the login page" 不提取）
  if (verb === 'navigate') {
    const url = /(https?:\/\/[^\s'"]+|\/[^\s'"]*)/.exec(a);
    if (url) return url[1];
    return null;
  }

  // 5. press: 带引号的键名
  if (verb === 'press') {
    const quoted = /['"]([^'"]+)['"]/.exec(a);
    if (quoted) return quoted[1];
    return null;
  }

  // 6. fill/upload: "with <single-token>" 兜底（无引号情况）
  if (verb === 'fill' || verb === 'upload') {
    const withToken = /\bwith\s+(\$\{[^}]+\}|\S+)/i.exec(a);
    if (withToken) return withToken[1];
  }

  return null;
}

/**
 * 将 "fill <target> with ''"（显式空值）改写为 "clear <target>"——语义等价
 * （清空字段 = 填充空串），且 clear 词表动词无需 intent.data。
 * 仅在目标可识别时改写；返回 null 表示保持原样。
 */
function rewriteFillEmptyToClear(action: string): string | null {
  const m = /\bfill\s+(.+?)\s+with\s+['"]([^'"]*)['"]\s*$/i.exec(String(action ?? '').trim());
  if (!m) return null;
  const target = m[1].trim();
  // 空字符串（提取后的值）才改写；非空让 fill 正常处理
  if (m[2] !== '') return null;
  return `clear ${target}`;
}

function getIntentData(intent: unknown): unknown {
  if (intent && typeof intent === 'object' && !Array.isArray(intent)) {
    return (intent as Record<string, unknown>).data;
  }
  return undefined;
}

// ============================================================
// F3: step-atomicity compile gate
// ============================================================
// Compound signals (", then", "while <gerund>", "but leave/without",
// semicolons in expected) were previously hard-rejected by superRefine,
// discarding 19 good cases for 1 style violation. They are now detected
// here in normalize() and logged as needs-review warnings — the step
// passes through unchanged. The Quality layer can surface these flags.
// Auto-splitting is deferred: the expected-field redistribution after a
// split is semantically ambiguous (which step owns which assertion?),
// so we flag rather than risk a wrong split.

const COMPOUND_ACTION_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwhile\s+(leaving|entering|typing|clicking|submitting|selecting|filling|pressing|choosing|checking|unchecking|ensuring|setting|clearing|providing|keeping|maintaining)\b/i, 'while <gerund>'],
  [/,\s*then\b/i, '", then"'],
  [/\bbut\s+(leave|don.?t|do\s+not|without)\b/i, '"but leave/without"'],
  [/\bboth\b/i, '"both"'],
];

function flagCompoundSteps(steps: Record<string, unknown>[]): void {
  for (const step of steps) {
    const action = String(step.action ?? '').trim();
    const expected = String(step.expected ?? '');
    const flags: string[] = [];
    for (const [pattern, label] of COMPOUND_ACTION_SIGNALS) {
      if (pattern.test(action)) flags.push(`action:${label}`);
    }
    const segments = expected.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) flags.push(`expected:${segments.length} semicolon-separated assertions`);
    if (flags.length > 0) {
      step._needsReview = flags.join('; ');
    }
  }
}

function normalizeDraftTestCase(
  value: unknown,
): Record<string, unknown> {
  const tc = value && typeof value === 'object' ? value as Record<string, unknown> : {};

const steps = Array.isArray(tc.steps)
    ? tc.steps.map((step) => {
        const normalizedStep = step && typeof step === 'object' ? step as Record<string, unknown> : {};
        const action = String(normalizedStep.action ?? '').trim();
        let intent = normalizeNlStepIntent(normalizedStep.intent);
        const rewritten = parseActionVerb(action) ? null : rewriteNonVerbAction(action);
        if (rewritten) {
          normalizedStep.action = rewritten.action;
          // verify 步骤必须携带 expectation，否则 validateStepContract 仍会拒绝
          const exp = intent && typeof intent === 'object' ? (intent as Record<string, unknown>).expectation : undefined;
          if (!exp) {
            intent = { targetHint: (intent as Record<string, unknown>)?.targetHint as string | undefined, expectation: rewritten.expectation };
          }
        }

        // 确定性补齐 intent.data：LLM 频繁将值写入 action 文本却遗漏结构化 intent.data 字段，
        // 导致 validateStepContract 拒整批并耗尽 Phase 2 重试（实测整批失败 + 触发 429）。
        // 在 normalize() 阶段从文本中提取确定性可识别的值。空串 "fill X with ''"
        // 改写为 "clear X"（语义等价，且 clear 词表动词无需 data）。
        const finalAction = String(normalizedStep.action ?? '').trim();
        const finalVerb = parseActionVerb(finalAction);
        if (finalVerb && DATA_REQUIRED_VERBS.includes(finalVerb)) {
          const explicitData = getIntentData(intent);
          const extracted = explicitData == null ? extractDataFromAction(finalVerb, finalAction) : null;
          if (finalVerb === 'fill' && (extracted === '' || explicitData === '')) {
            const cleared = rewriteFillEmptyToClear(finalAction);
            if (cleared) {
              normalizedStep.action = cleared;
              if (intent && typeof intent === 'object') delete (intent as Record<string, unknown>).data;
            }
          } else if (extracted != null && extracted !== '' && explicitData == null) {
            intent = { ...(intent as Record<string, unknown> ?? {}), data: extracted };
          }
        }

        return {
          ...normalizedStep,
          stepNumber: coerceNumber(normalizedStep.stepNumber),
          intent,
        };
      })
    : tc.steps;

  // F3: flag compound-action steps as needs-review (does not reject or split).
  if (Array.isArray(steps)) flagCompoundSteps(steps as Record<string, unknown>[]);

  const selfReview = tc.selfReview && typeof tc.selfReview === 'object' && !Array.isArray(tc.selfReview)
    ? {
        ...(tc.selfReview as Record<string, unknown>),
        score: coerceNumber((tc.selfReview as Record<string, unknown>).score),
      }
    : tc.selfReview;

  return {
    ...tc,
    testLevel: normalizeTestLevel(tc.testLevel),
    coveredConditions: nullToEmptyArray(tc.coveredConditions as string[] | null | undefined),
    referencedComponentConditions: nullToEmptyArray(tc.referencedComponentConditions as string[] | null | undefined),
    steps,
    postconditions: nullToEmptyArray(tc.postconditions as string[] | null | undefined),
    tags: nullToEmptyArray(tc.tags as string[] | null | undefined),
    selfReview,
  };
}

/**
 * F11 / F12 — Hard validation for integration case references.
 *
 * For every `testLevel: "integration"` case:
 * 1. `referencedComponentConditions` MUST be non-empty (the integration case
 *    must name which component conditions it assumes as preconditions).
 * 2. Each id in `referencedComponentConditions` must refer to a real
 *    condition in the expected set AND that condition must be of type
 *    `component` (integration cases cannot reference other flow conditions).
 *
 * No auto-fix: the LLM must provide correct values. Schema rejection +
 * Phase 2 retry is the source-level enforcement.
 */
function validateFlowCaseReferences(
  parsed: DesignerRuntimeOutput,
  expectedConditions: ConditionInfo[],
  externalComponentReferenceIds: string[],
  gaps: RepairGap[],
  issues: z.core.$ZodIssue[],
): DesignerRuntimeOutput {
  if (expectedConditions.length === 0) return parsed;

  const byId = new Map(expectedConditions.map((c) => [c.id, c]));
  const externalComponentReferences = new Set(externalComponentReferenceIds);
  // F11 only applies when there is a component condition that COULD be referenced.
  // When the batch has no component conditions at all (their component stories were
  // out-of-scope or handled in another batch that contributed no injectable refs),
  // demanding a non-empty referencedComponentConditions is unsatisfiable and drives
  // the Designer into a retry loop (integration case → empty → rejected → retried).
  // In that case accept empty referencedComponentConditions: the component
  // dependencies are expressed as preconditions instead. ("不确定就降级，绝不硬塞")
  const hasReferencableComponentConditions =
    expectedConditions.some((c) => c.conditionType === 'component')
    || externalComponentReferences.size > 0;

  for (const testCase of parsed.draftTestCases) {
    if (testCase.coveredConditions.length === 0 && testCase.conditionId) {
      testCase.coveredConditions = [testCase.conditionId];
    }

    // F11: integration cases must declare at least one referenced component condition.
    if (testCase.testLevel === 'integration'
      && testCase.referencedComponentConditions.length === 0
      && hasReferencableComponentConditions) {
      gaps.push({ type: 'missing-entity', entityId: testCase.id, field: 'referencedComponentConditions', fix: 'list the component-typed condition ids this integration case assumes as preconditions' });
      issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} has testLevel="integration" but referencedComponentConditions is empty. Integration cases must explicitly list the component conditions they assume as preconditions (use coveredConditions to record which flow condition this case covers, referencedComponentConditions to record the component behaviors it depends on).`, input: testCase });
    }

    // F12: every reference on every case must be an approved component condition.
    for (const refId of testCase.referencedComponentConditions) {
      if (externalComponentReferences.has(refId)) continue;
      const ref = byId.get(refId);
      if (!ref) {
        gaps.push({ type: 'bad-reference', entityId: testCase.id, field: 'referencedComponentConditions', badValue: refId, fix: `remove the unknown condition "${refId}" from referencedComponentConditions` });
        issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} references unknown condition "${refId}" in referencedComponentConditions. Reference must be a current-batch component condition id or an injected qualified component reference.`, input: testCase });
        continue;
      }
      if (ref.conditionType !== 'component') {
        const componentConditionIds = expectedConditions
          .filter(c => c.conditionType === 'component')
          .map(c => c.id);
        gaps.push({ type: 'bad-reference', entityId: testCase.id, field: 'referencedComponentConditions', badValue: refId, fix: `move "${refId}" to coveredConditions (it is flow-typed) and reference a component-typed condition instead` });
        issues.push({ code: 'custom', path: ['draftTestCases'], message: `Draft test case ${testCase.id} references condition "${refId}" of type "${ref.conditionType}" in referencedComponentConditions, but only component-typed conditions may be referenced as integration-case preconditions. FIX: (1) Remove "${refId}" from referencedComponentConditions and add it to coveredConditions instead. (2) Add one or more of these component-typed condition ids to referencedComponentConditions: [${componentConditionIds.join(', ')}].`, input: testCase });
      }
    }
  }

  return parsed;
}

export function createDesignerOutputProfile(
  expectedConditions: ConditionInfo[] = [],
  externalComponentReferenceIds: string[] = [],
): StructuredOutputProfile<DesignerRuntimeOutput> {
  // F5: compact ground-truth table for the extraction prompt. Phase 2
  // condenses the conversation (drops tool results) — without this block the
  // facts that validateConditionCoverage checks (conditionId ownership,
  // requirementId, testLevel) are absent from the extraction context.
  const extractionContext = expectedConditions.length > 0
    ? [
        'Current batch conditions (id | requirementId | conditionType | expectedTestLevel) — every draft case must use a conditionId from this table and keep requirementId/testLevel consistent with it:',
        ...expectedConditions.map((c) => `${c.id} | ${c.requirementId} | ${c.conditionType ?? 'unknown'} | ${c.expectedTestLevel ?? 'unknown'}`),
      ].join('\n')
    : undefined;

  return {
    toolSchema: makeSchemaOpenAICompatible(zodToJsonSchema(DesignerRuntimeSchema)),
    emitExtract: tryExtractFromEmitTools,
    extractionContext,
    shouldAttemptPhase1Extraction(raw: unknown): boolean {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const obj = raw as Record<string, unknown>;
      // Accept the standard wrapper OR a bare single test case object.
      // wrapDesignerRoot (called in normalize) handles wrapping a bare
      // {id, title, conditionId, ...} into {draftTestCases: [...]}.
      if ('draftTestCases' in obj || 'conditionId' in obj || 'steps' in obj) return true;
      // Accept array-like objects: { "0": {...}, "1": {...}, ... }
      // Some LLMs serialize an array as an object with numeric string keys.
      const keys = Object.keys(obj);
      return keys.length > 0 && keys.every(k => /^\d+$/.test(k));
    },
    normalize(raw: unknown): unknown {
      const input = wrapDesignerRoot(raw);
      return {
        draftTestCases: arrayFromRecordValues<unknown>(input.draftTestCases).map(
          (tc) => normalizeDraftTestCase(tc),
        ),
      };
    },
    parse(normalized: unknown): DesignerRuntimeOutput {
      const parsed = DesignerRuntimeSchema.parse(normalized);
      // F3: re-flag compound steps after Zod parse (which strips unknown keys
      // like _needsReview). The compile gate is idempotent — clean steps get
      // no flag, already-flagged steps are re-detected.
      for (const tc of parsed.draftTestCases) {
        flagCompoundSteps(tc.steps as Record<string, unknown>[]);
      }
      const gaps: RepairGap[] = [];
      const issues: z.core.$ZodIssue[] = [];
      validateConditionCoverage(parsed, expectedConditions, gaps, issues);
      validateFlowCaseReferences(parsed, expectedConditions, externalComponentReferenceIds, gaps, issues);
      if (gaps.length > 0) {
        throwRepairGaps(new z.ZodError(issues as any), gaps);
      }
      return parsed;
    },
    formatValidationError(error: unknown): string {
      return formatZodValidationError(error, {
        draftTestCases: 'Provide draftTestCases as a non-empty array of test cases and ensure every input conditionId is covered by at least one case.',
        'draftTestCases.testLevel': 'Each draft test case must declare testLevel as either "component" or "integration".',
        'draftTestCases.coveredConditions': 'Each draft test case must list the Analyst conditionIds it covers (use [conditionId] if unsure).',
        'draftTestCases.referencedComponentConditions': 'Integration (testLevel="integration") cases MUST list at least one component condition they assume as a precondition. Use PLAIN condition IDs only (e.g. "C-007"), NOT compound formats like "component:flowId:C-007" or "req-flow:C-007".',
        'draftTestCases.steps': 'Each draft test case needs a non-empty steps array.',
        'draftTestCases.steps.action': 'action must be a SINGLE operation (<= 200 chars) whose FIRST word is a vocabulary verb (navigate/fill/clear/select/press/click/doubleClick/rightClick/hover/drag/toggle/check/uncheck/upload/scroll/switchTo/dialog/waitFor/verify/extract). Compound signals ("while <gerund>", ", then", "but leave/without", "both", semicolons in expected) are FLAGGED for review — they do NOT reject the batch, but the Quality layer will surface them. Use "verify" (NOT "ensure"/"check that"/"observe") for assertion-only steps.',
        'draftTestCases.preconditions': 'preconditions must be concrete, settable system states (data exists, page is loaded) — NOT behavior assertions ("validation works", "UI is functional"). Use referencedComponentConditions for behavior dependencies.',
        'draftTestCases.postconditions': 'Use an array, not null, for postconditions.',
        'draftTestCases.tags': 'Use an array, not null, for tags.',
      });
    },
    extractionHints: [
      'Step atomicity (quality preference — violations are FLAGGED for review, NOT schema-rejected):',
      '- Each step should have exactly ONE action and ONE observable expected result.',
      '- `action` should be a SINGLE operation (<= 200 chars). These compound signals will be flagged:',
      '  "while" + gerund — WRONG: "fill the password field while leaving the username empty" → split: step 1 "verify the username field is empty", step 2 "fill \'test123\' into the password field". (Note: "while" with a state qualifier like "while authenticated session is active" is OK — only "while" + action gerund is compound.)',
      '  ", then" — WRONG: "fill the username field, then click submit" → split: step 1 "fill the username field", step 2 "click submit".',
      '  "but leave/without" — WRONG: "fill the username field but leave the password empty" → split: step 1 "fill the username field", step 2 "verify the password field is empty".',
      '  "both" — WRONG: "verify both username and password fields are empty" → split: step 1 "verify the username field is empty", step 2 "verify the password field is empty".',
      '- `expected` should be ≤ 200 chars and contain NO semicolons separating multiple assertions.',
      '  WRONG: "button is disabled; error message appears" (two assertions)',
      '  RIGHT: split into two steps — step A expected "button is disabled", step B expected "error message appears".',
      'Precondition quality (F12-precondition):',
      '- `preconditions` must be CONCRETE, settable system states — NOT behavior assertions.',
      '  WRONG: "Client-side validation passes (per C-005)" — this is a behavior, not a settable state.',
      '  RIGHT: "User account admin/admin123 exists in the user store" — this is a concrete data state.',
      '  WRONG: "Login page UI is functional (per C-001)" — vague behavior.',
      '  RIGHT: "Login page is loaded at /login with all form fields rendered" — concrete state.',
      '- Component behaviors the integration case assumes are declared via `referencedComponentConditions` ONLY — do NOT restate them in `preconditions`.',
      'Step intent (structured) — carry on every step (data & expectation only; the action verb lives in the action text itself):',
      '- `intent` fields: `targetHint`, `data`, `expectation { kind, value, expression, method, urlPattern }`.',
      '  The action verb (navigate/fill/select/click/check/verify/waitFor/…) MUST be the FIRST word of `action` — picked from: navigate, fill, clear, select, press, click, doubleClick, rightClick, hover, drag, toggle, check, uncheck, upload, scroll, switchTo, dialog, waitFor, verify, extract.',
      '  RESERVED (rejected): api, runModule.',
      'Action verb role (NEVER mix): web operations = navigate, fill, clear, select, press, click, doubleClick, rightClick, hover, drag, toggle, check, uncheck, upload, scroll, switchTo, dialog (real DOM interaction). Verification = verify only (pure check, NO DOM operation). Wait = waitFor.',
      '  If a state needs a user action (e.g. visiting a page by clicking a menu), write that action with the WEB verb; do NOT use verify to "perform" navigation. WRONG: "verify the page navigates to Reports". RIGHT: "click the Reports menu item" step, then "verify the URL contains /reports" step.',
      '- `intent.expectation.kind` from: url, title, text-visible, element-visible, element-hidden, value, element-state, attribute, network, api-body.',
      '  FORBIDDEN (rejected): transient (loading states / animations / focus — rewrite as an observable end state).',
      '- `verify`/`waitFor` steps MUST carry `expectation`; `fill`/`select`/`navigate`/`upload`/`press` MUST set `intent.data`.',
      '- `element-state` expectation.value ∈ enabled | disabled | checked | unchecked (REQUIRED — empty is rejected); `dialog` data ∈ accept | dismiss; `navigate` data = URL or app-relative path (e.g. "/login").',
      '  WRONG: { "action": "click the button", "intent": { "expectation": { "kind": "transient", "value": "loading" } } }',
      '  RIGHT: { "action": "click the Sign in button", "intent": { "expectation": { "kind": "network", "method": "POST", "urlPattern": "/aut-api/auth/login", "value": "200" } } }',
    ].join('\n'),
  };
}

export const designerOutputProfile: StructuredOutputProfile<DesignerRuntimeOutput> = createDesignerOutputProfile();
