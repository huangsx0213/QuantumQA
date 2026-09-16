/**
 * emit_review / emit_coverage_row 工具 —— Quality Manager 的 Tool Use 强制结构化输出。
 *
 * 定位：Quality 不再全量重写所有 finalTestCases（大 JSON），而是按"评审结论 + 差异"分片声明：
 * - `emit_review`：对一个 draft case 声明评审结论（status/reviewSummary/changeLog），
 *   仅在真正改动时才携带 steps/testData 的完整替换（省略 = 原样透传 draft）。
 * - `emit_coverage_row`：对一个 condition 声明评估字段（conditionSummary/notes）。
 *   coveredByCaseIds、coverageStatus、testLevel、primaryTechnique、category、summary
 *   全部由 reconcileCoverageMatrix 确定性重算——LLM 不再输出这些易错字段。
 *
 * 幂等覆盖：同一 caseId/conditionId 多次 emit，后写覆盖前写（last-write-wins）。
 * 工具本身只返回 ack；真正拼装由 quality 的 emit-extract merge draft cases 完成。
 */
import { z } from 'zod';
import { nlStepIntentSchema } from 'shared/recording/nl-intent.ts';
import type { SkillDefinition } from '../nodes/types.ts';

const changeLogEntrySchema = z.object({
  field: z.string().min(1).max(100).describe('The field changed (e.g. "testData", "steps", "preconditions").'),
  from: z.string().max(1000).optional(),
  to: z.string().max(1000).optional(),
  reason: z.string().min(1).max(2000).describe('Why the field was changed (e.g. "BVA requires the exact boundary value.").'),
});

const finalStepSchema = z.object({
  stepNumber: z.number().int().min(1),
  action: z.string().min(1),
  expected: z.string(),
  intent: nlStepIntentSchema.optional(),
});

const emitReviewArgsSchema = z.object({
  caseId: z.string().min(1).max(200).describe('The draft case id being reviewed (e.g. "TC-001"). Repeating it overwrites the previous review.'),
  status: z.enum(['approved', 'approved_with_changes', 'rejected']).describe('The review verdict for this case.'),
  reviewSummary: z.string().min(1).max(3000).describe('One- or two-sentence summary of the review outcome and any changes made.'),
  changeLog: z.array(changeLogEntrySchema).default([]).describe('Field-level changes; empty array when the case is untouched or just approved.'),
  steps: z.array(finalStepSchema).min(1).max(200).optional().describe('FULL replacement steps array for this case. Omit to keep the draft steps unchanged (the common case).'),
  testData: z.array(z.string()).optional().describe('FULL replacement testData. Omit to keep the draft testData unchanged.'),
});

const emitCoverageRowArgsSchema = z.object({
  conditionId: z.string().min(1).max(200).describe('The Analyst conditionId this row covers.'),
  conditionSummary: z.string().max(500).optional().describe('A concise human summary of what the condition verifies.'),
  notes: z.string().max(1000).optional().describe('Optional reviewer notes (e.g. "Boundary value corrected during review.").'),
});

function buildEmitReviewAck(caseId: string, status: string) {
  return {
    ok: true,
    caseId,
    status,
    message: `Review recorded for ${caseId}: ${status}. Review the next case, or finish after all cases are reviewed.`,
  };
}

function buildEmitCoverageRowAck(conditionId: string) {
  return {
    ok: true,
    conditionId,
    message: `Coverage assessment recorded for ${conditionId}.`,
  };
}

export const emitReviewSkill: SkillDefinition = {
  name: 'emit_review',
  description: 'Emit your review verdict for ONE draft test case: status ("approved" | "approved_with_changes" | "rejected"), a reviewSummary, and a changeLog (field-level diffs). Call ONCE per draft case — even when approving unchanged (status: "approved", empty changeLog). Only include steps/testData when you actually change them (full replacement).',
  schema: emitReviewArgsSchema,
  func: async (args) => buildEmitReviewAck(String(args.caseId), String(args.status)),
  summarizeForState: (input) => ({
    input,
    output: { caseId: (input as any)?.caseId, status: (input as any)?.status, ack: true },
  }),
};

export const emitCoverageRowSkill: SkillDefinition = {
  name: 'emit_coverage_row',
  description: 'Emit your semantic assessment (conditionSummary, optional notes) for ONE Analyst condition. Call ONCE per condition. The system deterministically computes coveredByCaseIds, coverageStatus, testLevel, primaryTechnique, category, and the summary — do NOT emit those. ',
  schema: emitCoverageRowArgsSchema,
  func: async (args) => buildEmitCoverageRowAck(String(args.conditionId)),
  summarizeForState: (input) => ({
    input,
    output: { conditionId: (input as any)?.conditionId, ack: true },
  }),
};

export type EmitReviewArgs = z.infer<typeof emitReviewArgsSchema>;
export type EmitCoverageRowArgs = z.infer<typeof emitCoverageRowArgsSchema>;