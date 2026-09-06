import { z } from 'zod';
import { makeSchemaOpenAICompatible, zodToJsonSchema } from '../nodes/utils.ts';
import {
  formatZodValidationError,
  nullToEmptyArray,
  nullToUndefined,
} from './helpers.ts';
import { testConditionContractSchema } from 'shared/recording/agent-contracts.ts';
import type { StructuredOutputProfile } from './profile.ts';
import { Log } from '../../../../shared/services/logger.ts';

const AnalystRuntimeSchema = z.object({
  requirementAnalysis: z.object({
    overallApproach: z.string(),
    riskAssessmentSummary: z.string(),
  }),
  // SSOT：TestCondition 字段结构取自 shared/recording/agent-contracts.ts。
  // 业务门（conditionType/flowStepRefs/requirementId/dependencies 交叉校验）在 parse 阶段叠加。
  testConditions: z.array(testConditionContractSchema),
});

type AnalystRuntimeOutput = z.infer<typeof AnalystRuntimeSchema>;

function validateRequirementIds(
  parsed: AnalystRuntimeOutput,
  allowedReqIds: Set<string>,
  acParentMap: Map<string, string>,
): AnalystRuntimeOutput {
  if (allowedReqIds.size === 0) return parsed;

  const log = Log.for('analyst:auto-fix');
  for (const condition of parsed.testConditions) {
    if (allowedReqIds.has(condition.requirementId)) continue;
    // Auto-fix: the LLM frequently uses AC-level IDs (e.g.
    // "req-aut-auth-login-ui-password-toggle") as requirementId, but only
    // story-level IDs are in the batch. Remap to the parent story.
    const parentId = acParentMap.get(condition.requirementId);
    if (parentId && allowedReqIds.has(parentId)) {
      log.warn(`Auto-fixed ${condition.id}: remapped requirementId "${condition.requirementId}" → "${parentId}" (AC→parent story)`);
      condition.requirementId = parentId;
    } else {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} references requirement "${condition.requirementId}" which is not in the current batch. Conditions must only reference requirements from this batch.`,
          input: condition,
        },
      ]);
    }
  }

  return parsed;
}

/**
 * F2: enforce that every condition declares exactly one conditionType and that
 * flow conditions are anchored to at least one flow step (F3).
 * Also enforces F23: primaryTechnique "Use Case Testing" implies conditionType "flow".
 */
function validateConditionTypes(
  parsed: AnalystRuntimeOutput,
): AnalystRuntimeOutput {
  for (const condition of parsed.testConditions) {
    if (!condition.conditionType || (condition.conditionType !== 'component' && condition.conditionType !== 'flow')) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} is missing conditionType. Set it to "component" (atomic behavior from a requirement AC) or "flow" (cross-component interaction from a flow step).`,
          input: condition,
        },
      ]);
    }
    if (condition.conditionType === 'flow') {
      const refs = condition.flowStepRefs ?? [];
      if (refs.length === 0) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['testConditions'],
            message: `Condition ${condition.id} is type "flow" but has no flowStepRefs. A flow condition must reference at least one { flowId, sequence, actionSummary } so the Designer can trace the flow step it derives from.`,
            input: condition,
          },
        ]);
      }
    }
    // F23: Use Case Testing is a multi-step, cross-component technique — must be "flow".
    const primary = (condition.primaryTechnique ?? '').toLowerCase();
    if (primary.includes('use case') && condition.conditionType !== 'flow') {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} uses Use Case Testing but conditionType is "${condition.conditionType}". Use Case Testing is inherently multi-step and cross-component. FIX with ONE of: (A) set conditionType to "flow" AND add flowStepRefs with at least one { flowId, sequence, actionSummary } entry — use this if the condition verifies a cross-component user journey; OR (B) change primaryTechnique from "Use Case Testing" to a component-appropriate technique — Equivalence Partitioning, Boundary Value Analysis, Decision Table, or State Transition — use this if the condition verifies a single-component behavior.`,
          input: condition,
        },
      ]);
    }
  }
  return parsed;
}

/**
 * F8: enforce that every flow step in the relevant flow blueprints has at least
 * one flow condition referencing it. The LLM frequently skips exception/error
 * flow steps (e.g. "invalid credentials" or "empty fields") because it considers
 * them already covered by component conditions. Instead of throwing a hard error
 * (which triggers Phase 2 retries the LLM consistently fails to self-correct),
 * auto-generate stub flow conditions for uncovered steps.
 *
 * F8-flowId: before checking coverage, remap hallucinated flowIds to real
 * blueprint IDs. The LLM frequently invents flow IDs (e.g. "FLOW-AUTH-SESSION")
 * that don't match the actual blueprint IDs (which are AC IDs like
 * "req-aut-auth-session-happy"). Without remapping, ALL steps appear uncovered
 * and the auto-generation produces DUPLICATE stub conditions alongside the
 * LLM's own (semantically equivalent) flow conditions. The remap matches by
 * actionSummary text, which is reliable because the LLM copies the summary
 * from the blueprint even when it hallucinates the flowId.
 */
function validateFlowStepCoverage(
  parsed: AnalystRuntimeOutput,
  flowBlueprints: { id: string; steps: { sequence: number; actionSummary?: string }[] }[],
): AnalystRuntimeOutput {
  if (flowBlueprints.length === 0) return parsed;

  const validFlowIds = new Set(flowBlueprints.map(bp => bp.id));
  // Build actionSummary → { flowId, sequence } lookup for remapping hallucinated flowIds.
  const summaryToBlueprintStep = new Map<string, { flowId: string; sequence: number }>();
  for (const bp of flowBlueprints) {
    for (const step of bp.steps) {
      const summary = (step.actionSummary ?? '').toLowerCase().trim();
      if (summary) summaryToBlueprintStep.set(summary, { flowId: bp.id, sequence: step.sequence });
    }
  }

  // Remap hallucinated flowIds to real blueprint IDs by matching actionSummary.
  const log = Log.for('analyst:auto-fix');
  for (const cond of parsed.testConditions) {
    if (cond.conditionType !== 'flow') continue;
    for (const ref of cond.flowStepRefs ?? []) {
      if (validFlowIds.has(ref.flowId)) continue;
      // flowId doesn't match any blueprint — try to find the real step by actionSummary.
      const summary = (ref.actionSummary ?? '').toLowerCase().trim();
      const match = summary ? summaryToBlueprintStep.get(summary) : undefined;
      if (match) {
        log.warn(`Auto-fixed ${cond.id}: remapped flowStepRefs flowId "${ref.flowId}" → "${match.flowId}" (matched by actionSummary)`);
        ref.flowId = match.flowId;
        ref.sequence = match.sequence;
      }
    }
  }

  const coveredSteps = new Set<string>();
  for (const cond of parsed.testConditions) {
    if (cond.conditionType !== 'flow') continue;
    for (const ref of cond.flowStepRefs ?? []) {
      coveredSteps.add(`${ref.flowId}:${ref.sequence}`);
    }
  }

  const uncoveredSteps: { flowId: string; sequence: number; actionSummary: string; flowName?: string }[] = [];
  for (const flow of flowBlueprints) {
    for (const step of flow.steps) {
      const key = `${flow.id}:${step.sequence}`;
      if (!coveredSteps.has(key)) {
        uncoveredSteps.push({
          flowId: flow.id,
          sequence: step.sequence,
          actionSummary: step.actionSummary ?? '',
          flowName: (flow as any).name,
        });
      }
    }
  }

  if (uncoveredSteps.length > 0) {
    const log = Log.for('analyst:auto-fix');
    // Find the highest existing condition ID number to avoid collisions.
    const maxIdNum = parsed.testConditions.reduce((max, c) => {
      const m = c.id.match(/^C-(\d+)$/);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);

    for (let i = 0; i < uncoveredSteps.length; i++) {
      const step = uncoveredSteps[i];
      const newId = `C-${String(maxIdNum + i + 1).padStart(3, '0')}`;
      const autoCondition = {
        id: newId,
        requirementId: step.flowId, // flow ID as the requirement anchor
        condition: `Verify flow behavior: ${step.actionSummary}`,
        conditionType: 'flow' as const,
        flowStepRefs: [{
          flowId: step.flowId,
          sequence: step.sequence,
          actionSummary: step.actionSummary,
          ...(step.flowName ? { flowName: step.flowName } : {}),
        }],
        category: 'functional',
        priority: 'medium',
        riskLevel: 'medium',
        primaryTechnique: 'Use Case Testing',
        secondaryTechniques: [] as string[],
        techniqueRationale: 'Auto-generated to ensure every flow step has at least one covering flow condition (F8 rule).',
        coverageDimensions: ['flow-coverage'],
        dependencies: [] as string[],
      };
      parsed.testConditions.push(autoCondition);
      log.warn(`Auto-generated flow condition ${newId} for uncovered step ${step.flowId}:${step.sequence} (${step.actionSummary})`);
    }
  }

  return parsed;
}

/**
 * Validate that every `dependencies` entry references a REAL condition ID.
 * The LLM frequently fabricates compound IDs (e.g.
 * "component:req-aut-auth-session-happy:F-001") instead of using the plain
 * condition ID ("C-001"). Fake IDs propagate to the Designer's
 * `referencedComponentConditions` and break downstream related-requirement
 * lookup. This hard-checks at the Analyst output level — the source.
 *
 * Valid IDs are:
 *   - same-output condition IDs (mixed mode: component conditions in the same batch)
 *   - external condition IDs passed in (flow mode: component conditions from previous batches)
 *
 * Hard-reject (no auto-fix) because there is no reliable remapping for an
 * arbitrary fabricated ID. The extractionHints list the valid IDs so the LLM
 * can self-correct in Phase 2.
 */
function validateDependencies(
  parsed: AnalystRuntimeOutput,
  externalConditionIds: Set<string>,
): AnalystRuntimeOutput {
  // Build the set of all valid condition IDs the LLM may reference.
  const sameOutputIds = new Set(parsed.testConditions.map((c) => c.id));
  const validIds = new Set<string>([...sameOutputIds, ...externalConditionIds]);

  if (validIds.size === 0) return parsed;

  for (const cond of parsed.testConditions) {
    for (const depId of cond.dependencies ?? []) {
      if (validIds.has(depId)) continue;
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${cond.id} has dependency "${depId}" which is NOT a real condition ID. Dependencies must reference actual condition IDs — either from the same batch's output (e.g. "C-001") or from previous batches (obtained via previous_batch_conditions_query). Fabricated compound IDs like "component:req-xxx:F-001" are NOT valid. Remove the fake ID or replace it with a real one.`,
          input: cond,
        },
      ]);
    }
  }
  return parsed;
}

export function createAnalystOutputProfile(
  allowedReqIds: Set<string> = new Set(),
  flowBlueprints: { id: string; steps: { sequence: number; actionSummary?: string }[] }[] = [],
  acParentMap: Map<string, string> = new Map(),
  externalConditionIds: Set<string> = new Set(),
): StructuredOutputProfile<AnalystRuntimeOutput> {
  return {
    toolSchema: makeSchemaOpenAICompatible(zodToJsonSchema(AnalystRuntimeSchema)),
    shouldAttemptPhase1Extraction(raw: unknown): boolean {
      return !!raw && typeof raw === 'object' && !Array.isArray(raw)
        && ('requirementAnalysis' in (raw as Record<string, unknown>) || 'testConditions' in (raw as Record<string, unknown>));
    },
    normalize(raw: unknown): unknown {
      const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const testConditions = Array.isArray(input.testConditions)
        ? input.testConditions.map((condition) => {
            const normalizedCondition = condition && typeof condition === 'object'
              ? condition as Record<string, unknown>
              : {};

            const conditionType = typeof normalizedCondition.conditionType === 'string'
              ? normalizedCondition.conditionType.toLowerCase()
              : normalizedCondition.conditionType;

            const flowStepRefs = Array.isArray(normalizedCondition.flowStepRefs)
              ? normalizedCondition.flowStepRefs.map((ref: any) => {
                  // Strip null/undefined flowName — LLMs frequently emit
                  // `flowName: null` which fails the optional string schema.
                  if (ref && typeof ref === 'object' && (ref.flowName === null || ref.flowName === undefined)) {
                    const { flowName, ...rest } = ref;
                    return rest;
                  }
                  return ref;
                })
              : nullToUndefined(normalizedCondition.flowStepRefs as unknown[] | null | undefined);

return {
              ...normalizedCondition,
              conditionType,
              flowStepRefs,
              dataRequirements: nullToUndefined(normalizedCondition.dataRequirements as string[] | null | undefined),
              dependencies: nullToEmptyArray(normalizedCondition.dependencies as string[] | null | undefined),
              requirementLevel: nullToUndefined(normalizedCondition.requirementLevel as string | null | undefined),
              recommendedCaseCount: nullToUndefined(normalizedCondition.recommendedCaseCount as number | null | undefined),
            };
          })
        : input.testConditions;

      return {
        requirementAnalysis: input.requirementAnalysis,
        testConditions,
      };
    },
    parse(normalized: unknown): AnalystRuntimeOutput {
      const parsed = AnalystRuntimeSchema.parse(normalized);
      const withConditionTypes = validateConditionTypes(parsed);
      const withReqIds = validateRequirementIds(withConditionTypes, allowedReqIds, acParentMap);
      const withFlowCoverage = validateFlowStepCoverage(withReqIds, flowBlueprints);
      return validateDependencies(withFlowCoverage, externalConditionIds);
    },
    formatValidationError(error: unknown): string {
      return formatZodValidationError(error, {
        testConditions: 'Provide testConditions as an array with complete condition details.',
        'testConditions.category': 'Set category explicitly, for example functional, ui, api, boundary, edge, error, validation, or performance.',
        'testConditions.requirementId': 'Each condition must carry the source requirementId from the analyzed requirement.',
        'testConditions.conditionType': 'Set conditionType to "component" (atomic behavior from a requirement AC) or "flow" (cross-component interaction from a flow step).',
        'testConditions.flowStepRefs': 'Flow conditions MUST include at least one { flowId, sequence, actionSummary } entry.',
        'testConditions.coverageDimensions': 'coverageDimensions is a free-form tag array; do NOT use "testLevel:*" tags anymore (use conditionType).',
        'testConditions.dependencies': 'dependencies must be an array of REAL condition IDs (e.g. "C-001"). Do NOT fabricate compound IDs like "component:req-xxx:F-001" — use the exact condition ID from the same batch or from previous_batch_conditions_query.',
        'testConditions.dataRequirements': 'Omit dataRequirements or provide an array of strings.',
      });
    },
    extractionHints: [
      ...(flowBlueprints.length > 0
        ? [
          'Flow condition flowStepRefs (HARD constraint — using a wrong flowId causes duplicate auto-generated conditions):',
          '- `flowStepRefs[].flowId` MUST be one of these EXACT values from the input `flowBlueprints`:',
          ...flowBlueprints.map(bp => `  "${bp.id}" (step ${bp.steps.map(s => s.sequence).join(', ')}: ${bp.steps.map(s => s.actionSummary ?? '').join(' | ')})`),
          '- Do NOT invent flow IDs like "FLOW-AUTH-SESSION" — use the exact `id` from `flowBlueprints`.',
        ]
        : []),
      ...(externalConditionIds.size > 0
        ? [
          '',
          'Dependencies (HARD constraint — fake IDs break downstream requirement lookup):',
          '- `dependencies` MUST reference real condition IDs. Use EXACTLY one of these IDs from previous batches:',
          ...[...externalConditionIds].map(id => `  "${id}"`),
          '- Do NOT fabricate compound IDs like "component:req-xxx:F-001". Use the plain condition ID only.',
        ]
        : []),
    ].join('\n') || undefined,
  };
}
