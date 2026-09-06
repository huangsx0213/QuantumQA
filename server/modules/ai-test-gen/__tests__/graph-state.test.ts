import { describe, expect, it } from 'vitest';
import {
  TestGenStateAnnotation,
  CHECKPOINT_BY_PHASE,
  PHASE_BY_CHECKPOINT,
  AGENT_NAME_BY_CHECKPOINT,
} from '../graph/state.ts';

describe('graph/state', () => {
  describe('Annotation shape', () => {
    it('defines the expected state channels', () => {
      const channels = TestGenStateAnnotation.spec;
      const keys = Object.keys(channels);
      // Core fields
      expect(keys).toContain('projectId');
      expect(keys).toContain('runId');
      expect(keys).toContain('mode');
      expect(keys).toContain('requirementIds');
      expect(keys).toContain('currentBatch');
      expect(keys).toContain('batchContext');
      expect(keys).toContain('projectContext');
      expect(keys).toContain('businessFlowBlueprints');
      expect(keys).toContain('htmlKnowledgeReference');
      expect(keys).toContain('phase');
      expect(keys).toContain('errors');
      // Analyst outputs
      expect(keys).toContain('requirementAnalysis');
      expect(keys).toContain('testConditions');
      expect(keys).toContain('approvedConditions');
      // Designer outputs
      expect(keys).toContain('draftTestCases');
      expect(keys).toContain('approvedDraftCases');
      // Quality outputs
      expect(keys).toContain('finalTestCases');
      expect(keys).toContain('coverageMatrix');
      // Review
      expect(keys).toContain('humanReviewFeedback');
      // New fields
      expect(keys).toContain('environmentReady');
      expect(keys).toContain('initializationLogs');
      expect(keys).toContain('tokenBudget');
      expect(keys).toContain('skillCalls');

      // Only the bounded, persistence-safe reference belongs in checkpoints.
      expect(keys).not.toContain('htmlKnowledge');
      expect(keys).not.toContain('htmlKnowledgeRuntime');
      expect(keys).not.toContain('htmlKnowledgeSnapshot');
      expect(keys).not.toContain('knowledgeIndex');
      expect(keys).not.toContain('normalizedHtml');
    });

    it('appends tool-call history across all agents, zero-call updates, and retries', () => {
      const channel = TestGenStateAnnotation.spec.skillCalls.fromCheckpoint();
      const analyst = {
        agent: 'test_analyst', skillName: 'html_knowledge_query', input: {}, output: {}, latencyMs: 1, timestamp: 1,
      };
      const designer = {
        agent: 'test_designer', skillName: 'requirement_detail_query', input: {}, output: {}, latencyMs: 2, timestamp: 2,
      };
      const quality = {
        agent: 'quality_manager', skillName: 'flow_detail_query', input: {}, output: {}, latencyMs: 3, timestamp: 3,
      };
      const analystRetry = {
        agent: 'test_analyst', skillName: 'requirement_graph_query', input: {}, output: {}, latencyMs: 4, timestamp: 4,
      };

      channel.update([[analyst]]);
      channel.update([[designer]]);
      channel.update([[]]);
      channel.update([[quality]]);
      channel.update([[analystRetry]]);

      expect(channel.get()).toEqual([analyst, designer, quality, analystRetry]);
    });

    it('bounds the skillCalls channel to the most recent records', () => {
      const channel = TestGenStateAnnotation.spec.skillCalls.fromCheckpoint();
      const make = (i: number) => ({
        agent: 'test_analyst', skillName: `s${i}`, input: {}, output: {}, latencyMs: 1, timestamp: i,
      });
      const batch = Array.from({ length: 250 }, (_, i) => make(i));
      channel.update([batch]);
      const got = channel.get();
      expect(got).toHaveLength(200);
      expect(got[0].timestamp).toBe(50);
      expect(got.at(-1)?.timestamp).toBe(249);
    });
  });

  describe('CHECKPOINT_BY_PHASE', () => {
    it('maps the three review phases to checkpoint numbers 1-3', () => {
      expect(CHECKPOINT_BY_PHASE['review-conditions']).toBe(1);
      expect(CHECKPOINT_BY_PHASE['review-draft']).toBe(2);
      expect(CHECKPOINT_BY_PHASE['final-review']).toBe(3);
    });
  });

  describe('PHASE_BY_CHECKPOINT', () => {
    it('reverses the mapping', () => {
      expect(PHASE_BY_CHECKPOINT[1]).toBe('review-conditions');
      expect(PHASE_BY_CHECKPOINT[2]).toBe('review-draft');
      expect(PHASE_BY_CHECKPOINT[3]).toBe('final-review');
    });
  });

  describe('AGENT_NAME_BY_CHECKPOINT', () => {
    it('maps checkpoint number to agent display name used by frontend', () => {
      expect(AGENT_NAME_BY_CHECKPOINT[1]).toBe('test_analyst');
      expect(AGENT_NAME_BY_CHECKPOINT[2]).toBe('test_designer');
      expect(AGENT_NAME_BY_CHECKPOINT[3]).toBe('quality_manager');
    });
  });
});
