import type { TestGenState } from '../state';
import type { AgentObserver, SkillDefinition } from './types';
import type { AIProvider } from '../../infra/provider.ts';
import { mergeSignals } from '../../infra/provider.ts';
import { callLLMWithStructuredOutput } from './utils';
import { buildDesignerSystemPrompt, buildDesignerUserMessage, type ComponentConditionReference } from '../prompts';
import { buildDesignerSkills } from '../skills/skills.ts';
import { pipelineRepo } from '../../repository.ts';
import { createDesignerOutputProfile } from '../structured-output/designer.ts';
import type { DraftTestCaseContract } from '../../../../../shared/recording/agent-contracts.ts';
import { Log } from '../../../../shared/services/logger.ts';
import {
  requireMatchingHtmlKnowledgeRuntime,
  type ResolvedHtmlKnowledgeRuntime,
} from '../skills/html-knowledge.ts';
import { AGENT_NODE_TIMEOUT_MS } from '../timing.ts';

// ============================================================
// Output Schema
// ============================================================
// ============================================================
// Node
// ============================================================
export interface DesignerNodeOptions {
  provider: AIProvider;
  skills?: SkillDefinition[];
  observer?: AgentObserver;
  timeoutMs?: number;
  signal?: AbortSignal;
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime;
}

export function makeDesignerNode(opts: DesignerNodeOptions) {
  const { provider, observer, timeoutMs = AGENT_NODE_TIMEOUT_MS, signal } = opts;
  const agentName = 'test_designer';

  return async (state: TestGenState): Promise<Partial<TestGenState>> => {
    const startTime = Date.now();
    const log = Log.for(agentName);
    const condCount = (state.approvedConditions ?? state.testConditions ?? []).length;
    const htmlKnowledge = requireMatchingHtmlKnowledgeRuntime(
      state.projectId,
      state.htmlKnowledgeReference,
      opts.htmlKnowledge,
    );
    // Build skills dynamically inside the node: pass state.runId so previous_batch_cases_query can query historical agent logs
    const skills = opts.skills ?? buildDesignerSkills(state.runId, state.projectId, state.currentBatch, htmlKnowledge);
    log.info(`ENTER ── ${condCount} conditions to design`);

    observer?.onStart?.(agentName);

    try {
      const override = pipelineRepo.getPromptOverride(state.projectId, agentName);
      const systemPrompt = buildDesignerSystemPrompt(state, override?.custom_prompt ?? undefined);
      const conditions = state.approvedConditions ?? state.testConditions ?? [];
      const availableComponentConditions = new Map<string, ComponentConditionReference>();
      if (state.generationMode === 'flow' || state.generationMode === 'mixed') {
        if (state.generationMode === 'mixed') {
          // Mixed mode: component conditions are in the SAME batch's state
          // (already approved by the reviewer). Load from current state, not
          // from previous batch logs.
          const currentConditions = state.approvedConditions ?? state.testConditions ?? [];
          for (const condition of currentConditions) {
            if (condition.conditionType !== 'component') continue;
            const referenceId = `component:${condition.requirementId}:${condition.id}`;
            availableComponentConditions.set(referenceId, {
              referenceId,
              conditionId: condition.id,
              requirementId: condition.requirementId,
              condition: condition.condition,
            });
          }
        } else {
          // Flow mode: load component conditions from previous batch logs
          for (const logEntry of pipelineRepo.getAgentLogs(state.runId, 'test_analyst')) {
            for (const condition of logEntry.output_data?.testConditions ?? []) {
              if (condition.conditionType !== 'component') continue;
              const referenceId = `component:${condition.requirementId}:${condition.id}`;
              availableComponentConditions.set(referenceId, {
                referenceId,
                conditionId: condition.id,
                requirementId: condition.requirementId,
                condition: condition.condition,
              });
            }
          }
        }
      }
      const componentConditionReferences = [...availableComponentConditions.values()];
      const outputProfile = createDesignerOutputProfile(conditions.map((condition) => {
        // F1: derive expectedTestLevel from the new conditionType field
        // directly. The legacy "testLevel:*" tag in coverageDimensions is
        // being phased out (the Analyst prompt no longer emits it), so
        // conditionType is the source of truth.
        const ct = (condition as any).conditionType;
        const expectedTestLevel: 'component' | 'integration' | undefined =
          ct === 'flow' ? 'integration'
          : ct === 'component' ? 'component'
          : undefined;
        return {
          id: condition.id,
          requirementId: condition.requirementId,
          expectedTestLevel,
          // F1: forward the new conditionType to the schema validator.
          conditionType: ct,
        };
      }), componentConditionReferences.map((condition) => condition.referenceId));

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: buildDesignerUserMessage(state, componentConditionReferences) },
      ];

      const nodeSignal = signal ? mergeSignals(signal, AbortSignal.timeout(timeoutMs)) : AbortSignal.timeout(timeoutMs);
      const { output: validated, usage, toolCallRecords } = await callLLMWithStructuredOutput(
        provider,
        messages,
        skills,
        outputProfile,
        {
          onStep: observer?.onStep,
          onThinking: observer?.onThinking,
          onToolCall: observer?.onToolCall,
        },
        agentName,
        { signal: nodeSignal, agentName, timeoutMs },
      );

      const latencyMs = Date.now() - startTime;
      const draftCount = validated.draftTestCases?.length ?? 0;
      const skillCallCount = toolCallRecords?.length ?? 0;
      const avgScore = draftCount > 0
        ? validated.draftTestCases.reduce((sum, tc) => sum + tc.selfReview.score, 0) / draftCount
        : 0;
      observer?.onStep?.(agentName, 4, `Designed ${draftCount} cases, avg self-review ${avgScore.toFixed(1)}/10`);
      log.success(`EXIT ── ${draftCount} draft test cases`);
      log.kv('selfReview.avg', avgScore.toFixed(1));
      log.kv('skill.calls', skillCallCount);
      log.kv('tokens', usage.input + usage.output);
      log.kv('tokens.cached', usage.cached);
      log.kv('latency', `${latencyMs}ms`);
      if (skillCallCount > 0) {
        log.kv('skill.details', toolCallRecords!.map(tc => `${tc.name}(completed)`).join(', '));
      }
      observer?.onComplete?.(agentName, usage, latencyMs, messages, validated);

      return {
        draftTestCases: validated.draftTestCases as DraftTestCaseContract[],
        skillCalls: (toolCallRecords ?? []).map(tc => ({
          agent: agentName,
          skillName: tc.name,
          input: tc.input,
          output: tc.output,
          latencyMs: tc.latencyMs,
          timestamp: Date.now(),
        })),
        phase: 'review-draft' as const,
      };
    } catch (err: any) {
      observer?.onError?.(agentName, err);
      throw err;
    }
  };
}
