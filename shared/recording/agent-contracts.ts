/**
 * Agent 交接口契约（Single Source of Truth for Agent hops）
 *
 * 与 shared/contracts 的"领域模型"（TestCondition/NlTestCase，落盘/执行格式）区分：
 * 本文件定义 AI Test Gen 管线内 **agent 之间流动** 的结构（Analyst→Designer→Quality），
 * 是"Analyst 输出 / Designer 输入"、"Designer 输出 / Quality 输入"的唯一同源契约。
 *
 * 设计（业界最佳 — SSOT + 双端 parse）：
 * - 每个 agent 的 runtime schema 从此文件的契约 schema 派生（.extend 本地业务门），
 *   字段名/类型/枚举同源 —— 改契约一处，三个 agent 由类型系统同步。
 * - 业务门（compound signals、validateStepContract、atomicExpected 等）留在各 agent
 *   runtime schema 本地，不污染契约。
 * - state 类型（graph/state.ts）用 z.infer 契约 —— 不再手写 TestCondition[] 领域类型
 *   硬塞 Analyst 输出（as any 漂移）。
 *
 * 一致性铁律（docs/08 精神）：契约 schema + z.infer 类型 + 三 agent runtime 派生，
 * 以契约测试锁死"Analyst 合法输出 → Designer/Quality 可消费"。
 */
import { z } from 'zod';
import { nlStepIntentSchema } from './nl-intent.ts';

// ============================================================
// 3. FinalTestCase（Quality 输出）
// ============================================================

const changeLogEntrySchema = z.object({
  field: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string(),
});

const finalStepContractSchema = z.object({
  stepNumber: z.number(),
  action: z.string(),
  expected: z.string(),
  intent: nlStepIntentSchema.optional(),
});

export const finalTestCaseContractSchema = z.object({
  id: z.string(),
  title: z.string(),
  conditionId: z.string(),
  requirementId: z.string(),
  coveredConditions: z.array(z.string()).default([]),
  referencedComponentConditions: z.array(z.string()).default([]),
  priority: z.string(),
  category: z.string(),
  testLevel: z.enum(['component', 'integration']),
  techniqueApplied: z.string(),
  preconditions: z.array(z.string()),
  testData: z.array(z.string()),
  steps: z.array(finalStepContractSchema).min(1),
  tags: z.array(z.string()).default([]),
  status: z.string().default('approved'),
  reviewSummary: z.string(),
  changeLog: z.array(changeLogEntrySchema).default([]),
});

export type FinalStepContract = z.infer<typeof finalStepContractSchema>;
export type FinalTestCaseContract = z.infer<typeof finalTestCaseContractSchema>;

// ============================================================
// 2. DraftTestCase（Designer 输出）
// ============================================================

export const draftStepContractSchema = z.object({
  stepNumber: z.number(),
  action: z.string(),
  expected: z.string(),
  intent: nlStepIntentSchema.optional(),
});

const selfReviewContractSchema = z.object({
  score: z.number().min(1).max(10),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export const draftTestCaseContractSchema = z.object({
  id: z.string(),
  title: z.string(),
  conditionId: z.string(),
  requirementId: z.string(),
  coveredConditions: z.array(z.string()).default([]),
  referencedComponentConditions: z.array(z.string()).default([]),
  priority: z.string(),
  category: z.string(),
  testLevel: z.enum(['component', 'integration']),
  techniqueApplied: z.string(),
  preconditions: z.array(z.string()),
  testData: z.array(z.string()),
  steps: z.array(draftStepContractSchema).min(1),
  postconditions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  selfReview: selfReviewContractSchema,
});

export type DraftStepContract = z.infer<typeof draftStepContractSchema>;
export type DraftTestCaseContract = z.infer<typeof draftTestCaseContractSchema>;

// ============================================================
// 1. TestCondition（Analyst 输出 = Designer 输入）
// ============================================================

export const flowStepRefContractSchema = z.object({
  flowId: z.string().min(1),
  flowName: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  actionSummary: z.string().min(1),
});

export const testConditionContractSchema = z.object({
  id: z.string(),
  requirementId: z.string(),
  condition: z.string(),
  conditionType: z.enum(['component', 'flow']),
  flowStepRefs: z.array(flowStepRefContractSchema).optional(),
  category: z.string(),
  priority: z.string(),
  riskLevel: z.string(),
  primaryTechnique: z.string(),
  secondaryTechniques: z.array(z.string()),
  techniqueRationale: z.string(),
  coverageDimensions: z.array(z.string()),
  dataRequirements: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]),
  requirementLevel: z.string().optional(),
  recommendedCaseCount: z.number().int().positive().optional(),
});

export type FlowStepRefContract = z.infer<typeof flowStepRefContractSchema>;
export type TestConditionContract = z.infer<typeof testConditionContractSchema>;

// ============================================================
// 3b. CoverageMatrix（Quality 输出的 F27 覆盖矩阵，展示 artifact）
// ============================================================

export const coverageMatrixContractSchema = z.object({
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
    byConditionType: z.record(z.string(), z.number()).optional(),
  }),
});

export type CoverageMatrixContract = z.infer<typeof coverageMatrixContractSchema>;