import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  buildThinkingChatOptions,
  callLLMWithStructuredOutput,
  makeSchemaOpenAICompatible,
  zodToJsonSchema,
} from '../graph/nodes/utils.ts';
import { createAnalystOutputProfile } from '../graph/structured-output/analyst.ts';
import { HtmlKnowledgeCriticalError } from '../graph/skills/html-knowledge.ts';

describe('callLLMWithStructuredOutput', () => {
  it('does not advertise an unsupported structured-output tool during the thinking phase', () => {
    const options = buildThinkingChatOptions([
      {
        name: 'requirement_detail_query',
        description: 'Fetch requirement details',
        schema: z.object({ requirementId: z.string() }) as any,
      } as any,
    ]);

    expect(options.tools?.map((tool) => tool.name)).toEqual(['requirement_detail_query']);
  });

  it('normalizes phase 2 extraction before parsing', async () => {
    let callCount = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        if (callCount === 0) {
          callCount += 1;
          yield { type: 'content', content: 'analysis without tool call' };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }
        yield { type: 'content', content: '{"finalTestCases":{"a":{"id":"TC-2"}}}' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const profile = {
      toolSchema: { type: 'object', properties: {} },
      normalize: vi.fn((raw: any) => ({ finalTestCases: Object.values(raw.finalTestCases) })),
      parse: vi.fn((normalized: any) => normalized),
      formatValidationError: vi.fn(() => 'Schema validation failed'),
    };

    const result: any = await callLLMWithStructuredOutput(
      provider,
      [],
      [],
      profile as any,
      undefined,
      'quality_manager',
    );

    expect(profile.normalize).toHaveBeenCalledWith({ finalTestCases: { a: { id: 'TC-2' } } });
    expect(profile.parse).toHaveBeenCalledWith({ finalTestCases: [{ id: 'TC-2' }] });
    expect(result.output.finalTestCases).toHaveLength(1);
  });

  it('treats a hallucinated structured-output tool call as unknown and continues to phase 2 extraction', async () => {
    const calls: any[][] = [];
    let streamIndex = 0;
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        calls.push(messages);
        streamIndex += 1;

        if (streamIndex === 1) {
          yield { type: 'content', content: 'analysis round with unsupported tool call' };
          yield { type: 'tool_call_start', toolCall: { id: 'tool-1', name: 'output_result', args: {} } };
          yield { type: 'tool_call_end', toolCall: { id: 'tool-1', name: 'output_result', args: {} } };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }

        if (streamIndex === 2) {
          yield { type: 'content', content: 'continuing analysis after unsupported tool call' };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }

        yield { type: 'content', content: '{"finalTestCases":[{"id":"TC-1","title":"Verify login","conditionId":"C-1","requirementId":"REQ-1","priority":"high","category":"functional","techniqueApplied":"EP","preconditions":[],"testData":[],"steps":[{"stepNumber":1,"action":"Enter credentials","expected":"Values appear"}],"tags":[],"status":"approved","reviewSummary":"ok","changeLog":[]}]}' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const profile = {
      toolSchema: { type: 'object', properties: {} },
      shouldAttemptPhase1Extraction: (raw: unknown) => !!raw && typeof raw === 'object' && !Array.isArray(raw),
      normalize: vi.fn((raw: any) => raw),
      parse: vi.fn((normalized: any) => normalized),
      formatValidationError: vi.fn(() => 'Schema validation failed'),
    };

    const result: any = await callLLMWithStructuredOutput(
      provider,
      [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'user prompt' }] as any,
      [],
      profile as any,
      undefined,
      'quality_manager',
    );

    expect(streamIndex).toBe(3);
    expect(result.output.finalTestCases).toHaveLength(1);

    const retryMessages = calls[1];
    const retryToolMessage = retryMessages.find((message) => message.role === 'tool');
    const retryToolPayload = JSON.parse(String(retryToolMessage.content));
    expect(String(retryToolPayload.error)).toContain('Unknown tool: "output_result"');
    expect(String(retryToolPayload.error)).toContain('Continue your analysis in plain text');

    const phase2Messages = calls[2];
    const lastMessage = phase2Messages[phase2Messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(String(lastMessage.content)).toContain('Based on the analysis above, output a single JSON object matching this schema.');
  });

  it('skips Phase 1 parsing when extracted JSON lacks the expected top-level wrapper', async () => {
    const calls: any[][] = [];
    let streamIndex = 0;
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        calls.push(messages);
        streamIndex += 1;

        if (streamIndex === 1) {
          yield {
            type: 'content',
            content: 'analysis text\n```json\n{"id":"C-1","requirementId":"REQ-1","condition":"Verify login","conditionType":"flow","flowStepRefs":[{"flowId":"F-login","sequence":2,"actionSummary":"Submit credentials"}],"category":"functional","priority":"high","riskLevel":"high","primaryTechnique":"Use Case Testing","secondaryTechniques":[],"techniqueRationale":"happy path","coverageDimensions":["authentication"],"dependencies":[]}\n```',
          };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
          return;
        }

        yield {
          type: 'content',
          content: '{"requirementAnalysis":{"overallApproach":"Use risk-based login analysis","riskAssessmentSummary":"Authentication is high risk"},"testConditions":[{"id":"C-1","requirementId":"REQ-1","condition":"Verify login","conditionType":"flow","flowStepRefs":[{"flowId":"F-login","sequence":2,"actionSummary":"Submit credentials"}],"category":"functional","priority":"high","riskLevel":"high","primaryTechnique":"Use Case Testing","secondaryTechniques":[],"techniqueRationale":"happy path","coverageDimensions":["authentication"],"dependencies":[]}]}',
        };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } };
      }),
    } as any;

    const result: any = await callLLMWithStructuredOutput(
      provider,
      [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'user prompt' }] as any,
      [],
      createAnalystOutputProfile(),
      undefined,
      'test_analyst',
    );

    expect(streamIndex).toBe(2);
    expect(result.output.testConditions).toHaveLength(1);
    const phase2Messages = calls[1];
    const lastMessage = phase2Messages[phase2Messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(String(lastMessage.content)).toContain('Based on the analysis above, output a single JSON object matching this schema.');
  });

  it('sends full tool evidence to the provider but persists only the skill projection with real latency', async () => {
    const evidenceMarker = 'FULL_EVIDENCE_MARKER';
    const calls: any[][] = [];
    let streamIndex = 0;
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        calls.push(structuredClone(messages));
        streamIndex += 1;
        if (streamIndex === 1) {
          yield {
            type: 'tool_call_start',
            toolCall: {
              id: 'html-tool-1',
              name: 'html_knowledge_query',
              args: { requirementIds: 'REQ-1' },
            },
          };
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'html-tool-1',
              name: 'html_knowledge_query',
              args: { requirementIds: 'REQ-1' },
            },
          };
          yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } };
          return;
        }
        yield { type: 'content', content: '{"ok":true}' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    } as any;
    const fullResult = JSON.stringify({ staticText: evidenceMarker });
    const skill = {
      name: 'html_knowledge_query',
      description: 'Retrieve HTML evidence',
      schema: z.object({ requirementIds: z.string() }),
      func: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 12));
        return fullResult;
      }),
      summarizeForState: vi.fn((_input, _result, meta) => ({
        input: { requirementIds: ['REQ-1'], focus: 'all', maxResults: 5 },
        output: {
          resultChars: meta.resultSize,
          confidence: [{ requestedRequirementId: 'REQ-1', confidence: 'high' }],
          pageIds: ['page-1'],
          chunkIds: ['chunk-1'],
          omittedRequirementIds: [],
          truncated: false,
          cacheHit: false,
        },
      })),
    };
    const profile = {
      toolSchema: { type: 'object', properties: {} },
      shouldAttemptPhase1Extraction: () => true,
      normalize: (raw: unknown) => raw,
      parse: (raw: unknown) => raw,
      formatValidationError: () => 'invalid',
    };

    const result = await callLLMWithStructuredOutput(
      provider,
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      [skill],
      profile as any,
      undefined,
      'test_analyst',
    );

    expect(JSON.stringify(calls[1])).toContain(evidenceMarker);
    expect(JSON.stringify(result.toolCallRecords)).not.toContain(evidenceMarker);
    expect(result.toolCallRecords?.[0]).toMatchObject({
      name: 'html_knowledge_query',
      input: { requirementIds: ['REQ-1'], focus: 'all', maxResults: 5 },
      output: {
        resultChars: fullResult.length,
        pageIds: ['page-1'],
        chunkIds: ['chunk-1'],
      },
    });
    expect(result.toolCallRecords?.[0].latencyMs).toBeGreaterThanOrEqual(1);
  });

  it('emits a projected tool call before a later agent failure', async () => {
    const rawEvidence = 'RAW_HTML_BEFORE_AGENT_FAILURE';
    const onToolCall = vi.fn();
    let round = 0;
    const provider = {
      streamChat: vi.fn(async function* () {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: 'html-before-failure', name: 'html_knowledge_query', args: {} },
          };
          yield {
            type: 'tool_call_end',
            toolCall: { id: 'html-before-failure', name: 'html_knowledge_query', args: {} },
          };
          return;
        }
        throw new Error('provider failed after tool success');
      }),
    } as any;

    await expect(callLLMWithStructuredOutput(
      provider,
      [],
      [{
        name: 'html_knowledge_query',
        description: 'Retrieve HTML evidence',
        schema: z.object({}),
        func: async () => rawEvidence,
        summarizeForState: () => ({
          input: { requirementIds: ['story-1'] },
          output: { resultChars: rawEvidence.length, pageIds: ['page-1'] },
        }),
      }],
      {
        toolSchema: { type: 'object', properties: {} },
        normalize: (raw: unknown) => raw,
        parse: (raw: unknown) => raw,
        formatValidationError: () => 'invalid',
      } as any,
      { onToolCall },
      'test_analyst',
    )).rejects.toThrow('provider failed after tool success');

    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith('test_analyst', expect.objectContaining({
      output: { resultChars: rawEvidence.length, pageIds: ['page-1'] },
    }));
    expect(JSON.stringify(onToolCall.mock.calls)).not.toContain(rawEvidence);
  });

  it('lets html_knowledge_query handle malformed JSON arguments as a corrective tool result', async () => {
    const calls: any[][] = [];
    let streamIndex = 0;
    const func = vi.fn(async () => JSON.stringify({
      error: 'INVALID_HTML_KNOWLEDGE_QUERY',
      message: 'Use requirementIds as a string or array.',
    }));
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        calls.push(structuredClone(messages));
        streamIndex += 1;
        if (streamIndex === 1) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: 'bad-html-args', name: 'html_knowledge_query', args: '{not-json' },
          };
          yield {
            type: 'tool_call_end',
            toolCall: { id: 'bad-html-args', name: 'html_knowledge_query', args: '{not-json' },
          };
          return;
        }
        yield { type: 'content', content: '{"ok":true}' };
      }),
    } as any;

    await callLLMWithStructuredOutput(
      provider,
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      [{
        name: 'html_knowledge_query',
        description: 'Retrieve HTML evidence',
        schema: z.object({ requirementIds: z.string() }),
        func,
      }],
      {
        toolSchema: { type: 'object', properties: {} },
        shouldAttemptPhase1Extraction: () => true,
        normalize: (raw: unknown) => raw,
        parse: (raw: unknown) => raw,
        formatValidationError: () => 'invalid',
      } as any,
    );

    expect(func).toHaveBeenCalledWith('{not-json');
    expect(JSON.stringify(calls[1])).toContain('INVALID_HTML_KNOWLEDGE_QUERY');
  });

  it('aborts immediately when html_knowledge_query throws a critical retrieval failure', async () => {
    const provider = {
      streamChat: vi.fn(async function* () {
        yield {
          type: 'tool_call_start',
          toolCall: { id: 'html-failure', name: 'html_knowledge_query', args: {} },
        };
        yield {
          type: 'tool_call_end',
          toolCall: { id: 'html-failure', name: 'html_knowledge_query', args: {} },
        };
      }),
    } as any;

    await expect(callLLMWithStructuredOutput(
      provider,
      [],
      [{
        name: 'html_knowledge_query',
        description: 'Retrieve HTML evidence',
        schema: z.object({}),
        func: async () => {
          throw new HtmlKnowledgeCriticalError('Bound HTML knowledge set is corrupt');
        },
      }],
      {
        toolSchema: { type: 'object', properties: {} },
        normalize: (raw: unknown) => raw,
        parse: (raw: unknown) => raw,
        formatValidationError: () => 'invalid',
      } as any,
    )).rejects.toThrow(/Critical tool execution failed.*html_knowledge_query/i);
    expect(provider.streamChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined', undefined],
    ['circular', (() => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    })()],
  ])('normalizes a %s successful tool result to explicit null', async (_name, toolResult) => {
    const providerCalls: any[][] = [];
    let round = 0;
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        providerCalls.push(structuredClone(messages));
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: 'tool-null', name: 'nullable_tool', args: {} },
          };
          yield {
            type: 'tool_call_end',
            toolCall: { id: 'tool-null', name: 'nullable_tool', args: {} },
          };
          return;
        }
        yield { type: 'content', content: '{"ok":true}' };
      }),
    } as any;

    const result = await callLLMWithStructuredOutput(
      provider,
      [],
      [{
        name: 'nullable_tool',
        description: 'Returns a non-serializable value',
        schema: z.object({}),
        func: async () => toolResult,
      }],
      {
        toolSchema: { type: 'object', properties: {} },
        shouldAttemptPhase1Extraction: () => true,
        normalize: (raw: unknown) => raw,
        parse: (raw: unknown) => raw,
        formatValidationError: () => 'invalid',
      } as any,
    );

    const toolMessage = providerCalls[1].find((message) => message.role === 'tool');
    expect(toolMessage.content).toBe('null');
    expect(result.toolCallRecords?.[0].output).toBeNull();
  });

  it.each([
    ['null', () => null],
    ['missing output', () => ({ input: {} })],
    ['non-serializable', () => ({ input: {}, output: 1n })],
    ['throwing', () => { throw new Error('PRIVATE_PROJECTION_DETAILS'); }],
  ])('fails closed for a %s state projection without persisting raw results', async (_name, summarizeForState) => {
    const rawEvidence = 'RAW_PRIVATE_TOOL_EVIDENCE';
    const provider = {
      streamChat: vi.fn(async function* () {
        yield {
          type: 'tool_call_start',
          toolCall: { id: 'projection-failure', name: 'projection_tool', args: {} },
        };
        yield {
          type: 'tool_call_end',
          toolCall: { id: 'projection-failure', name: 'projection_tool', args: {} },
        };
      }),
    } as any;

    let error: unknown;
    try {
      await callLLMWithStructuredOutput(
        provider,
        [],
        [{
          name: 'projection_tool',
          description: 'Projects tool state',
          schema: z.object({}),
          func: async () => ({ rawEvidence }),
          summarizeForState: summarizeForState as any,
        }],
        {
          toolSchema: { type: 'object', properties: {} },
          normalize: (raw: unknown) => raw,
          parse: (raw: unknown) => raw,
          formatValidationError: () => 'invalid',
        } as any,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
expect((error as Error).message).toMatch(/tool state projection failed/i);
    expect((error as Error).message).not.toContain(rawEvidence);
    expect((error as Error).message).not.toContain('PRIVATE_PROJECTION_DETAILS');
    expect(provider.streamChat).toHaveBeenCalledTimes(1);
  });

  it('repairs only the failing fields (targeted) instead of regenerating the whole object', async () => {
    const calls: any[][] = [];
    let parseCount = 0;
    const provider = {
      streamChat: vi.fn(async function* (messages: any[]) {
        calls.push(structuredClone(messages));
        yield { type: 'content', content: '{"draftTestCases":[]}' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    } as any;

    const profile = {
      toolSchema: { type: 'object', properties: {} },
      // 跳过 Phase 1 解析，聚焦测 Phase 2 的定点修复重试。
      shouldAttemptPhase1Extraction: () => false,
      normalize: (raw: unknown) => raw,
      parse: (normalized: unknown) => {
        parseCount += 1;
        if (parseCount === 1) {
          // 模拟 zod 校验失败：两个字段违规（一个深路径 + 一个浅路径）。
          throw {
            issues: [
              { code: 'custom', path: ['draftTestCases', 0, 'steps', 0, 'expected'], message: 'expected must be a single assertion (found 2 semicolon-separated segments).' },
              { code: 'custom', path: ['draftTestCases', 0, 'testLevel'], message: 'invalid literal value, expected "component"' },
            ],
          };
        }
        return normalized;
      },
      formatValidationError: () => 'Schema validation failed',
    };

    await callLLMWithStructuredOutput(
      provider,
      [],
      [],
      profile as any,
      undefined,
      'test_designer',
    );

    // 一次校验失败 → 一次定点修复重试成功返回。
    expect(parseCount).toBe(2);
    const repairUser = calls[2].find((m) => m.role === 'user' && /Fix ONLY the fields/.test(m.content));
    expect(repairUser).toBeTruthy();
    expect(String(repairUser.content)).toContain('draftTestCases.0.steps.0.expected');
    expect(String(repairUser.content)).toContain('draftTestCases.0.testLevel');
    expect(String(repairUser.content)).not.toContain('matching the schema exactly');
    // 携带上一份 assistant 输出作为"最小改动"的锚点。
    expect(calls[2].some((m) => m.role === 'assistant')).toBe(true);
  });
});

describe('makeSchemaOpenAICompatible', () => {
  // Regression test: Azure strict response_format rejects schemas whose
  // `properties` contains a key not present in `required`. When a nested
  // object is `.optional()`, the outer wrapper gets `type: ["object", "null"]`
  // — and the recursion must STILL walk into the inner `properties` to add
  // every key to its own `required`. Earlier versions checked
  // `schema.type === 'object'` strictly, which failed after the wrap and
  // produced a schema that Azure rejected with
  // "Missing 'actionSummary'" (the actual symptom from tgr-... runs).
  it('walks into nested objects whose type was wrapped to ["object", "null"]', () => {
    const schema = z.object({
      coverageMatrix: z.object({
        rows: z.array(z.object({
          flowStepRef: z.object({
            flowId: z.string(),
            sequence: z.number(),
            actionSummary: z.string().optional(),
          }).optional(),
        })),
      }).optional(),
    });

    const fixed = makeSchemaOpenAICompatible(zodToJsonSchema(schema));

    // Navigate to the inner flowStepRef properties.
    const inner = (fixed as any).properties.coverageMatrix.properties.rows.items.properties.flowStepRef;
    expect(Array.isArray(inner.required)).toBe(true);
    // Every property in the inner object MUST be in its own `required`,
    // including the originally-optional `actionSummary`.
    expect(inner.required).toEqual(expect.arrayContaining(['flowId', 'sequence', 'actionSummary']));
    // The outer optional wrapper is now `["object", "null"]` and present
    // in the parent's required.
    expect(inner.type).toEqual(['object', 'null']);
    expect((fixed as any).required).toEqual(expect.arrayContaining(['coverageMatrix']));
  });

  it('emits every property key (including optional ones) into `required` at every level', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.object({
        c: z.string().optional(),
        d: z.number().optional(),
      }),
    });

    const fixed = makeSchemaOpenAICompatible(zodToJsonSchema(schema)) as any;
    expect(fixed.required.sort()).toEqual(['a', 'b']);
    expect(fixed.properties.b.required.sort()).toEqual(['c', 'd']);
  });
});
