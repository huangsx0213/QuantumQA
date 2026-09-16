import { describe, expect, it, vi } from 'vitest';
import {
  callLLMWithStructuredOutput,
} from '../graph/nodes/utils.ts';
import { emitCaseSkill } from '../graph/skills/emit-case-skill.ts';

function makeCaseArgs(i: number) {
  return {
    id: `TC-${i}`, title: `Case ${i}`, conditionId: 'C-1', requirementId: 'req-1',
    priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
    steps: [{ verb: 'verify', targetHint: `element ${i}`, expectation: { kind: 'element-visible' } }],
  };
}

describe('E1 early termination excludes emit_case', () => {
  it('does NOT abort the ReAct loop while the LLM is legitimately emitting cases via emit_case', async () => {
    let callCount = 0;
    // ReAct loop invokes streamChat once per round; each call returns a fresh stream.
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        // 5 rounds each emitting one case via the emit_case tool. This is LONGER
        // than the old E1 threshold (3 consecutive same-tool calls → forced abort).
        if (callCount <= 5) {
          yield { type: 'content', content: `emitting case ${callCount}` };
          yield { type: 'tool_call_start', toolCall: { id: `e${callCount}`, name: 'emit_case', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: `e${callCount}`, name: 'emit_case', args: makeCaseArgs(callCount) } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        // ...then a 6th round with no tool calls (normal exit).
        yield { type: 'content', content: 'emission complete' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const output = { draftTestCases: [] };
    const profile = {
      toolSchema: { type: 'object', properties: {} },
      normalize: vi.fn((raw: any) => raw),
      parse: vi.fn(() => output),
      formatValidationError: vi.fn(() => 'Schema validation failed'),
    };

    await callLLMWithStructuredOutput(
      provider,
      [] as any,
      [emitCaseSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    // 5 emit_case rounds + 1 normal-exit round = 6 streamChat calls.
    // OLD behavior (E1 counts emit_case): after 4 calls the last 3 records are all
    // emit_case → forced abort at 4 calls. NEW behavior must reach all 6.
    expect(provider.streamChat).toHaveBeenCalledTimes(6);
  });
});

describe('runtime schema gate on emit_case (real-world retry cause)', () => {
  it('rejects a non-vocabulary verb in emit_case args at call time, before emit-extract', async () => {
    let callCount = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'content', content: 'emitting' };
          // "refresh browser page" — not a vocabulary verb; MUST be rejected by schema gate
          yield { type: 'tool_call_start', toolCall: { id: 'bad1', name: 'emit_case', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'bad1', name: 'emit_case', args: {
            id: 'TC-1', title: 'Bad', conditionId: 'C-1', requirementId: 'req-1',
            priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
            steps: [{ verb: 'refresh', targetHint: 'browser page' }],
          } } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        yield { type: 'content', content: 'retrying with valid verb' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const output = { draftTestCases: [] };
    const profile = {
      toolSchema: { type: 'object', properties: {} },
      normalize: vi.fn((raw: any) => raw),
      parse: vi.fn(() => output),
      formatValidationError: vi.fn(() => 'Schema validation failed'),
    };

    await callLLMWithStructuredOutput(
      provider,
      [] as any,
      [emitCaseSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    // The loop continues (2nd round) — the invalid tool call was rejected, not acked.
    expect(provider.streamChat).toHaveBeenCalledTimes(2);
  });

  it('rejects a fill step missing data in the steps array at call time', async () => {
    let callCount = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'content', content: 'emitting' };
          yield { type: 'tool_call_start', toolCall: { id: 'bad2', name: 'emit_case', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'bad2', name: 'emit_case', args: {
            id: 'TC-1', title: 'Bad', conditionId: 'C-1', requirementId: 'req-1',
            priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
            steps: [{ verb: 'fill', targetHint: 'username input field' }],
          } } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        yield { type: 'content', content: 'retrying with data' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const output = { draftTestCases: [] };
    const profile = {
      toolSchema: { type: 'object', properties: {} },
      normalize: vi.fn((raw: any) => raw),
      parse: vi.fn(() => output),
      formatValidationError: vi.fn(() => 'Schema validation failed'),
    };

    await callLLMWithStructuredOutput(
      provider,
      [] as any,
      [emitCaseSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    expect(provider.streamChat).toHaveBeenCalledTimes(2);
  });
});