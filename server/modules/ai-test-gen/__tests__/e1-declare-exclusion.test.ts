import { describe, expect, it, vi } from 'vitest';
import {
  callLLMWithStructuredOutput,
} from '../graph/nodes/utils.ts';
import { declareCaseSkill, declareStepSkill } from '../graph/skills/declare-step-skill.ts';

function makeStepArgs(i: number) {
  return { caseId: 'TC-001', stepNumber: i, verb: 'verify', targetHint: `element ${i}`, expectation: { kind: 'element-visible' } };
}

describe('E1 early termination excludes declaration tools', () => {
  it('does NOT abort the ReAct loop while the LLM is legitimately declaring steps via declare_step', async () => {
    let callCount = 0;
    // ReAct loop invokes streamChat once per round; each call returns a fresh stream.
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        // 5 rounds each declaring one step via the declare_step tool. This is LONGER
        // than the old E1 threshold (3 consecutive same-tool calls → forced abort).
        if (callCount <= 5) {
          yield { type: 'content', content: `declaring step ${callCount}` };
          yield { type: 'tool_call_start', toolCall: { id: `d${callCount}`, name: 'declare_step', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: `d${callCount}`, name: 'declare_step', args: makeStepArgs(callCount) } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        // ...then a 6th round with no tool calls (normal exit).
        yield { type: 'content', content: 'declaration complete' };
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
      [declareCaseSkill, declareStepSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    // 5 declare_step rounds + 1 normal-exit round = 6 streamChat calls.
    // OLD behavior (E1 counts declare_step): after 4 calls the last 3 records are all
    // declare_step → forced abort at 4 calls. NEW behavior must reach all 6.
    // (E1 fires on the round AFTER the 4th call completes since it checks post-stream.)
    console.log('ACTUAL streamChat calls:', provider.streamChat.mock.calls.length);
    expect(provider.streamChat).toHaveBeenCalledTimes(6);
  });
});

describe('runtime schema gate on declare_step (real-world retry cause)', () => {
  it('rejects a non-vocabulary verb in declare_step args at call time, before declare-extract', async () => {
    let callCount = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'content', content: 'declaring' };
          // "refresh browser page" — not a vocabulary verb; MUST be rejected by schema gate
          yield { type: 'tool_call_start', toolCall: { id: 'bad1', name: 'declare_step', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'bad1', name: 'declare_step', args: { caseId: 'TC-1', steps: [{ verb: 'refresh', targetHint: 'browser page' }] } } };
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
      [declareCaseSkill, declareStepSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    // The loop continues (2nd round) — the invalid tool call was rejected, not acked,
    // so declare-extract built nothing and the LLM retried in a fresh round.
    expect(provider.streamChat).toHaveBeenCalledTimes(2);
  });

  it('rejects a fill step missing data in the steps array at call time', async () => {
    let callCount = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'content', content: 'declaring' };
          yield { type: 'tool_call_start', toolCall: { id: 'bad2', name: 'declare_step', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'bad2', name: 'declare_step', args: { caseId: 'TC-1', steps: [{ verb: 'fill', targetHint: 'username input field' }] } } };
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
      [declareCaseSkill, declareStepSkill] as any,
      profile as any,
      undefined,
      'test_designer',
    );

    expect(provider.streamChat).toHaveBeenCalledTimes(2);
  });
});