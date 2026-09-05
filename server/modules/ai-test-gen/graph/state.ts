import { Annotation } from '@langchain/langgraph';
import type {
  PipelineBusinessFlowBlueprint,
} from '../../../../shared/contracts/index.ts';
import type {
  TestConditionContract,
  DraftTestCaseContract,
  FinalTestCaseContract,
  CoverageMatrixContract,
} from '../../../../shared/recording/agent-contracts.ts';
import type { HtmlKnowledgeReference } from '../html-knowledge/types.ts';

export interface BatchContext {
  currentBatch: number;
  totalBatches: number;
  processedCount: number;
}

/**
 * A requirement record (story or AC) within the current batch. Mirrors the
 * shape produced by `buildBatchInputState` in orchestrator.ts — including
 * `isFlow`, `description`, and nested `acceptanceCriteria` so prompt builders
 * and nodes can access them without per-access casts.
 */
export interface BatchRequirement {
  id: string;
  title: string;
  level: string;
  parentId: string;
  description?: string;
  isFlow?: boolean;
  acceptanceCriteria?: BatchAcceptanceCriteria[];
}

export interface BatchAcceptanceCriteria {
  id: string;
  title: string;
  description?: string;
  flowType?: string;
  relatedRequirementIds?: string[];
}

export interface SkillCallRecord {
  agent: string;
  skillName: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  timestamp: number;
}

export type Phase =
  | 'init'
  | 'preparation'
  | 'analysis'
  | 'review-conditions'
  | 'design'
  | 'review-draft'
  | 'quality'
  | 'final-review'
  | 'complete';

export const CHECKPOINT_BY_PHASE: Readonly<Record<string, number>> = {
  'review-conditions': 1,
  'review-draft': 2,
  'final-review': 3,
};

export const PHASE_BY_CHECKPOINT: Readonly<Record<number, Phase>> = {
  1: 'review-conditions',
  2: 'review-draft',
  3: 'final-review',
};

export const AGENT_NAME_BY_CHECKPOINT: Readonly<Record<number, string>> = {
  1: 'test_analyst',
  2: 'test_designer',
  3: 'quality_manager',
};

// L1 index layer: Epic-level global summary (replaces injecting requirement-level globalRequirementIndex into the prompt)
export interface GlobalEpicEntryChild {
  id: string;
  title: string;
  level: string;       // 'story' | 'ac'
  isFlow: boolean;
  // Nested ACs for story-level children (undefined for AC-level children).
  // Populated so the prompt can list story + AC titles/ids without a tool call.
  acs?: GlobalEpicEntryChild[];
}

export interface GlobalEpicEntry {
  epicId: string;
  title: string;
  requirementCount: number;
  storyCount: number;
  nonFlowAcCount: number;
  flowAcCount: number;
  flowCount: number;          // flow story count (subset of storyCount)
  statusBreakdown: Record<string, number>;
  children: GlobalEpicEntryChild[];   // direct children (stories + standalone ACs)
}

// L2 association layer: cross-epic dependency summary (precomputed by the preparation node, containing only entries relevant to the current batch)
export interface CrossEpicDependency {
  fromRequirementId: string;       // Requirement within the current batch
  toRequirementId: string;         // Cross-epic target requirement
  toEpicId: string;
  toEpicTitle: string;
  toRequirementTitle: string;
  relationType: 'depends-on' | 'depended-by' | 'sibling-in-other-epic' | 'referenced-by' | 'references';
}

// L2 association layer: coverage summary of completed batches (grouped by requirementId, replaces accumulating full condition text)
export interface PreviousBatchCoverageSummary {
  requirementId: string;
  conditionCount: number;
  categories: string[];
  techniques: string[];
  // Case-level cross-batch dedup view: only keeps counts by testLevel to avoid accumulating title lists.
  // Call previous_batch_cases_query when the LLM needs specific titles.
  caseCountByLevel: { component: number; integration: number };
}

export const TestGenStateAnnotation = Annotation.Root({
  // === Run Identity ===
  projectId: Annotation<string>,
  runId: Annotation<string>,
  mode: Annotation<'auto' | 'interactive'>,

  // === Batch Context ===
  requirementIds: Annotation<string[]>,
  epic: Annotation<{ id: string; title: string; description: string } | undefined>,
  currentBatch: Annotation<BatchRequirement[]>,
  batchContext: Annotation<BatchContext>,
  projectContext: Annotation<{ name: string; pages: { name: string }[]; endpoints: { name: string; method: string }[] }>,
  businessFlowBlueprints: Annotation<PipelineBusinessFlowBlueprint[] | undefined>,
  htmlKnowledgeReference: Annotation<HtmlKnowledgeReference | undefined>,

  // === Global Statistics (shared across all batches) ===
  globalStats: Annotation<{ totalRequirements: number; totalEpics: number; totalFlows: number } | undefined>,

  // === L1 Index Layer: Epic-level Global Summary (replaces injecting requirement-level list into the prompt) ===
  globalEpicIndex: Annotation<GlobalEpicEntry[] | undefined>,

  // === L2 Association Layer: Cross-epic Dependency Summary (precomputed by the preparation node) ===
  crossEpicDependencies: Annotation<CrossEpicDependency[] | undefined>,

  // === L2 Association Layer: Completed Batch Coverage Summary (grouped by requirementId, replaces accumulating full condition text) ===
  previousBatchCoverageSummary: Annotation<PreviousBatchCoverageSummary[] | undefined>,

  // === L2 Association Layer: Flow Blueprints Relevant to the Current Batch (written after preparation node filtering) ===
  relevantFlowBlueprints: Annotation<PipelineBusinessFlowBlueprint[] | undefined>,

  // === L2 Association Layer: Component Story Context Referenced by Flows (includes AC, injected as prompt context, does not generate batches separately) ===
  flowReferencedComponentContext: Annotation<Record<string, any[]> | undefined>,

  // === Preparation Outputs ===
  environmentReady: Annotation<boolean>,
  initializationLogs: Annotation<string[]>,
  tokenBudget: Annotation<{ estimated: number; limit: number | null }>,

  // === Test Analyst Outputs ===
  requirementAnalysis: Annotation<{ overallApproach: string; riskAssessmentSummary: string } | undefined>,
  testConditions: Annotation<TestConditionContract[] | undefined>,
  approvedConditions: Annotation<TestConditionContract[] | undefined>,

  // === Test Designer Outputs ===
  draftTestCases: Annotation<DraftTestCaseContract[] | undefined>,
  approvedDraftCases: Annotation<DraftTestCaseContract[] | undefined>,

  // === Quality Manager Outputs ===
  finalTestCases: Annotation<FinalTestCaseContract[] | undefined>,
  coverageMatrix: Annotation<CoverageMatrixContract | undefined>,

  // === Generation Mode ===
  generationMode: Annotation<'component' | 'flow' | 'mixed'>,
  selectedFlowIds: Annotation<string[]>,

  // === Pre-built Analyst User Prompt JSON ===
  analystInput: Annotation<Record<string, unknown> | undefined>,

  // === Review Feedback ===
  humanReviewFeedback: Annotation<string>,

  // === Skill Call Records ===
  skillCalls: Annotation<SkillCallRecord[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // === Phase Tracking ===
  phase: Annotation<Phase>,
  errors: Annotation<{ phase: string; agent: string; step: string; message: string; rawResponse?: string; timestamp: number }[]>,
});

export type TestGenState = typeof TestGenStateAnnotation.State;
