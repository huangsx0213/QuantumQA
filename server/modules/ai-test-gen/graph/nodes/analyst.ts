import type { TestGenState } from '../state';
import type { AgentObserver, SkillDefinition } from './types';
import type { AIProvider } from '../../infra/provider.ts';
import { mergeSignals } from '../../infra/provider.ts';
import { callLLMWithStructuredOutput, toSkillCallRecords } from './utils';
import { buildAnalystSystemPrompt, buildAnalystUserMessage } from '../prompts';
import { buildAnalystSkills } from '../skills/skills.ts';
import { loadComponentConditions } from '../skills/data-skills.ts';
import { pipelineRepo } from '../../repository.ts';
import { createAnalystOutputProfile } from '../structured-output/analyst.ts';
import { Log } from '../../../../shared/services/logger.ts';
import { requireMatchingHtmlKnowledgeRuntime,
  type ResolvedHtmlKnowledgeRuntime,
} from '../skills/html-knowledge.ts';
import { AGENT_NODE_TIMEOUT_MS } from '../timing.ts';

// ============================================================
// Output Schema
// ============================================================
// ============================================================
// Node
// ============================================================
export interface AnalystNodeOptions {
  provider: AIProvider;
  skills?: SkillDefinition[];
  observer?: AgentObserver;
  timeoutMs?: number;
  signal?: AbortSignal;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
}

export function makeAnalystNode(opts: AnalystNodeOptions) {
  const { provider, observer, timeoutMs = AGENT_NODE_TIMEOUT_MS, signal } = opts;
  const agentName = 'test_analyst';

  return async (state: TestGenState): Promise<Partial<TestGenState>> => {
    const startTime = Date.now();
    const log = Log.for(agentName);
    const reqCount = state.currentBatch?.length ?? 0;
    const batchInfo = `${state.batchContext?.currentBatch ?? '?'}/${state.batchContext?.totalBatches ?? '?'}`;
    const selectedFlowCount = state.selectedFlowIds?.length ?? 0;
    log.info(`ENTER ── batch ${batchInfo}, ${reqCount} requirements, selectedFlows=${selectedFlowCount}`);

    const htmlKnowledge = requireMatchingHtmlKnowledgeRuntime(
      state.projectId,
      state.htmlKnowledgeReference,
      opts.htmlKnowledge,
    );
    // Build skills dynamically inside the node: pass state.runId so previous_batch_conditions_query can query historical agent logs
    const skills = opts.skills ?? buildAnalystSkills(state.runId, state.projectId, state.currentBatch, htmlKnowledge);
    log.kv('skills.available', skills.length);

    observer?.onStart?.(agentName);

    try {
      const override = pipelineRepo.getPromptOverride(state.projectId, agentName);
      const systemPrompt = buildAnalystSystemPrompt(state, override?.custom_prompt ?? undefined);

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: buildAnalystUserMessage(state) },
      ];

      const nodeSignal = signal ? mergeSignals(signal, AbortSignal.timeout(timeoutMs)) : AbortSignal.timeout(timeoutMs);
      const allowedReqIds = new Set([
        ...(state.currentBatch ?? []).map(r => r.id),
        ...(state.selectedFlowIds ?? []),
      ]);
      const flowBlueprints = state.relevantFlowBlueprints ?? state.businessFlowBlueprints ?? [];
      // Build AC→parent story mapping so the structured-output profile can
      // auto-fix conditions that incorrectly use AC IDs as requirementId.
      // Covers ACs from current batch AND from all selected flow blueprints
      // (which may belong to flow stories not in this batch).
      const acParentMap = new Map<string, string>();
      for (const story of state.currentBatch ?? []) {
        const acs = (story as any).acceptanceCriteria ?? [];
        for (const ac of acs) {
          if (ac.id) acParentMap.set(ac.id, story.id);
        }
      }
      for (const bp of flowBlueprints) {
        if (bp.id && bp.flowStoryId) {
          acParentMap.set(bp.id, bp.flowStoryId);
        }
      }
      // Load component condition IDs from previous batches (flow mode) so the
      // structured-output profile can validate that `dependencies` references
      // real condition IDs — not fabricated compound IDs that break downstream
      // related-requirement lookup.
      const externalConditionIds = new Set<string>();
      if (state.generationMode === 'flow') {
        for (const condition of loadComponentConditions(state.runId)) {
          externalConditionIds.add(condition.id);
        }
      }
      const analystOutputProfile = createAnalystOutputProfile(allowedReqIds, flowBlueprints as any, acParentMap, externalConditionIds);
      const { output: validated, usage, toolCallRecords } = await callLLMWithStructuredOutput(
        provider,
        messages,
        skills,
        analystOutputProfile,
        {
          onStep: observer?.onStep,
          onThinking: observer?.onThinking,
          onToolCall: observer?.onToolCall,
        },
        agentName,
        { signal: nodeSignal, agentName, timeoutMs },
      );

      const latencyMs = Date.now() - startTime;
      const tcCount = validated.testConditions?.length ?? 0;
      const skillCallCount = toolCallRecords?.length ?? 0;
      const techniqueNames = [...new Set((validated.testConditions ?? []).map((tc: any) => tc.primaryTechnique).filter(Boolean))] as string[];
      observer?.onStep?.(agentName, 4, `Found ${tcCount} test conditions, ${techniqueNames.length} techniques`);
      const techniqueBreakdown = validated.testConditions?.reduce((acc: Record<string, number>, tc: any) => {
        acc[tc.primaryTechnique] = (acc[tc.primaryTechnique] || 0) + 1;
        return acc;
      }, {});
      log.success(`EXIT ── ${tcCount} test conditions`);
      log.kv('skill.calls', skillCallCount);
      log.kv('tokens', usage.input + usage.output);
      log.kv('tokens.cached', usage.cached);
      log.kv('latency', `${latencyMs}ms`);
      log.kv('techniques', JSON.stringify(techniqueBreakdown));
      if (skillCallCount > 0) {
        log.kv('skill.details', toolCallRecords!.map(tc => `${tc.name}(completed)`).join(', '));
      }
      observer?.onComplete?.(agentName, usage, latencyMs, messages, validated);

      return {
        requirementAnalysis: validated.requirementAnalysis,
        testConditions: validated.testConditions,
        skillCalls: toSkillCallRecords(agentName, toolCallRecords),
        phase: 'review-conditions' as const,
      };
    } catch (err: any) {
      observer?.onError?.(agentName, err);
      throw err;
    }
  };
}
