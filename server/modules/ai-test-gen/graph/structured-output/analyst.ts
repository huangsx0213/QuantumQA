import { z } from 'zod';
import { makeSchemaOpenAICompatible, zodToJsonSchema } from '../nodes/utils.ts';
import { tryExtractJson } from '../nodes/json-extract.ts';
import type { ToolCallRecord } from '../nodes/types.ts';
import {
  formatZodValidationError,
  nullToEmptyArray,
  nullToUndefined,
} from './helpers.ts';
import { testConditionContractSchema } from 'shared/recording/agent-contracts.ts';
import type { StructuredOutputProfile } from './profile.ts';
import { throwRepairGap } from './repair-plan.ts';
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
      throwRepairGap(new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} references requirement "${condition.requirementId}" which is not in the current batch. Conditions must only reference requirements from this batch.`,
          input: condition,
        },
      ]), { type: 'identity-mismatch', entityId: condition.id, field: 'requirementId', badValue: condition.requirementId, fix: `set requirementId to a requirement id present in the current batch` });
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
      throwRepairGap(new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} is missing conditionType. Set it to "component" (atomic behavior from a requirement AC) or "flow" (cross-component interaction from a flow step).`,
          input: condition,
        },
      ]), { type: 'wrong-value', entityId: condition.id, field: 'conditionType', badValue: String(condition.conditionType ?? ''), fix: 'set conditionType to "component" or "flow"' });
    }
    if (condition.conditionType === 'flow') {
      const refs = condition.flowStepRefs ?? [];
      if (refs.length === 0) {
        throwRepairGap(new z.ZodError([
          {
            code: 'custom',
            path: ['testConditions'],
            message: `Condition ${condition.id} is type "flow" but has no flowStepRefs. A flow condition must reference at least one { flowId, sequence, actionSummary } so the Designer can trace the flow step it derives from.`,
            input: condition,
          },
        ]), { type: 'missing-entity', entityId: condition.id, field: 'flowStepRefs', fix: 'add at least one flowStepRefs entry with flowId + sequence + actionSummary' });
      }
    }
    // F23: Use Case Testing is a multi-step, cross-component technique — must be "flow".
    const primary = (condition.primaryTechnique ?? '').toLowerCase();
    if (primary.includes('use case') && condition.conditionType !== 'flow') {
      throwRepairGap(new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${condition.id} uses Use Case Testing but conditionType is "${condition.conditionType}". Use Case Testing is inherently multi-step and cross-component. FIX with ONE of: (A) set conditionType to "flow" AND add flowStepRefs with at least one { flowId, sequence, actionSummary } entry — use this if the condition verifies a cross-component user journey; OR (B) change primaryTechnique from "Use Case Testing" to a component-appropriate technique — Equivalence Partitioning, Boundary Value Analysis, Decision Table, or State Transition — use this if the condition verifies a single-component behavior.`,
          input: condition,
        },
      ]), { type: 'wrong-value', entityId: condition.id, field: 'primaryTechnique', badValue: condition.primaryTechnique, fix: 'this condition verifies a single-component behavior — change primaryTechnique to State Transition (checkbox/toggle/visibility state) or Equivalence Partitioning (presence); "Use Case Testing" can only pair with conditionType="flow"' });
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
      throwRepairGap(new z.ZodError([
        {
          code: 'custom',
          path: ['testConditions'],
          message: `Condition ${cond.id} has dependency "${depId}" which is NOT a real condition ID. Dependencies must reference actual condition IDs — either from the same batch's output (e.g. "C-001") or from previous batches (obtained via previous_batch_conditions_query). Fabricated compound IDs like "component:req-xxx:F-001" are NOT valid. Remove the fake ID or replace it with a real one.`,
          input: cond,
        },
      ]), { type: 'bad-reference', entityId: cond.id, field: 'dependencies', badValue: depId, fix: `remove or replace the fake dependency "${depId}" with a real condition id` });
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
    emitExtract: tryExtractFromAnalystEmitTools,
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

// ============================================================
// Mode A emit-extract — emit_analysis + emit_condition → raw
// ============================================================

/**
 * 从 ReAct 工具调用记录中收集 Analyst 的 emit_analysis / emit_condition 调用，
 * 拼装成 { requirementAnalysis, testConditions }（待 AnalystRuntimeSchema 校验的 raw）。
 *
 * - emit_condition：一条 condition（id 后写覆盖前写）。schema 已在工具层强制
 *   conditionType enum + flowStepRefs，但跨字段门（dependencies 真实 ID、flow 覆盖
 *   完整性）仍在 parse 阶段 validate* 校验。
 * - emit_analysis：once，取最后一次。
 *
 * 返回 null 表示未走 emit 路径，或 contentText 中已有更完整的 testConditions JSON
 * （LLM 弃用工具转 JSON）→ 调用方回退 JSON 提取。
 */
function tryExtractFromAnalystEmitTools(
  toolCallRecords: ToolCallRecord[],
  contentText: string,
  agentName: string,
): Record<string, unknown> | null {
  const conditions = toolCallRecords.filter((r) => r.name === 'emit_condition');
  const analyses = toolCallRecords.filter((r) => r.name === 'emit_analysis');
  if (conditions.length === 0 && analyses.length === 0) return null;

  const extractLog = Log.for(`llm:${agentName}:emit-extract`);

  // LLM 弃用工具转 JSON：contentText 里有更完整的 testConditions → defer。
  const jsonCount = countConditionsInText(contentText);
  if (jsonCount > conditions.length && jsonCount > 0) {
    extractLog.info(`emitted ${conditions.length} condition(s) but thinking text has ${jsonCount} — LLM switched to JSON; deferring`);
    return null;
  }

  extractLog.info(`emit_analysis=${analyses.length}, emit_condition=${conditions.length}`);

  // last-write-wins by id
  const condById = new Map<string, Record<string, unknown>>();
  for (const rec of conditions) {
    if (!rec.input || typeof rec.input !== 'object') continue;
    const id = String((rec.input as any).id ?? '').trim();
    if (id) condById.set(id, rec.input as Record<string, unknown>);
  }

  const lastAnalysis = analyses.length > 0 && analyses[analyses.length - 1].input && typeof analyses[analyses.length - 1].input === 'object'
    ? analyses[analyses.length - 1].input as Record<string, unknown>
    : null;

  const requirementAnalysis = {
    overallApproach: String(lastAnalysis?.overallApproach ?? ''),
    riskAssessmentSummary: String(lastAnalysis?.riskAssessmentSummary ?? ''),
  };

  // record.input 保存的是原始 args（schema 的 default([]) 未回填），对 shared
  // contract 的数组字段兜底，避免 parse 阶段 expected array got undefined。
  const testConditions = [...condById.values()].map((c) => ({
    ...c,
    flowStepRefs: Array.isArray(c.flowStepRefs) ? c.flowStepRefs : [],
    secondaryTechniques: Array.isArray(c.secondaryTechniques) ? c.secondaryTechniques : [],
    coverageDimensions: Array.isArray(c.coverageDimensions) ? c.coverageDimensions : [],
    dependencies: Array.isArray(c.dependencies) ? c.dependencies : [],
  }));

  return { requirementAnalysis, testConditions };
}

function countConditionsInText(contentText: string): number {
  if (!contentText || typeof contentText !== 'string') return 0;
  const parsed = tryExtractJson(contentText, { allowTruncatedRepair: true });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  const list = (parsed as any).testConditions;
  return Array.isArray(list) ? list.length : 0;
}
