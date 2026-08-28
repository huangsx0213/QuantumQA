import { z } from 'zod';
import { nlStepIntentSchema, validateStepContract, type NlStepIntent } from 'shared/recording/nl-intent.ts';
import { makeSchemaOpenAICompatible, zodToJsonSchema } from '../nodes/utils.ts';
import {
  arrayFromRecordValues,
  coerceNumber,
  formatZodValidationError,
  nullToEmptyArray,
  wrapSingleObjectInArray,
} from './helpers.ts';
import type { StructuredOutputProfile } from './profile.ts';

/**
 * Coerce any value to a string. Handles the LLM's common mistakes:
 * - nested arrays: ["a", "b"] → "a, b"
 * - objects: {key: "val"} → '{"key":"val"}'
 * - numbers/booleans: 123 → "123"
 * This is a schema-level coercion, not a post-hoc auto-fix.
 */
const coercedString = z.preprocess((v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}, z.string());

const DesignerRuntimeSchema = z.object({
  draftTestCases: z.array(z.object({
    id: z.string(),
    title: z.string(),
    conditionId: z.string(),
    requirementId: z.string(),
    // F10: explicit list of Analyst condition ids this case covers.
    // Replaces the old single-string conditionId as the primary traceability field;
    // conditionId is kept as the "primary" condition for backward compat.
    coveredConditions: z.array(z.string()).default([]),
    // F11: for testLevel=integration cases, the component conditions this case assumes.
    // Validated at parse time (see validateFlowCaseReferences).
    referencedComponentConditions: z.array(z.string()).default([]),
    priority: z.string(),
    category: z.string(),
    testLevel: z.enum(['component', 'integration']),
    techniqueApplied: z.string(),
    preconditions: z.array(z.string()),
    testData: z.array(coercedString),
    steps: z.array(z.object({
      stepNumber: z.number(),
      // 统一测试标准（docs/08）：每步携带结构化意图（目标/数据/期望分类）。
      // 动作类型不再存 intent——由 action 文本首词解析（validateStepContract 交叉校验）。
      intent: nlStepIntentSchema.optional(),
      // F18-action: step atomicity for the `action` field. Compound `action`
      // patterns are rejected at the schema level — the LLM gets a clear
      // rejection message and self-corrects in Phase 2 retry.
      action: z.string().superRefine((val, ctx) => {
        const v = String(val ?? '').trim();
        if (v.length > 200) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `action must be a single operation (<= 200 chars), got ${v.length} chars. Split into multiple steps. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
          });
          return;
        }
        // High-precision compound-action signals drawn from observed LLM
        // violations. Each indicates 2+ actions bundled into one step.
        // "while" is narrowed to action-gerund patterns to avoid false positives
        // on state qualifiers like "while authenticated session is active".
        // NOTE: "both" is excluded from schema rejection — the LLM consistently
        // fails to self-correct it in Phase 2 (e.g. "Ensure both X and Y are
        // empty"). The rules doc and extractionHints still flag it as wrong.
        const compoundSignals: ReadonlyArray<readonly [RegExp, string]> = [
          [/\bwhile\s+(leaving|entering|typing|clicking|submitting|selecting|filling|pressing|choosing|checking|unchecking|ensuring|setting|clearing|providing|keeping|maintaining)\b/i, '"while <gerund>" (do X while doing Y)'],
          [/,\s*then\b/i, '", then" (sequential actions)'],
          [/\bbut\s+(leave|don.?t|do\s+not|without)\b/i, '"but leave/without" (contrast bundling)'],
        ];
        for (const [pattern, label] of compoundSignals) {
          if (pattern.test(v)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `action must contain a SINGLE operation — detected compound pattern ${label}. Split into multiple steps — one action per step. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
            });
          }
        }
      }),
      // F18: step atomicity — same constraint Quality enforces. Splitting
      // bundled assertions into multiple steps makes failures localizable
      // and is enforced at the earliest possible layer.
      expected: z.string().superRefine((val, ctx) => {
        const v = String(val ?? '');
        if (v.length > 200) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `expected must be a single observable outcome (<= 200 chars), got ${v.length} chars. Split into multiple steps. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
          });
          return;
        }
        const segments = v.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
        if (segments.length > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `expected must contain a single assertion (found ${segments.length} semicolon-separated segments). Split into multiple steps — one assertion per step. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`,
          });
        }
      }),
    })).min(1).superRefine((steps, ctx) => {
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
    }),
    postconditions: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    // 自评字段兜底：多用例 JSON 输出截断时 selfReview 是 case 末尾最易被截断的字段。
    // default() 覆盖整个对象缺失；catch() 覆盖对象存在但内部字段被截断（score 有、suggestions 无）。
    // 丢失自评不影响用例本身（steps/expected/intent 才是机器契约），不应让单个 case 自评缺失报废整个批次。
    selfReview: z.object({
      score: z.number().min(1).max(10),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      suggestions: z.array(z.string()),
    }).default({ score: 7, strengths: [], weaknesses: [], suggestions: [] })
      .catch({ score: 7, strengths: [], weaknesses: [], suggestions: [] }),
  })).min(1),
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
): DesignerRuntimeOutput {
  if (expectedConditions.length === 0) return parsed;

  const expectedByCondition = new Map(expectedConditions.map((condition) => [condition.id, condition]));
  const seenCaseIds = new Set<string>();
  const coveredConditionIds = new Set<string>();
  for (const testCase of parsed.draftTestCases) {
    if (seenCaseIds.has(testCase.id)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['draftTestCases'],
          message: `Duplicate draft test case id: ${testCase.id}`,
          input: testCase,
        },
      ]);
    }
    seenCaseIds.add(testCase.id);

    const expected = expectedByCondition.get(testCase.conditionId);
    if (!expected) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['draftTestCases'],
          message: `Draft test case ${testCase.id} uses conditionId "${testCase.conditionId}" outside the current Analyst conditions`,
          input: testCase,
        },
      ]);
    }
    for (const conditionId of testCase.coveredConditions) {
      if (!expectedByCondition.has(conditionId)) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['draftTestCases'],
            message: `Draft test case ${testCase.id} includes conditionId "${conditionId}" in coveredConditions outside the current Analyst conditions`,
            input: testCase,
          },
        ]);
      }
      coveredConditionIds.add(conditionId);
    }
    coveredConditionIds.add(testCase.conditionId);

    if (testCase.requirementId !== expected.requirementId) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['draftTestCases'],
          message: `Draft test case ${testCase.id} has requirementId "${testCase.requirementId}" but condition ${testCase.conditionId} belongs to requirement "${expected.requirementId}"`,
          input: testCase,
        },
      ]);
    }
    if (expected.expectedTestLevel && testCase.testLevel !== expected.expectedTestLevel) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['draftTestCases'],
          message: `Draft test case ${testCase.id} has testLevel "${testCase.testLevel}" but condition ${testCase.conditionId} was tagged "${expected.expectedTestLevel}" by the Analyst. Honor the Analyst's tag.`,
          input: testCase,
        },
      ]);
    }
  }
  const missingConditionIds = expectedConditions
    .filter((c) => !coveredConditionIds.has(c.id))
    .map((c) => c.id);

  if (missingConditionIds.length > 0) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['draftTestCases'],
        message: `Missing draft test cases for conditionIds: ${missingConditionIds.join(', ')}`,
        input: parsed,
      },
    ]);
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

function normalizeDraftTestCase(
  value: unknown,
): Record<string, unknown> {
  const tc = value && typeof value === 'object' ? value as Record<string, unknown> : {};

  const steps = Array.isArray(tc.steps)
    ? tc.steps.map((step) => {
        const s = step && typeof step === 'object' ? step as Record<string, unknown> : {};
        return {
          ...s,
          stepNumber: coerceNumber(s.stepNumber),
        };
      })
    : tc.steps;

  const selfReview = tc.selfReview && typeof tc.selfReview === 'object' && !Array.isArray(tc.selfReview)
    ? {
        ...(tc.selfReview as Record<string, unknown>),
        score: coerceNumber((tc.selfReview as Record<string, unknown>).score),
      }
    : tc.selfReview;

  return {
    ...tc,
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
): DesignerRuntimeOutput {
  if (expectedConditions.length === 0) return parsed;

  const byId = new Map(expectedConditions.map((c) => [c.id, c]));
  const externalComponentReferences = new Set(externalComponentReferenceIds);

  for (const testCase of parsed.draftTestCases) {
    if (testCase.coveredConditions.length === 0 && testCase.conditionId) {
      testCase.coveredConditions = [testCase.conditionId];
    }

    // F11: integration cases must declare at least one referenced component condition.
    if (testCase.testLevel === 'integration' && testCase.referencedComponentConditions.length === 0) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['draftTestCases'],
          message: `Draft test case ${testCase.id} has testLevel="integration" but referencedComponentConditions is empty. Integration cases must explicitly list the component conditions they assume as preconditions (use coveredConditions to record which flow condition this case covers, referencedComponentConditions to record the component behaviors it depends on).`,
          input: testCase,
        },
      ]);
    }

    // F12: every reference on every case must be an approved component condition.
    for (const refId of testCase.referencedComponentConditions) {
      if (externalComponentReferences.has(refId)) continue;
      const ref = byId.get(refId);
      if (!ref) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['draftTestCases'],
            message: `Draft test case ${testCase.id} references unknown condition "${refId}" in referencedComponentConditions. Reference must be a current-batch component condition id or an injected qualified component reference.`,
            input: testCase,
          },
        ]);
      }
      if (ref.conditionType !== 'component') {
        const componentConditionIds = expectedConditions
          .filter(c => c.conditionType === 'component')
          .map(c => c.id);
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['draftTestCases'],
            message: `Draft test case ${testCase.id} references condition "${refId}" of type "${ref.conditionType}" in referencedComponentConditions, but only component-typed conditions may be referenced as integration-case preconditions. FIX: (1) Remove "${refId}" from referencedComponentConditions and add it to coveredConditions instead. (2) Add one or more of these component-typed condition ids to referencedComponentConditions: [${componentConditionIds.join(', ')}].`,
            input: testCase,
          },
        ]);
      }
    }
  }

  return parsed;
}

export function createDesignerOutputProfile(
  expectedConditions: ConditionInfo[] = [],
  externalComponentReferenceIds: string[] = [],
): StructuredOutputProfile<DesignerRuntimeOutput> {
  return {
    toolSchema: makeSchemaOpenAICompatible(zodToJsonSchema(DesignerRuntimeSchema)),
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
      const parsed = validateConditionCoverage(DesignerRuntimeSchema.parse(normalized), expectedConditions);
      return validateFlowCaseReferences(parsed, expectedConditions, externalComponentReferenceIds);
    },
    formatValidationError(error: unknown): string {
      return formatZodValidationError(error, {
        draftTestCases: 'Provide draftTestCases as a non-empty array of test cases and ensure every input conditionId is covered by at least one case.',
        'draftTestCases.testLevel': 'Each draft test case must declare testLevel as either "component" or "integration".',
        'draftTestCases.coveredConditions': 'Each draft test case must list the Analyst conditionIds it covers (use [conditionId] if unsure).',
        'draftTestCases.referencedComponentConditions': 'Integration (testLevel="integration") cases MUST list at least one component condition they assume as a precondition. Use PLAIN condition IDs only (e.g. "C-007"), NOT compound formats like "component:flowId:C-007" or "req-flow:C-007".',
        'draftTestCases.steps': 'Each draft test case needs a non-empty steps array.',
        'draftTestCases.steps.action': 'action must be a SINGLE operation (<= 200 chars). NO "while <gerund>", ", then", or "but leave/without" — these signal 2+ bundled actions and are schema-rejected. "both" (e.g. "Ensure both X and Y are empty") should also be split into separate steps per field/target.',
        'draftTestCases.preconditions': 'preconditions must be concrete, settable system states (data exists, page is loaded) — NOT behavior assertions ("validation works", "UI is functional"). Use referencedComponentConditions for behavior dependencies.',
        'draftTestCases.postconditions': 'Use an array, not null, for postconditions.',
        'draftTestCases.tags': 'Use an array, not null, for tags.',
      });
    },
    extractionHints: [
      'Step atomicity (HARD constraint — schema validation will reject violations):',
      '- Each step must have exactly ONE action and ONE observable expected result.',
      '- `action` must be a SINGLE operation (<= 200 chars). The schema REJECTS these compound signals:',
      '  "while" + gerund — WRONG: "Enter password while leaving username empty" → split: step 1 "Leave the username field empty", step 2 "Enter \'test123\' into the password field". (Note: "while" with a state qualifier like "while authenticated session is active" is OK — only "while" + action gerund is compound.)',
      '  ", then" — WRONG: "Enter username, then click submit" → split: step 1 "Enter username", step 2 "Click submit".',
      '  "but leave/without" — WRONG: "Enter a username but leave password empty" → split: step 1 "Enter username", step 2 "Leave the password field empty".',
      '  "both" — WRONG: "Ensure both username and password fields are empty" → split: step 1 "Ensure the username field is empty", step 2 "Ensure the password field is empty".',
      '- `expected` must be ≤ 200 chars and contain NO semicolons separating multiple assertions.',
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
