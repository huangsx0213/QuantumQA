/**
 * emit_condition / emit_analysis 工具 —— Test Analyst 的 Tool Use 强制结构化输出。
 *
 * 定位：Analyst 不再输出一次性大 JSON，而是分片声明每条 test condition：
 * - `emit_analysis`：once，挂 overallApproach + riskAssessmentSummary。
 * - `emit_condition`：一条 condition 的全部字段（含 conditionType enum、flowStepRefs）。
 *   幂等覆盖：同一 id 多次 emit，后写覆盖前写（last-write-wins）。
 *
 * 工具本身只返回 ack；真正拼装由 analyst 的 emit-extract 完成。
 */
import { z } from 'zod';
import type { SkillDefinition } from '../nodes/types.ts';

const flowStepRefSchema = z.object({
  flowId: z.string().min(1).max(200),
  flowName: z.string().max(200).optional(),
  sequence: z.number().int().nonnegative(),
  actionSummary: z.string().min(1).max(500),
});

const emitAnalysisArgsSchema = z.object({
  overallApproach: z.string().min(1).max(6000).describe('High-level strategy: techniques chosen, coverage scope, and why.'),
  riskAssessmentSummary: z.string().min(1).max(4000).describe('Summary of the risk-based prioritization and the highest-risk areas.'),
});

const emitConditionArgsSchema = z.object({
  id: z.string().min(1).max(200).describe('Condition id (e.g. "C-001"). Unique within the batch; repeating it overwrites the previous declaration.'),
  requirementId: z.string().min(1).max(200).describe('The exact source requirement ID from the batch.'),
  condition: z.string().min(1).max(3000).describe('The condition description, starting with "Verify that ...".'),
  conditionType: z.enum(['component', 'flow']).describe('component = atomic single-component behavior; flow = cross-component integration behavior.'),
  flowStepRefs: z.array(flowStepRefSchema).default([]).describe('Required (non-empty) for flow conditions; empty for component conditions.'),
  category: z.string().min(1).max(50).describe('functional | ui | api | boundary | edge | error | validation | performance | integration'),
  priority: z.string().min(1).max(50),
  riskLevel: z.string().min(1).max(50),
  primaryTechnique: z.string().min(1).max(200).describe('Equivalence Partitioning | Boundary Value Analysis | Decision Table | State Transition Testing | Use Case Testing'),
  secondaryTechniques: z.array(z.string()).default([]),
  techniqueRationale: z.string().min(1).max(3000),
  coverageDimensions: z.array(z.string()).default([]),
  dataRequirements: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]).describe('Real condition IDs only (same batch or from previous_batch_conditions_query). Never fabricate compound IDs.'),
  requirementLevel: z.string().max(50).optional(),
  recommendedCaseCount: z.number().int().positive().optional(),
});

function buildEmitAnalysisAck() {
  return { ok: true };
}

function buildEmitConditionAck(conditionId: string, conditionType: string) {
  return { ok: true, conditionId, conditionType };
}

export const emitAnalysisSkill: SkillDefinition = {
  name: 'emit_analysis',
  description: 'Emit the overall analysis summary (overallApproach + riskAssessmentSummary). Call ONCE, before emitting conditions.',
  schema: emitAnalysisArgsSchema,
  func: async () => buildEmitAnalysisAck(),
  summarizeForState: (input) => ({ input, output: { ack: true } }),
};

export const emitConditionSkill: SkillDefinition = {
  name: 'emit_condition',
  description: 'Emit ONE test condition with all its fields (id, requirementId, condition, conditionType, flowStepRefs, category, priority, riskLevel, primaryTechnique, secondaryTechniques, techniqueRationale, coverageDimensions, dataRequirements?, dependencies, requirementLevel?, recommendedCaseCount?). Call ONCE per condition. conditionType is a closed enum ("component" | "flow"); flow conditions require non-empty flowStepRefs.',
  schema: emitConditionArgsSchema,
  func: async (args) => buildEmitConditionAck(String(args.id), String(args.conditionType)),
  summarizeForState: (input) => ({
    input,
    output: { conditionId: (input as any)?.id, conditionType: (input as any)?.conditionType, ack: true },
  }),
};

export type EmitConditionArgs = z.infer<typeof emitConditionArgsSchema>;
export type EmitAnalysisArgs = z.infer<typeof emitAnalysisArgsSchema>;