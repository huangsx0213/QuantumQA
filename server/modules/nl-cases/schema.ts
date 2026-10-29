import { z } from 'zod';

const nlStepSchema = z.object({
  sequence: z.number().optional(),
  stepNumber: z.number().optional(),
  action: z.string().min(1),
  expected: z.string().optional(),
  intent: z.record(z.string(), z.unknown()).optional(),
});

const testDataSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional().default(''),
});

export const nlCasePayloadSchema = z.object({
  title: z.string().min(1),
  requirementId: z.string().optional(),
  conditionId: z.string().optional(),
  techniqueApplied: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
  category: z.string().optional(),
  preconditions: z.array(z.string()).optional().default([]),
  testData: z.array(testDataSchema).optional().default([]),
  steps: z.array(nlStepSchema),
  postconditions: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  status: z.enum(['DRAFT', 'APPROVED', 'FINAL']).optional().default('DRAFT'),
});

export const nlCasePatchSchema = z.object({
  title: z.string().min(1).optional(),
  requirementId: z.string().optional(),
  conditionId: z.string().optional(),
  techniqueApplied: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  category: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  testData: z.array(testDataSchema).optional(),
  steps: z.array(nlStepSchema).optional(),
  postconditions: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['DRAFT', 'APPROVED', 'FINAL']).optional(),
});