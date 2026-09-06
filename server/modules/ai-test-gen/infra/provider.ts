import OpenAI, { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { Log } from '../../../shared/services/logger.ts';

export type ProviderConfig =
  | { type: 'azure-openai'; endpoint: string; apiKey: string; deployment: string; apiVersion: string; reasoningEffort?: 'low' | 'medium' | 'high'; reasoningSummary?: 'auto' | 'detailed' | 'concise'; textVerbosity?: 'low' | 'medium' | 'high' }
  | { type: 'openai-compatible'; endpoint?: string; apiKey: string; model: string; reasoningEffort?: 'low' | 'medium' | 'high' }
  | { type: 'openai-responses'; endpoint?: string; apiKey: string; model: string; reasoningEffort?: 'low' | 'medium' | 'high'; reasoningSummary?: 'auto' | 'detailed' | 'concise'; textVerbosity?: 'low' | 'medium' | 'high' };

export interface ToolCall {
  name: string;
  args: unknown;
  id: string;
  malformed?: {
    source: 'responses_output_item_done' | 'responses_stream_end';
    rawArgsLength: number;
    rawArgsPreview: string;
    parseError: string;
  };
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  not?: JsonSchema;
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  format?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ type: 'function'; function: { name: string; arguments: string }; id: string }>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  /** 节点级超时（毫秒），仅用于错误消息定位，provider 不消费。 */
  timeoutMs?: number;
  agentName?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'detailed' | 'concise';
  textVerbosity?: 'low' | 'medium' | 'high';
  tools?: Array<{
    name: string;
    description: string;
    strict?: boolean;
    parameters: JsonSchema;
  }>;
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

function formatToolsForApi(tools: ChatOptions['tools']): Array<{ type: 'function'; function: { name: string; description: string; strict: boolean; parameters: JsonSchema } }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      strict: t.strict ?? false,
      parameters: t.parameters,
    },
  }));
}

export interface StreamChunk {
  type: 'reasoning' | 'content' | 'done' | 'error' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: unknown;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; cachedPromptTokens?: number };
  /**
   * Native finish reason from the provider. Normalized to 'length' when output
   * was truncated (Chat Completions finish_reason='length'; Responses API
   * incomplete_details.reason='max_output_tokens'). Surfaced on the 'done' chunk
   * so callers can distinguish truncation failures from schema failures.
   */
  finishReason?: string;
}

export interface AIProvider {
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk>;
}

function sanitizeSchemaName(value: string | undefined): string {
  const cleaned = String(value || 'structured_output')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'structured_output';
}

function normalizeStructuredOutputSchema(
  jsonSchema: Record<string, unknown>,
  nameHint?: string,
): Record<string, unknown> {
  if (
    jsonSchema?.type === 'json_schema'
    && typeof jsonSchema.schema === 'object'
    && jsonSchema.schema
  ) {
    return {
      ...jsonSchema,
      name: jsonSchema.name || sanitizeSchemaName(nameHint),
      strict: jsonSchema.strict ?? true,
    };
  }

  return {
    name: sanitizeSchemaName(nameHint),
    schema: jsonSchema,
    strict: true,
  };
}

function buildMalformedToolCall(
  toolCall: { id: string; name: string },
  rawArgs: string,
  error: unknown,
  source: 'responses_output_item_done' | 'responses_stream_end',
): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    args: {},
    malformed: {
      source,
      rawArgsLength: rawArgs.length,
      rawArgsPreview: rawArgs.slice(0, 200),
      parseError: String(error),
    },
  };
}

export function mergeSignals(signal1?: AbortSignal, signal2?: AbortSignal): AbortSignal | undefined {
  if (!signal1 && !signal2) return undefined;
  if (!signal1) return signal2;
  if (!signal2) return signal1;
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    const reason = signal1.aborted ? signal1.reason : signal2.reason;
    controller.abort(reason);
  };
  signal1.addEventListener('abort', abort);
  signal2.addEventListener('abort', abort);
  if (signal1.aborted || signal2.aborted) abort();
  return controller.signal;
}

function describeErr(err: unknown): string {
  if (err instanceof APIError) {
    return `${err.name} status=${err.status} code=${err.code ?? 'n/a'} message="${err.message}"`;
  }
  if (err instanceof Error) return `${err.name}: "${err.message}"${err.cause ? ` cause=${String(err.cause)}` : ''}`;
  return String(err);
}

function formatSdkError(err: unknown, providerName: string, agentTag: string, extra?: string): Error {
  if (err instanceof APIError) {
    return new Error(`Provider ${providerName} error ${err.status}${agentTag}: ${err.message}${extra ? ` ${extra}` : ''}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** 短暂睡眠（指数退避等待）；unref 避免阻塞进程退出 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * 发起流式请求时对"超时类连接错误"（APIConnectionTimeoutError，即
 * "Request timed out."）做有限次指数退避重试（默认 2 次：2s、4s）。
 *
 * 为什么需要：OpenAI SDK 内置重试（maxRetries）会处理 429/408/409/5xx 与普通
 * 连接错误，但对 timeout 类默认不重试——实测 Azure Responses 会在长推理/无
 * 增量流上抛出 "Request timed out."，直接让整个 agent 失败。这里只在
 * **stream 首字节之前**失败时重试（调用 action 会重新发起请求）；一旦开始
 * 读取 chunk，中断不再重试，避免放大重复消费。
 */
async function createStreamWithRetry<T>(
  action: () => Promise<T>,
  opts: { signal?: AbortSignal; label: string; retries?: number },
): Promise<T> {
  const max = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      const isTimeout = err instanceof APIConnectionTimeoutError;
      const isConn = err instanceof APIConnectionError;
      // 429 限流需要比连接错误更长的等待（Mistral 等配额型接口常返回
      // "429 status code (no body)" 且无 Retry-After 头，SDK 短退避不够）
      const isRateLimited = err instanceof APIError && (err.status === 429 || err.status === 503);
      if (attempt === max || !(isTimeout || isConn || isRateLimited)) throw err;
      if (opts.signal?.aborted) throw err;
      // 429/503：5s → 10s → 20s；超时/连接：2s → 4s → 8s
      const base = isRateLimited ? 5_000 : 2_000;
      const delayMs = base * 2 ** attempt;
      Log.for('provider').warn(
        `[${opts.label}] stream create failed ${err instanceof Error ? `(${err.message})` : ''} — retry ${attempt + 1}/${max} in ${delayMs}ms`,
      );
      await delay(delayMs);
      if (opts.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

// ─── Token limit ladder ───
// Many OpenAI-compatible endpoints reject max_tokens above the model's context
// cap. Try 1M → 500k → 200k → 120k → 60k, downgrading on rejection.
const MAX_TOKEN_LADDER = [1_000_000, 500_000, 200_000, 120_000, 60_000];

function buildMaxTokenLadder(requested: number | undefined): number[] {
  if (requested == null) return MAX_TOKEN_LADDER;
  const filtered = MAX_TOKEN_LADDER.filter(t => t <= requested);
  return filtered.length > 0 ? filtered : [requested];
}

function isMaxTokenLimitError(err: unknown): boolean {
  const msg = err instanceof APIError ? err.message : (err instanceof Error ? err.message : String(err));
  return /max_tokens|max[ _-]?tokens|max[ _-]?output[ _-]?tokens|maximum[^]{0,20}token|token[^]{0,20}limit|too large|greater than|exceed|context[^]{0,15}length/i.test(msg);
}

export function createAIProvider(config: ProviderConfig): AIProvider {
  switch (config.type) {
    case 'azure-openai': return createAzureOpenAIProvider(config);
    case 'openai-compatible': return createOpenAICompatibleProvider(config);
    case 'openai-responses': return createOpenAIResponsesProvider(config);
  }
}

// ─── Provider Factories ───

function createAzureOpenAIProvider(config: ProviderConfig & { type: 'azure-openai' }): AIProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: `${config.endpoint.replace(/\/+$/, '')}/openai`,
    defaultQuery: { 'api-version': config.apiVersion },
    defaultHeaders: { 'api-key': config.apiKey },
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  function buildInput(messages: ChatMessage[]): unknown[] {
    const input: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const tc of m.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
          });
        }
      } else if (m.role === 'tool' && m.toolCallId) {
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content || ' ' });
      } else {
        input.push({ role: m.role, content: m.content || '' });
      }
    }
    return input;
  }

  function buildTextConfig(options?: ChatOptions): Record<string, unknown> | undefined {
    if (options?.jsonSchema) {
      return { format: { type: 'json_schema' as const, ...normalizeStructuredOutputSchema(options.jsonSchema, options?.agentName) } };
    }
    if (options?.responseFormat === 'json_object') {
      return { format: { type: 'json_object' } };
    }
    return undefined;
  }

  // Cache the max_tokens value resolved by the ladder on first successful
  // call — subsequent calls reuse it to avoid repeated probe-and-reject cycles.
  let cachedMaxTokens: number | undefined;

  async function* streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const input = buildInput(messages);
    const agentTag = options?.agentName ? ` agent=${options.agentName}` : '';
    const signal = mergeSignals(options?.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS));
    Log.for('provider').info(`[azure-sdk] POST${agentTag} input=${input.length} items`);

    // Phase 2 extraction (jsonSchema) lowers reasoning effort to avoid
    // exhausting max_output_tokens in the reasoning channel.
    const isExtraction = !!options?.jsonSchema;
    const reasoningEffort = isExtraction ? 'low' : (options?.reasoningEffort ?? config.reasoningEffort ?? 'medium');
    const reasoningSummary = options?.reasoningSummary ?? config.reasoningSummary ?? 'auto';
    const textVerbosity = options?.textVerbosity ?? config.textVerbosity ?? 'medium';

    const requestedMax = options?.maxTokens;
    const effectiveRequest = cachedMaxTokens !== undefined
      ? Math.min(requestedMax ?? cachedMaxTokens, cachedMaxTokens)
      : requestedMax;
    const tokenLadder = buildMaxTokenLadder(effectiveRequest);
    const initialMax = tokenLadder[0];
    let usedMax = initialMax;
    let stream: any;
    let lastErr: unknown;
    for (let i = 0; i < tokenLadder.length; i++) {
      const maxTok = tokenLadder[i];
      try {
        stream = await createStreamWithRetry(
          () => client.responses.create({
            model: config.deployment,
            input: input as any,
            max_output_tokens: maxTok,
            reasoning: { effort: reasoningEffort, summary: reasoningSummary },
            stream: true,
            text: { ...(buildTextConfig(options) ?? {}), verbosity: textVerbosity } as any,
            ...(() => {
              if (!options?.tools?.length) return {};
              return {
                tools: options.tools.map(t => ({
                  type: 'function' as const,
                  name: t.name,
                  description: t.description,
                  strict: t.strict ?? false,
                  parameters: t.parameters as any,
                })),
              };
            })(),
          }, { signal }),
          { signal, label: 'azure-sdk' },
        );
        usedMax = maxTok;
        cachedMaxTokens = usedMax;
        break;
      } catch (err) {
        lastErr = err;
        if (isMaxTokenLimitError(err) && i < tokenLadder.length - 1) {
          continue;
        }
        Log.for('provider').error(`[azure-sdk] stream request failed${agentTag}: model=${config.deployment} input=${input.length} items temperature=${options?.temperature ?? 0.3} max_tokens=${maxTok} tools=${options?.tools?.length ?? 0} — ${describeErr(err)}`);
        throw formatSdkError(err, 'azure', agentTag, `endpoint=${config.endpoint} model=${config.deployment}`);
      }
    }
    if (!stream) {
      throw formatSdkError(lastErr, 'azure', agentTag, `endpoint=${config.endpoint} model=${config.deployment}`);
    }
    if (usedMax !== initialMax) {
      Log.for('provider').warn(`[azure-sdk] max_output_tokens downgraded ${initialMax} → ${usedMax}${agentTag}`);
    }

    let currentToolCall: { id: string; name: string; args: string } | null = null;
    let finishReason: string | undefined;
    let usageData: any;
    const abortHandler = () => { if (stream.controller) stream.controller.abort(); };
    signal.addEventListener('abort', abortHandler);

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'content', content: event.delta };
            break;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            yield { type: 'reasoning', content: event.delta };
            break;
          case 'response.function_call_arguments.delta':
            if (currentToolCall) {
              currentToolCall.args += event.delta;
              yield { type: 'tool_call_delta', content: event.delta, toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
            break;
          case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
              if (currentToolCall) {
                try {
                  yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
                } catch { /* finalize on next event */ }
              }
              currentToolCall = { id: (event.item as any).call_id || event.item.id, name: (event.item as any).name, args: '' };
              yield { type: 'tool_call_start', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
            break;
          case 'response.output_item.done':
            if (event.item?.type === 'function_call' && currentToolCall) {
              const finalArgs = (event.item as any).arguments || currentToolCall.args;
              try {
                yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(finalArgs) } };
              } catch (e) {
                yield { type: 'tool_call_end', content: '', toolCall: buildMalformedToolCall(currentToolCall, finalArgs, e, 'responses_output_item_done') };
              }
              currentToolCall = null;
            }
            break;
          case 'response.completed':
            if (event.response?.usage) usageData = event.response.usage;
            if (event.response?.status === 'incomplete' && (event.response as any)?.incomplete_details?.reason === 'max_output_tokens') {
              finishReason = 'length';
            }
            break;
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }

    if (currentToolCall) {
      try {
        yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
      } catch (error) {
        yield { type: 'tool_call_end', content: '', toolCall: buildMalformedToolCall(currentToolCall, currentToolCall.args, error, 'responses_stream_end') };
      }
    }

    if (finishReason === 'length') {
      Log.for('provider').warn(`[azure-sdk] Responses API stream truncated by max_output_tokens. Output may be incomplete.`);
    }

    yield {
      type: 'done',
      content: '',
      finishReason,
      usage: usageData ? {
        promptTokens: usageData.input_tokens ?? 0,
        completionTokens: usageData.output_tokens ?? 0,
        reasoningTokens: usageData.output_tokens_details?.reasoning_tokens ?? 0,
        cachedPromptTokens: usageData?.input_tokens_details?.cached_tokens ?? 0,
      } : undefined,
    };
  }

  return { streamChat };
}

function createOpenAICompatibleProvider(config: ProviderConfig & { type: 'openai-compatible' }): AIProvider {
  const raw = (config.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
  const baseUrl = raw.endsWith('/v1') ? raw : `${raw}/v1`;

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  function serializeMessages(messages: ChatMessage[]): unknown[] {
    return messages.map(m => {
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content ?? null,
          tool_calls: m.toolCalls,
        };
      }
      if (m.role === 'tool' && m.toolCallId) {
        return {
          role: 'tool',
          content: m.content || '',
          tool_call_id: m.toolCallId,
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  function buildTools(options?: ChatOptions) {
    const t = formatToolsForApi(options?.tools);
    return t ? { tools: t as any, tool_choice: options?.toolChoice } : {};
  }

  function buildResponseFormat(options?: ChatOptions) {
    // Phase 2 extraction passes jsonSchema — use json_object to force JSON
    // output. We use json_object (not json_schema) because many OpenAI-compatible
    // APIs (e.g. agnes) silently return empty content when json_schema + strict
    // is used. json_object is universally supported and, combined with the
    // schema in the extraction prompt + Zod validation, provides sufficient
    // constraint. The openai-responses provider uses json_schema (it supports it).
    if (options?.jsonSchema) {
      return { type: 'json_object' as const };
    }
    if (options?.responseFormat === 'json_object') {
      return { type: 'json_object' as const };
    }
    return undefined;
  }

  // Cache the max_tokens value resolved by the ladder on first successful
  // call — subsequent calls reuse it to avoid repeated probe-and-reject cycles.
  let cachedMaxTokens: number | undefined;

  async function* streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const agentTag = options?.agentName ? ` agent=${options.agentName}` : '';
    const signal = mergeSignals(options?.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS));
    Log.for('provider').info(`[openai-compat-sdk] POST${agentTag} messages=${messages.length}`);

    // Phase 2 extraction (jsonSchema) does not need reasoning — reasoning models
    // can exhaust max_tokens in the reasoning_content channel and emit empty
    // content. Skip reasoning_effort entirely for extraction.
    const isExtraction = !!options?.jsonSchema;
    const reasoningEffort = isExtraction ? undefined : (options?.reasoningEffort ?? config.reasoningEffort);

    const requestedMax = options?.maxTokens;
    const effectiveRequest = cachedMaxTokens !== undefined
      ? Math.min(requestedMax ?? cachedMaxTokens, cachedMaxTokens)
      : requestedMax;
    const tokenLadder = buildMaxTokenLadder(effectiveRequest);
    const initialMax = tokenLadder[0];
    let usedMax = initialMax;
    let stream: any;
    let lastErr: unknown;
    for (let i = 0; i < tokenLadder.length; i++) {
      const maxTok = tokenLadder[i];
      try {
        stream = await createStreamWithRetry(
          () => client.chat.completions.create({
            ...({
              model: config.model!,
              messages: serializeMessages(messages),
              temperature: options?.temperature ?? 0.3,
              max_tokens: maxTok,
              stream_options: { include_usage: true },
              ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
              ...buildTools(options),
            } as any),
            stream: true,
            response_format: buildResponseFormat(options) as any,
          }, { signal }),
          { signal, label: 'openai-compat-sdk' },
        );
        usedMax = maxTok;
        cachedMaxTokens = usedMax;
        break;
      } catch (err) {
        lastErr = err;
        if (isMaxTokenLimitError(err) && i < tokenLadder.length - 1) {
          continue;
        }
        Log.for('provider').error(`[openai-compat-sdk] stream request failed${agentTag}: model=${config.model} endpoint=${config.endpoint || 'default'} messages=${messages.length} temperature=${options?.temperature ?? 0.3} max_tokens=${maxTok} tools=${options?.tools?.length ?? 0} — ${describeErr(err)}`);
        throw formatSdkError(err, 'openai-compat', agentTag, `endpoint=${config.endpoint || 'default'} model=${config.model}`);
      }
    }
    if (!stream) {
      throw formatSdkError(lastErr, 'openai-compat', agentTag, `endpoint=${config.endpoint || 'default'} model=${config.model}`);
    }
    if (usedMax !== initialMax) {
      Log.for('provider').warn(`[openai-compat-sdk] max_tokens downgraded ${initialMax} → ${usedMax}${agentTag}`);
    }

    let currentToolCall: { id: string; name: string; args: string } | null = null;
    let finishReason: string | undefined;
    let usageData: any;

    for await (const chunk of stream) {
      if (chunk.usage) usageData = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      const chunkFinishReason = chunk.choices?.[0]?.finish_reason;
      if (chunkFinishReason) finishReason = chunkFinishReason;

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            if (currentToolCall) {
              try {
                yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
              } catch { /* finalize on next event */ }
            }
            currentToolCall = { id: tc.id, name: tc.function?.name ?? '', args: '' };
            yield { type: 'tool_call_start', content: '', toolCall: { id: tc.id, name: tc.function?.name ?? '', args: {} } };
            if (tc.function?.arguments) {
              currentToolCall.args += tc.function.arguments;
              yield { type: 'tool_call_delta', content: tc.function.arguments, toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
          } else if (currentToolCall) {
            if (tc.function?.name) {
              currentToolCall.name = tc.function.name;
            }
            if (tc.function?.arguments !== undefined) {
              currentToolCall.args += tc.function.arguments;
              yield { type: 'tool_call_delta', content: tc.function.arguments, toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
          }
        }
      }

      const reasoningText = (delta as any)?.reasoning_content || (delta as any)?.reasoning;
      if (reasoningText) yield { type: 'reasoning', content: reasoningText };

      if (delta?.content) yield { type: 'content', content: delta.content };
    }

    if (currentToolCall) {
      try {
        yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
      } catch {
        yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
      }
    }

    if (finishReason === 'length') {
      Log.for('provider').warn(`[openai-compat-sdk] Chat Completions stream truncated (finish_reason='length').`);
    }

    yield {
      type: 'done',
      content: '',
      finishReason,
      usage: usageData ? {
        promptTokens: usageData.prompt_tokens ?? 0,
        completionTokens: usageData.completion_tokens ?? 0,
        reasoningTokens: (usageData as any)?.completion_tokens_details?.reasoning_tokens ?? 0,
        cachedPromptTokens: (usageData as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      } : undefined,
    };
  }

  return { streamChat };
}

function createOpenAIResponsesProvider(config: ProviderConfig & { type: 'openai-responses' }): AIProvider {
  const baseUrl = (config.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  function buildInput(messages: ChatMessage[]): unknown[] {
    const input: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const tc of m.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
          });
        }
      } else if (m.role === 'tool' && m.toolCallId) {
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content || ' ' });
      } else {
        input.push({ role: m.role, content: m.content || '' });
      }
    }
    return input;
  }

  function buildTextConfig(options?: ChatOptions): Record<string, unknown> | undefined {
    if (options?.jsonSchema) {
      return { format: { type: 'json_schema' as const, ...normalizeStructuredOutputSchema(options.jsonSchema, options?.agentName) } };
    }
    if (options?.responseFormat === 'json_object') {
      return { format: { type: 'json_object' } };
    }
    return undefined;
  }

  // Cache the max_tokens value resolved by the ladder on first successful
  // call — subsequent calls reuse it to avoid repeated probe-and-reject cycles.
  let cachedMaxTokens: number | undefined;

  async function* streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const input = buildInput(messages);
    const agentTag = options?.agentName ? ` agent=${options.agentName}` : '';
    const signal = mergeSignals(options?.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS));
    Log.for('provider').info(`[openai-responses] POST${agentTag} input=${input.length} items`);

    // Phase 2 extraction (jsonSchema) lowers reasoning effort to avoid
    // exhausting max_output_tokens in the reasoning channel.
    const isExtraction = !!options?.jsonSchema;
    const reasoningEffort = isExtraction ? 'low' : (options?.reasoningEffort ?? config.reasoningEffort ?? 'medium');
    const reasoningSummary = options?.reasoningSummary ?? config.reasoningSummary ?? 'auto';
    const textVerbosity = options?.textVerbosity ?? config.textVerbosity ?? 'medium';

    const requestedMax = options?.maxTokens;
    const effectiveRequest = cachedMaxTokens !== undefined
      ? Math.min(requestedMax ?? cachedMaxTokens, cachedMaxTokens)
      : requestedMax;
    const tokenLadder = buildMaxTokenLadder(effectiveRequest);
    const initialMax = tokenLadder[0];
    let usedMax = initialMax;
    let stream: any;
    let lastErr: unknown;
    for (let i = 0; i < tokenLadder.length; i++) {
      const maxTok = tokenLadder[i];
      try {
        stream = await createStreamWithRetry(
          () => client.responses.create({
            model: config.model,
            input: input as any,
            max_output_tokens: maxTok,
            reasoning: { effort: reasoningEffort, summary: reasoningSummary },
            stream: true,
            text: { ...(buildTextConfig(options) ?? {}), verbosity: textVerbosity } as any,
            ...(() => {
              if (!options?.tools?.length) return {};
              return {
                tools: options.tools.map(t => ({
                  type: 'function' as const,
                  name: t.name,
                  description: t.description,
                  strict: t.strict ?? false,
                  parameters: t.parameters as any,
                })),
              };
            })(),
          }, { signal }),
          { signal, label: 'openai-responses' },
        );
        usedMax = maxTok;
        cachedMaxTokens = usedMax;
        break;
      } catch (err) {
        lastErr = err;
        if (isMaxTokenLimitError(err) && i < tokenLadder.length - 1) {
          continue;
        }
        Log.for('provider').error(`[openai-responses] stream request failed${agentTag}: model=${config.model} input=${input.length} items temperature=${options?.temperature ?? 0.3} max_tokens=${maxTok} tools=${options?.tools?.length ?? 0} — ${describeErr(err)}`);
        throw formatSdkError(err, 'openai-responses', agentTag, `model=${config.model}`);
      }
    }
    if (!stream) {
      throw formatSdkError(lastErr, 'openai-responses', agentTag, `model=${config.model}`);
    }
    if (usedMax !== initialMax) {
      Log.for('provider').warn(`[openai-responses] max_output_tokens downgraded ${initialMax} → ${usedMax}${agentTag}`);
    }

    let currentToolCall: { id: string; name: string; args: string } | null = null;
    let finishReason: string | undefined;
    let usageData: any;
    const abortHandler = () => { if (stream.controller) stream.controller.abort(); };
    signal.addEventListener('abort', abortHandler);

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'content', content: event.delta };
            break;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            yield { type: 'reasoning', content: event.delta };
            break;
          case 'response.function_call_arguments.delta':
            if (currentToolCall) {
              currentToolCall.args += event.delta;
              yield { type: 'tool_call_delta', content: event.delta, toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
            break;
          case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
              if (currentToolCall) {
                try {
                  yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
                } catch { /* finalize on next event */ }
              }
              currentToolCall = { id: (event.item as any).call_id || event.item.id, name: (event.item as any).name, args: '' };
              yield { type: 'tool_call_start', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: {} } };
            }
            break;
          case 'response.output_item.done':
            if (event.item?.type === 'function_call' && currentToolCall) {
              const finalArgs = (event.item as any).arguments || currentToolCall.args;
              try {
                yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(finalArgs) } };
              } catch (e) {
                yield { type: 'tool_call_end', content: '', toolCall: buildMalformedToolCall(currentToolCall, finalArgs, e, 'responses_output_item_done') };
              }
              currentToolCall = null;
            }
            break;
          case 'response.completed':
            if (event.response?.usage) usageData = event.response.usage;
            if (event.response?.status === 'incomplete' && (event.response as any)?.incomplete_details?.reason === 'max_output_tokens') {
              finishReason = 'length';
            }
            break;
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }

    if (currentToolCall) {
      try {
        yield { type: 'tool_call_end', content: '', toolCall: { id: currentToolCall.id, name: currentToolCall.name, args: JSON.parse(currentToolCall.args) } };
      } catch (error) {
        yield { type: 'tool_call_end', content: '', toolCall: buildMalformedToolCall(currentToolCall, currentToolCall.args, error, 'responses_stream_end') };
      }
    }

    if (finishReason === 'length') {
      Log.for('provider').warn(`[openai-responses] Responses API stream truncated by max_output_tokens. Output may be incomplete.`);
    }

    yield {
      type: 'done',
      content: '',
      finishReason,
      usage: usageData ? {
        promptTokens: usageData.input_tokens ?? 0,
        completionTokens: usageData.output_tokens ?? 0,
        reasoningTokens: usageData.output_tokens_details?.reasoning_tokens ?? 0,
        cachedPromptTokens: usageData?.input_tokens_details?.cached_tokens ?? 0,
      } : undefined,
    };
  }

  return { streamChat };
}

const FETCH_TIMEOUT_MS = 1_800_000;


