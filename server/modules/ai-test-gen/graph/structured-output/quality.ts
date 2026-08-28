import { z } from 'zod';
import { nlStepIntentSchema } from 'shared/recording/nl-intent.ts';
import { makeSchemaOpenAICompatible, zodToJsonSchema } from '../nodes/utils.ts';
import {
  arrayFromRecordValues,
  coerceNumber,
  formatZodValidationError,
  nullToEmptyArray,
  nullToUndefined,
} from './helpers.ts';
import type { StructuredOutputProfile } from './profile.ts';
import { Log } from '../../../../shared/services/logger.ts';

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

// F19: step atomicity hard constraint — keep `expected` to a single observable
// outcome. Bundled assertions (containing ";" + conjunction, or > 200 chars) are
// rejected because the LLM is supposed to split them into separate steps.
const atomicExpected = (value: string): true | string => {
  const v = String(value ?? '');
  if (v.length > 200) {
    return `expected must be a single observable outcome (<= 200 chars), got ${v.length} chars. Split into multiple steps. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`;
  }
  // Reject multiple semicolon-separated assertions in a single expected.
  const segments = v.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    return `expected must contain a single assertion (found ${segments.length} semicolon-separated segments). Split into multiple steps — one assertion per step. Value: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`;
  }
  return true;
};

const QualityRuntimeSchema = z.object({
  finalTestCases: z.preprocess(
    (value) => Array.isArray(value) ? value : [],
    z.array(z.object({
      id: z.string(),
      title: z.string(),
      conditionId: z.string(),
      requirementId: z.string(),
      // F10 / F11 carried through from draft cases. Quality preserves them.
      coveredConditions: z.array(z.string()).default([]),
      referencedComponentConditions: z.array(z.string()).default([]),
      priority: z.string(),
      category: z.string(),
      testLevel: z.enum(['component', 'integration']),
      techniqueApplied: z.string(),
      preconditions: z.array(z.string()),
      testData: z.array(coercedString),
      steps: z.array(z.object({
        stepNumber: z.number(),
        action: z.string(),
        // 统一测试标准（docs/08）：透传 Designer 产出的结构化意图。
        // 可选——缺失时 Recorder 回退推断链路；prompt 要求原样保留不得改写。
        intent: nlStepIntentSchema.optional(),
        // F19: refine each step's `expected` for atomicity.
        expected: z.string().superRefine((val, ctx) => {
          const r = atomicExpected(val);
          if (r !== true) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: r,
            });
          }
        }),
      })),
      tags: z.array(z.string()).default([]),
      status: z.string().default('approved'),
      reviewSummary: z.string(),
      changeLog: z.array(z.object({
        field: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        reason: z.string(),
      })).default([]),
    })).min(1),
  ),
  // Coverage matrix: F27 — REQUIRED for new runs (was optional for backward compat).
  // The LLM is the source of truth: one row per Analyst conditionId.
  // Marked optional in the schema so legacy/older runs that pre-date F27 still
  // parse. The Quality prompt makes the field MANDATORY for new runs.
  coverageMatrix: z.object({
    rows: z.array(z.object({
      conditionId: z.string(),
      conditionSummary: z.string(),
      requirementId: z.string(),
      testLevel: z.string(),
      primaryTechnique: z.string(),
      category: z.string(),
      conditionType: z.enum(['component', 'flow']).optional(),
      flowStepRef: z.object({
        flowId: z.string(),
        sequence: z.number(),
        actionSummary: z.string().optional(),
      }).optional(),
      coveredByCaseIds: z.array(z.string()),
      coverageStatus: z.enum(['covered', 'missing']),
      notes: z.string().optional(),
    })),
    summary: z.object({
      totalConditions: z.number(),
      coveredConditions: z.number(),
      missingConditions: z.number(),
      byTestLevel: z.record(z.string(), z.number()),
      byTechnique: z.record(z.string(), z.number()),
      byCategory: z.record(z.string(), z.number()),
      // F29: condition-type breakdown so the UI can show component vs flow counts.
      byConditionType: z.record(z.string(), z.number()).optional(),
    }),
  }).optional(),
});

type QualityRuntimeOutput = z.infer<typeof QualityRuntimeSchema>;

interface ExpectedDraftCase {
  id: string;
  conditionId: string;
  requirementId: string;
  expectedTestLevel?: 'component' | 'integration';
  coveredConditions?: string[];
  referencedComponentConditions?: string[];
}

function validateDraftCaseCoverage(
  parsed: QualityRuntimeOutput,
  expectedDraftCases: ExpectedDraftCase[],
): QualityRuntimeOutput {
  if (expectedDraftCases.length === 0) return parsed;

  const expectedById = new Map(expectedDraftCases.map((draftCase) => [draftCase.id, draftCase]));
  const allowedCoveredConditionIds = new Set(
    expectedDraftCases.flatMap((draftCase) => [
      draftCase.conditionId,
      ...(draftCase.coveredConditions ?? []),
    ]),
  );
  const allowedReferencedConditionIds = new Set(
    expectedDraftCases.flatMap((draftCase) => draftCase.referencedComponentConditions ?? []),
  );
  const seenCaseIds = new Set<string>();

  for (const testCase of parsed.finalTestCases) {
    if (seenCaseIds.has(testCase.id)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['finalTestCases'],
          message: `Duplicate final test case id: ${testCase.id}`,
          input: testCase,
        },
      ]);
    }
    seenCaseIds.add(testCase.id);

    if (!expectedById.has(testCase.id)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['finalTestCases'],
          message: `Final reviewed case ${testCase.id} does not match any input draft case id`,
          input: testCase,
        },
      ]);
    }
  }

  for (const testCase of parsed.finalTestCases) {
    const expected = expectedById.get(testCase.id)!;
    if (testCase.conditionId !== expected.conditionId || testCase.requirementId !== expected.requirementId) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['finalTestCases'],
          message: `Final reviewed case ${testCase.id} changed conditionId or requirementId`,
          input: testCase,
        },
      ]);
    }
    for (const [field, allowedIds] of [
      ['coveredConditions', allowedCoveredConditionIds],
      ['referencedComponentConditions', allowedReferencedConditionIds],
    ] as const) {
      const missingTraceabilityIds = (expected[field] ?? [])
        .filter((id) => !testCase[field].includes(id));
      if (missingTraceabilityIds.length > 0) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['finalTestCases'],
            message: `Final reviewed case ${testCase.id} dropped ${field} IDs: ${missingTraceabilityIds.join(', ')}`,
            input: testCase,
          },
        ]);
      }
      const foreignTraceabilityIds = testCase[field].filter((id) => !allowedIds.has(id));
      if (foreignTraceabilityIds.length > 0) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['finalTestCases'],
            message: `Final reviewed case ${testCase.id} added FOREIGN ${field} IDs: ${foreignTraceabilityIds.join(', ')}`,
            input: testCase,
          },
        ]);
      }
    }
    if (expected.expectedTestLevel && testCase.testLevel !== expected.expectedTestLevel) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['finalTestCases'],
          message: `Final reviewed case ${testCase.id} has testLevel="${testCase.testLevel}" but the Designer assigned testLevel="${expected.expectedTestLevel}". Quality MUST NOT change testLevel — restore it to "${expected.expectedTestLevel}".`,
          input: testCase,
        },
      ]);
    }
    // F15: integration cases must still declare referencedComponentConditions.
    if (testCase.testLevel === 'integration' && testCase.referencedComponentConditions.length === 0) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['finalTestCases'],
          message: `Final reviewed case ${testCase.id} is testLevel="integration" but referencedComponentConditions is empty. Integration cases must explicitly name the component conditions they assume as preconditions.`,
          input: testCase,
        },
      ]);
    }
  }

  const missingIds = expectedDraftCases
    .map((draftCase) => draftCase.id)
    .filter((draftCaseId) => !seenCaseIds.has(draftCaseId));
  if (missingIds.length > 0) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['finalTestCases'],
        message: `Missing final reviewed cases for draft case ids: ${missingIds.join(', ')}`,
        input: parsed,
      },
    ]);
  }

  return parsed;
}

/**
 * F16: anti-redundancy hard check at the Quality layer. For every pair
 * (componentCase, integrationCase) sharing the same requirementId, scan the
 * integration case's `steps[].expected` for verbatim / near-verbatim overlaps
 * with the component case's `steps[].expected`. If substantial overlap is
 * found, the integration case has re-asserted what a sibling component case
 * already covers — a redundancy defect.
 *
 * Heuristic: tokenize each expected into lowercase word-tokens, drop short
 * stopwords, and compute Jaccard overlap. > 0.55 overlap = redundancy signal.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface RedundancyFlag {
  integrationCaseId: string;
  componentCaseId: string;
  componentExpected: string;
  integrationExpected: string;
  overlap: number;
}

function detectRedundancy(
  finalTestCases: QualityRuntimeOutput['finalTestCases'],
): RedundancyFlag[] {
  const componentCases = finalTestCases.filter((tc) => tc.testLevel === 'component');
  const integrationCases = finalTestCases.filter((tc) => tc.testLevel === 'integration');
  const flags: RedundancyFlag[] = [];
  for (const ic of integrationCases) {
    const icExpecteds = ic.steps.map((s) => s.expected);
    const icTokens = icExpecteds.map(tokenize);
    for (const cc of componentCases) {
      if (cc.requirementId !== ic.requirementId) continue;
      for (let i = 0; i < cc.steps.length; i++) {
        const ccTokens = tokenize(cc.steps[i].expected);
        for (let j = 0; j < icExpecteds.length; j++) {
          const overlap = jaccard(ccTokens, icTokens[j]);
          if (overlap > 0.55) {
            flags.push({
              integrationCaseId: ic.id,
              componentCaseId: cc.id,
              componentExpected: cc.steps[i].expected,
              integrationExpected: icExpecteds[j],
              overlap,
            });
          }
        }
      }
    }
  }
  return flags;
}

function validateAntiRedundancy(
  parsed: QualityRuntimeOutput,
): QualityRuntimeOutput {
  // Only run the check when the LLM did NOT log a `Redundancy` fix in changeLog.
  // If the LLM has already addressed redundancy for a case, we trust it.
  const changedCaseIds = new Set<string>();
  for (const tc of parsed.finalTestCases) {
    for (const change of tc.changeLog) {
      const reason = String(change.reason ?? '').toLowerCase();
      if (reason.includes('redundan') || reason.includes('overlap') || reason.includes('non-overlap')) {
        changedCaseIds.add(tc.id);
      }
    }
  }
  const flags = detectRedundancy(parsed.finalTestCases).filter(
    (f) => !changedCaseIds.has(f.integrationCaseId),
  );
  if (flags.length > 0) {
    // Auto-fix: instead of blocking the entire batch with a hard validation
    // error (which the LLM often fails to self-correct across all 3 Phase 2
    // retries), auto-add changeLog entries for the unresolved redundancy.
    // The changeLog entry makes the redundancy visible to the reviewer, who
    // can decide whether to fix it (move to preconditions) or accept it.
    // This is consistent with the D2 cross-batch redundancy pattern: flag,
    // don't delete, let the reviewer decide.
    const log = Log.for('quality:auto-redundancy');
    const byId = new Map(parsed.finalTestCases.map(c => [c.id, c]));
    for (const flag of flags) {
      const tc = byId.get(flag.integrationCaseId);
      if (tc) {
        tc.changeLog.push({
          field: 'steps',
          reason: `redundancy: auto-detected overlap with ${flag.componentCaseId} (overlap=${flag.overlap.toFixed(2)}) — integration step "${flag.integrationExpected}" duplicates component step "${flag.componentExpected}". Reviewer should move to preconditions if needed.`,
        });
        if (tc.status === 'approved') {
          tc.status = 'approved_with_changes';
        }
      }
    }
    const summary = flags
      .slice(0, 5)
      .map((f) => `${f.integrationCaseId} ↔ ${f.componentCaseId} (overlap=${f.overlap.toFixed(2)})`)
      .join('; ');
    log.warn(`Auto-flagged ${flags.length} redundancy issue(s): ${summary}`);
  }
  return parsed;
}

/**
 * Coerce a changeLog from/to value to string. The LLM frequently returns
 * arrays (e.g. when the changed field is coveredConditions), which causes
 * schema validation to fail because from/to are typed as string.
 */
function coerceChangeLogValue(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function normalizeFinalTestCase(
  value: unknown,
): Record<string, unknown> {
  const tc = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const steps = Array.isArray(tc.steps)
    ? tc.steps.map((step) => {
        const normalizedStep = step && typeof step === 'object' ? step as Record<string, unknown> : {};
        return {
          ...normalizedStep,
          stepNumber: coerceNumber(normalizedStep.stepNumber),
        };
      })
    : tc.steps;

  const changeLog = nullToEmptyArray(tc.changeLog as Record<string, unknown>[] | null | undefined)
    .map((change) => {
      const normalizedChange = change && typeof change === 'object' ? change as Record<string, unknown> : {};
      return {
        ...normalizedChange,
        from: coerceChangeLogValue(normalizedChange.from),
        to: coerceChangeLogValue(normalizedChange.to),
      };
    });

  return {
    ...tc,
    coveredConditions: nullToEmptyArray(tc.coveredConditions as string[] | null | undefined),
    referencedComponentConditions: nullToEmptyArray(tc.referencedComponentConditions as string[] | null | undefined),
    steps,
    tags: nullToEmptyArray(tc.tags as string[] | null | undefined),
    changeLog,
  };
}

/**
 * Normalize the coverageMatrix produced by the Quality Manager.
 * F27: only nullable optional fields are normalized; required values pass
 * through unchanged so the runtime schema can reject omissions and bad types.
 */
function normalizeCoverageMatrix(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw };

  if (Array.isArray(raw.rows)) {
    normalized.rows = raw.rows.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

      const row = { ...value as Record<string, unknown> };
      if (row.conditionType === null) row.conditionType = nullToUndefined(row.conditionType);
      if (row.notes === null) row.notes = nullToUndefined(row.notes);
      if (row.flowStepRef === null) {
        row.flowStepRef = nullToUndefined(row.flowStepRef);
      } else if (row.flowStepRef && typeof row.flowStepRef === 'object' && !Array.isArray(row.flowStepRef)) {
        const flowStepRef = { ...row.flowStepRef as Record<string, unknown> };
        if (flowStepRef.actionSummary === null) {
          flowStepRef.actionSummary = nullToUndefined(flowStepRef.actionSummary);
        }
        row.flowStepRef = flowStepRef;
      }
      return row;
    });
  }

  if (raw.summary && typeof raw.summary === 'object' && !Array.isArray(raw.summary)) {
    const summary = { ...raw.summary as Record<string, unknown> };
    if (summary.byConditionType === null) {
      summary.byConditionType = nullToUndefined(summary.byConditionType);
    }
    normalized.summary = summary;
  }

  return normalized;
}

export function createQualityOutputProfile(expectedDraftCases: ExpectedDraftCase[] = []): StructuredOutputProfile<QualityRuntimeOutput> {
  return {
    toolSchema: makeSchemaOpenAICompatible(zodToJsonSchema(QualityRuntimeSchema)),
    shouldAttemptPhase1Extraction(raw: unknown): boolean {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const obj = raw as Record<string, unknown>;
      if ('finalTestCases' in obj) return true;
      // Accept array-like objects: { "0": {...}, "1": {...}, ... }
      const keys = Object.keys(obj);
      return keys.length > 0 && keys.every(k => /^\d+$/.test(k));
    },
    normalize(raw: unknown): unknown {
      let input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      // Handle array-like objects: { "0": {...}, "1": {...}, ... }
      if (!('finalTestCases' in input) && !('coverageMatrix' in input)) {
        const keys = Object.keys(input);
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
          input = { finalTestCases: arrayFromRecordValues<unknown>(input) };
        }
      }
      const normalized: Record<string, unknown> = {
        finalTestCases: arrayFromRecordValues<unknown>(input.finalTestCases).map(normalizeFinalTestCase),
      };
      // Preserve coverageMatrix if the LLM produced one
      if (input.coverageMatrix && typeof input.coverageMatrix === 'object') {
        normalized.coverageMatrix = normalizeCoverageMatrix(input.coverageMatrix as Record<string, unknown>);
      }
      return normalized;
    },
    parse(normalized: unknown): QualityRuntimeOutput {
      const parsed = validateDraftCaseCoverage(QualityRuntimeSchema.parse(normalized), expectedDraftCases);
      return validateAntiRedundancy(parsed);
    },
    formatValidationError(error: unknown): string {
      return formatZodValidationError(error, {
        finalTestCases: 'Provide finalTestCases as a non-empty array of reviewed test cases, and preserve every input draft case id exactly once.',
        'finalTestCases.testLevel': 'Each final test case must declare testLevel as either "component" or "integration" (preserve from draft).',
        'finalTestCases.coveredConditions': 'Each final test case must list the Analyst conditionIds it covers.',
        'finalTestCases.referencedComponentConditions': 'Integration (testLevel="integration") cases MUST list at least one component condition they assume as a precondition.',
        'finalTestCases.tags': 'Use an array, not null, for tags.',
        'finalTestCases.changeLog': 'Use an array, not null, for changeLog.',
        coverageMatrix: 'coverageMatrix is REQUIRED: one row per Analyst condition, plus a summary object. F27.',
        'coverageMatrix.rows': 'Each row must reference a real Analyst conditionId and list coveredByCaseIds from finalTestCases.',
        'coverageMatrix.summary': 'Provide totalConditions, coveredConditions, missingConditions, byTestLevel, byTechnique, byCategory. byConditionType is optional but recommended.',
      });
    },
    extractionHints: [
      'Step atomicity (HARD constraint — schema validation will reject violations):',
      '- Each step must have exactly ONE action and ONE observable expected result.',
      '- `expected` must be ≤ 200 chars and contain NO semicolons separating multiple assertions.',
      '  WRONG: "button is disabled; error message appears" (two assertions)',
      '  RIGHT: split into two steps — step A expected "button is disabled", step B expected "error message appears".',
      '- `action` must be a single operation (no "and"/"then"/"with X/Y" bundling).',
    ].join('\n'),
  };
}

export const qualityOutputProfile: StructuredOutputProfile<QualityRuntimeOutput> = createQualityOutputProfile();

// ============================================================
// D1: Hybrid Coverage Matrix Reconciliation
// TS computes deterministic mapping fields (coveredByCaseIds,
// coverageStatus, summary), LLM provides assessment fields
// (notes, conditionSummary). This eliminates LLM mapping errors
// while preserving semantic evaluation.
// ============================================================

interface ReconcileCondition {
  id: string;
  requirementId: string;
  conditionType?: 'component' | 'flow';
  primaryTechnique?: string;
  category?: string;
  condition: string;
  flowStepRefs?: Array<{ flowId: string; sequence: number; actionSummary?: string }>;
}

export function reconcileCoverageMatrix(
  llmMatrix: QualityRuntimeOutput['coverageMatrix'],
  finalTestCases: QualityRuntimeOutput['finalTestCases'],
  conditions: ReconcileCondition[],
): QualityRuntimeOutput['coverageMatrix'] {
  if (!llmMatrix || !conditions.length) return llmMatrix;

  // Build conditionId → testCaseIds mapping from finalTestCases
  const caseIdsByCondition = new Map<string, string[]>();
  for (const tc of finalTestCases) {
    const allCondIds = new Set<string>();
    if (tc.conditionId) allCondIds.add(tc.conditionId);
    for (const cid of tc.coveredConditions ?? []) allCondIds.add(cid);
    for (const cid of allCondIds) {
      if (!caseIdsByCondition.has(cid)) caseIdsByCondition.set(cid, []);
      caseIdsByCondition.get(cid)!.push(tc.id);
    }
  }

  // Build LLM row lookup (for notes, conditionSummary, flowStepRef)
  const llmRowByCond = new Map<string, any>();
  for (const row of llmMatrix.rows ?? []) {
    llmRowByCond.set(row.conditionId, row);
  }

  // Reconcile each row
  const rows = conditions.map(cond => {
    const llmRow = llmRowByCond.get(cond.id);
    const coveredBy = caseIdsByCondition.get(cond.id) ?? [];
    const conditionType = cond.conditionType ?? (llmRow?.conditionType as 'component' | 'flow' | undefined);
    return {
      conditionId: cond.id,
      conditionSummary: llmRow?.conditionSummary ?? cond.condition.slice(0, 120),
      requirementId: cond.requirementId,
      testLevel: conditionType === 'flow' ? 'integration' : (llmRow?.testLevel ?? 'component'),
      primaryTechnique: cond.primaryTechnique ?? llmRow?.primaryTechnique ?? '',
      category: cond.category ?? llmRow?.category ?? '',
      conditionType,
      flowStepRef: llmRow?.flowStepRef ?? (cond.flowStepRefs?.[0]
        ? { flowId: cond.flowStepRefs[0].flowId, sequence: cond.flowStepRefs[0].sequence, actionSummary: cond.flowStepRefs[0].actionSummary }
        : undefined),
      coveredByCaseIds: coveredBy,
      coverageStatus: (coveredBy.length > 0 ? 'covered' : 'missing') as 'covered' | 'missing',
      notes: llmRow?.notes ?? '',
    };
  });

  // Recompute summary
  const byTestLevel: Record<string, number> = {};
  const byTechnique: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byConditionType: Record<string, number> = {};
  let covered = 0;
  for (const row of rows) {
    byTestLevel[row.testLevel] = (byTestLevel[row.testLevel] ?? 0) + 1;
    if (row.primaryTechnique) byTechnique[row.primaryTechnique] = (byTechnique[row.primaryTechnique] ?? 0) + 1;
    if (row.category) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    if (row.conditionType) byConditionType[row.conditionType] = (byConditionType[row.conditionType] ?? 0) + 1;
    if (row.coverageStatus === 'covered') covered++;
  }

  return {
    rows,
    summary: {
      totalConditions: rows.length,
      coveredConditions: covered,
      missingConditions: rows.length - covered,
      byTestLevel,
      byTechnique,
      byCategory,
      byConditionType,
    },
  } as any;
}
