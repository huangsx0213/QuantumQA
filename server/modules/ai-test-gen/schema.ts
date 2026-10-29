import { z } from 'zod';

export const startPipelineSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object') {
    const hasReqs = Array.isArray(val.requirementIds) && val.requirementIds.length > 0;
    const hasFlows = Array.isArray(val.flowIds) && val.flowIds.length > 0;
    if (hasFlows && !hasReqs) {
      return { ...val, requirementIds: [] };
    }
    if (!hasReqs && !hasFlows) {
      const copy = { ...val };
      delete copy.requirementIds;
      return copy;
    }
  }
  return val;
}, z.object({
  requirementIds: z.array(z.string()),
  providerConfigName: z.string().min(1),
  model: z.string().optional(),
  mode: z.enum(['auto', 'interactive']).default('auto'),
  flowIds: z.array(z.string()).optional(),
  name: z.string().optional(),
  useCache: z.boolean().optional().default(false),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  reasoningSummary: z.enum(['auto', 'detailed', 'concise']).optional(),
  textVerbosity: z.enum(['low', 'medium', 'high']).optional(),
  referenceRunIds: z.array(z.string()).optional(),
  htmlKnowledgeSetId: z.string().min(1).optional(),
}));

export const resumePipelineSchema = z.object({
  action: z.enum(['approve', 'retry']),
  feedback: z.string().optional(),
  editedData: z.any().optional(),
});

export const checkpointUpdateSchema = z.object({
  editedData: z.record(z.string(), z.unknown()),
  checkpointNumber: z.number().int().min(1).max(3),
});
