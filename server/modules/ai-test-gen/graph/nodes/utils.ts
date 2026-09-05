import { toJSONSchema, type ZodType } from 'zod';
import type { AIProvider, ChatMessage, ChatOptions, ToolCall } from '../../infra/provider.ts';
import type { SkillDefinition, ToolCallRecord } from './types.ts';
import type { StructuredOutputProfile } from '../structured-output/profile.ts';
import { Log } from '../../../../shared/services/logger.ts';
import { jsonrepair } from 'jsonrepair';

/**
 * Recursively traverse the JSON Schema to ensure all object types have strict constraints:
 * - additionalProperties: false
 * - Ensure each nested object has a required array (natively guaranteed by zodToJsonSchema)
 */
function ensureStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  // Azure Structured Outputs strict mode rejects these JSON Schema keywords
  // (they appear in z.record() output). Strip them so the schema is accepted.
  delete schema.propertyNames;
  delete schema.patternProperties;
  // Same Azure-compatible detection as makeSchemaOpenAICompatible below.
  const isObjectSchema =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && (schema.type as unknown[]).includes('object'));
  if (isObjectSchema && typeof schema.properties === 'object' && schema.properties) {
    schema.additionalProperties = false;
    for (const key of Object.keys(schema.properties as Record<string, unknown>)) {
      const val = (schema.properties as Record<string, unknown>)[key];
      if (val && typeof val === 'object') {
        (schema.properties as Record<string, unknown>)[key] = ensureStrictJsonSchema(val as Record<string, unknown>);
      }
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    schema.items = ensureStrictJsonSchema(schema.items as Record<string, unknown>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schema.additionalProperties = ensureStrictJsonSchema(schema.additionalProperties as Record<string, unknown>);
  }
  return schema;
}

/**
 * Convert a Zod schema to a JSON Schema (for tool parameters),
 * automatically injecting strict constraints (additionalProperties: false).
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  return ensureStrictJsonSchema(toJSONSchema(schema) as Record<string, unknown>);
}

/**
 * Make a JSON Schema compatible with OpenAI Structured Outputs / strict mode:
 * 1. Add all properties' keys to the required array
 * 2. For fields newly added to required (originally optional), wrap type as {type: [originalType, "null"]}
 *
 * OpenAI strict mode requires: required must include every key of properties.
 */
export function makeSchemaOpenAICompatible(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;

  // Azure strict mode: a schema with `type: ["object", "null"]` is still an
  // object schema at heart — we need to recurse into its `properties` even
  // when type has been wrapped to allow null. Detect "object-ness" with
  // either the string form or an array form that includes "object".
  const isObjectSchema =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && (schema.type as unknown[]).includes('object'));

  if (isObjectSchema && typeof schema.properties === 'object' && schema.properties) {
    const propKeys = Object.keys(schema.properties as Record<string, unknown>);
    const requiredSet = new Set<string>(
      Array.isArray(schema.required) ? (schema.required as string[]) : []
    );

    for (const key of propKeys) {
      if (!requiredSet.has(key)) {
        // This property was optional in Zod — add null acceptance
        const prop = (schema.properties as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
        if (prop && typeof prop === 'object') {
          // Handle z.any() / type-less properties (e.g. changeLog[].from)
          if (!prop.type && !prop.anyOf && !prop.oneOf && !prop.$ref) {
            prop.type = ['string', 'null'];
          } else if (typeof prop.type === 'string') {
            prop.type = [prop.type, 'null'];
          } else if (Array.isArray(prop.type) && !prop.type.includes('null')) {
            prop.type.push('null');
          }
          // anyOf/oneOf: each branch needs null too
          for (const combinator of ['anyOf', 'oneOf'] as const) {
            if (Array.isArray(prop[combinator])) {
              (prop[combinator] as Record<string, unknown>[]).push({ type: 'null' });
            }
          }
        }
        requiredSet.add(key);
      }
    }

    schema.required = Array.from(requiredSet);

    // Recurse into properties
    for (const key of propKeys) {
      const val = (schema.properties as Record<string, unknown>)[key];
      if (val && typeof val === 'object') {
        (schema.properties as Record<string, unknown>)[key] = makeSchemaOpenAICompatible(val as Record<string, unknown>);
      }
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    schema.items = makeSchemaOpenAICompatible(schema.items as Record<string, unknown>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schema.additionalProperties = makeSchemaOpenAICompatible(schema.additionalProperties as Record<string, unknown>);
  }

  return schema;
}

/**
 * Convert SkillDefinition[] to ChatOptions.tools format
 */
export function skillsToChatTools(skills: SkillDefinition[]): ChatOptions['tools'] {
  if (!skills || skills.length === 0) return undefined;
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: zodToJsonSchema(s.schema) as any,
  }));
}

/**
 * Strip fields the builder always overrides (temperature/responseFormat/tools/
 * toolChoice) from `extra`, so per-call overrides never resurrect a value the
 * Phase 1 / Phase 2 options explicitly control.
 */
function stripOptionOverrides(extra?: Partial<ChatOptions>): Partial<ChatOptions> {
  const { temperature: _temperature, responseFormat: _responseFormat, tools: _tools, toolChoice: _toolChoice, ...rest } = extra ?? {};
  return rest;
}

/**
 * Build ChatOptions: Phase 1 thinking + ReAct stage
 * Only expose business tools; final structured output is generated by the subsequent extraction stage.
 */
export function buildThinkingChatOptions(
  skills: SkillDefinition[],
  extra?: Partial<ChatOptions>,
): ChatOptions {
  const allowedExtra = stripOptionOverrides(extra);
  
  // Build tool list: only business skills. Final JSON is generated by the subsequent extraction stage to avoid the thinking stage depending on the model proactively submitting a structured payload.
  const businessTools = skillsToChatTools(skills);
  
  return {
    temperature: 0.5,
    tools: businessTools,
    toolChoice: businessTools && businessTools.length > 0 ? 'auto' : undefined,
    ...allowedExtra,
  };
}

/**
 * Build ChatOptions: Phase 2 extraction stage, using json_schema response_format
 */
export function buildExtractionChatOptions(
  outputProfile: StructuredOutputProfile<unknown>,
  extra?: Partial<ChatOptions>,
): ChatOptions {
  const allowedExtra = stripOptionOverrides(extra);
  return {
    jsonSchema: outputProfile.toolSchema,
    temperature: 0,
    ...allowedExtra,
  };
}

/**
 * Build the Phase 2 extraction prompt, including schema constraints
 */
export function buildExtractionPrompt(outputProfile: StructuredOutputProfile<unknown>): string {
  const schema = outputProfile.toolSchema;
  const hints = outputProfile.extractionHints;
  const hintsSection = hints ? `\n\nAdditional constraints (JSON Schema cannot express these — follow strictly):\n${hints}` : '';
  return `Based on the analysis above, output a single JSON object matching this schema. Do NOT include any text before or after the JSON.

Schema:
${JSON.stringify(schema, null, 2)}${hintsSection}`;
}

/**
 * Extract a JSON object from text. By priority:
 *   1. The entire content is JSON
 *   2. Extract the last complete JSON object from mixed text
 */
/**
 * Use jsonrepair to fix common LLM JSON syntax errors:
 * - missing/extra quotes, single quotes instead of double
 * - missing/trailing commas
 * - unclosed braces/brackets (truncated output)
 * - comments (// and block comments)
 * - Python/JS literals (None, True, False -> null, true, false)
 * - concatenated JSON fragments
 * Returns null if repair is not possible.
 */
function tryRepairJson(text: string): string | null {
  try { return jsonrepair(text); } catch { return null; }
}

function tryExtractJson(content: string): unknown | null {
  // 1. Try extracting from ```json fences first (most reliable)
  const fencePattern = /```(?:json)\s*\n([\s\S]*?)```/g;
  const fenceBlocks: string[] = [];
  let fenceMatch;
  while ((fenceMatch = fencePattern.exec(content)) !== null) {
    fenceBlocks.push(fenceMatch[1].trim());
  }
  for (let i = fenceBlocks.length - 1; i >= 0; i--) {
    const raw = fenceBlocks[i];
    try { return JSON.parse(raw); } catch { /* try repair */ }
    const repaired = tryRepairJson(raw);
    if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
  }

  // 2. Strip fences and try parsing whole content
  const stripped = content.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '');
  const candidates = [stripped.trim(), content.trim()];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try repair */ }
    const repaired = tryRepairJson(c);
    if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
  }

  // 2.5. Handle truncated JSON (missing closing fence/braces — LLM hit max
  // output tokens). Extract from the first '{' to end of stripped content and
  // try jsonrepair, which auto-closes missing brackets/braces.
  const firstBrace = stripped.indexOf('{');
  if (firstBrace !== -1) {
    const repaired = tryRepairJson(stripped.slice(firstBrace));
    if (repaired !== null) try { return JSON.parse(repaired); } catch { /* continue */ }
  }

  // 3. Fall back to brace matching
  const jsonBlocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const openIdx = content.indexOf('{', searchFrom);
    if (openIdx === -1) break;
    let depth = 0, inStr = false, escape = false;
    for (let i = openIdx; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) { jsonBlocks.push(content.slice(openIdx, i + 1)); searchFrom = i + 1; break; } }
    }
    if (depth !== 0) {
      // Truncated JSON (unbalanced braces) — try jsonrepair on the tail
      const repaired = tryRepairJson(content.slice(openIdx));
      if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
      searchFrom = openIdx + 1;
    }
  }

  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    const raw = jsonBlocks[i];
    try { return JSON.parse(raw); } catch { /* try repair */ }
    const repaired = tryRepairJson(raw);
    if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
  }

  return null;
}

// ============================================================
// ReAct Loop
// ============================================================

const MAX_REACT_ROUNDS = 30;

// E3: Truncate large tool results to avoid context bloat
const MAX_TOOL_RESULT_CHARS = 6000;
function truncateToolResult(content: string): string {
  if (!content || typeof content !== 'string') return '';
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, ${content.length} chars total)`;
}

// ============================================================
// ReAct 上下文窗口压缩（避免 O(n²) token 膨胀）
// ============================================================

/**
 * 保留最近几轮完整消息的轮次数。更早轮次的工具结果被摘要化，
 * 防止 92 次工具调用 × 15 轮时每轮重发全部历史（实测 Designer 单 run
 * input 达 260k tokens，主因即此处）。
 */
const REACT_KEEP_RECENT_ROUNDS = 3;

/** 更早轮次工具结果保留的前缀字符数（摘要足够 LLM 回顾，无需完整重发） */
const OLD_TOOL_RESULT_PREVIEW = 200;

/**
 * 识别一条消息是否开启新的一轮（assistant 消息且携带 tool_calls）。
 * 轮次结构：base(system+user) + [assistant(toolCalls) + tool*] + [assistant + tool*] + ...
 */
function isRoundStart(m: ChatMessage): boolean {
  return m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
}

/**
 * 将全量 ReAct 对话压缩为有界上下文：
 * - base（system + user）原样保留
 * - 最近 REACT_KEEP_RECENT_ROUNDS 轮完整保留（LLM 需要最近声明/结果续写）
 * - 更早轮次：保留 assistant 推理消息（其携带综合结论），但把 tool 结果内容
 *   摘要化（前 OLD_TOOL_RESULT_PREVIEW 字符 + 长度标注）
 *
 * 关键约束：assistant(tool_calls) → tool 消息的配对必须保留，否则 OpenAI 兼容
 * API 会因 tool_call_id 不匹配而拒绝。因此只缩短 tool 消息的 content，不删除
 * assistant 消息，配对关系保持完整。
 *
 * @param allMessages  全量消息（含 base）
 * @param baseCount    base 消息条数（system + user，即 messages.length）
 */
export function compactReActConversation(allMessages: ChatMessage[], baseCount: number): ChatMessage[] {
  if (allMessages.length <= baseCount) return allMessages;

  // 先收集更早轮次的 (assistantIdx, toolIdx) 以便摘要化，同时保留最近几轮完整
  const base = allMessages.slice(0, baseCount);
  const history = allMessages.slice(baseCount);

  // 按轮分组：每轮 = 1 条 assistant(toolCalls) + 其后 N 条 tool（直到下一条 assistant）
  const rounds: Array<{ toolIdx: number[] }> = [];
  let currentRound = -1;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (isRoundStart(m)) {
      rounds.push({ toolIdx: [] });
      currentRound = rounds.length - 1;
    } else if (m.role === 'tool' && currentRound >= 0) {
      rounds[currentRound].toolIdx.push(i);
    }
  }

  if (rounds.length <= REACT_KEEP_RECENT_ROUNDS) return allMessages;

  const keepFrom = rounds.length - REACT_KEEP_RECENT_ROUNDS;
  const oldRoundToolIdx = new Set<number>();
  for (let r = 0; r < keepFrom; r++) {
    for (const t of rounds[r].toolIdx) oldRoundToolIdx.add(t);
  }

  const compacted: ChatMessage[] = [...base];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (oldRoundToolIdx.has(i) && typeof m.content === 'string') {
      // 摘要化旧工具结果：保留短前缀 + 总长度，提示 LLM 已在更早上下文见过
      const full = m.content;
      const preview = full.length <= OLD_TOOL_RESULT_PREVIEW
        ? full
        : full.slice(0, OLD_TOOL_RESULT_PREVIEW) + `…(total ${full.length} chars — see earlier context)`;
      compacted.push({ ...m, content: `[earlier tool result] ${preview}` });
    } else {
      compacted.push(m);
    }
  }
  return compacted;
}

export class ToolStateProjectionError extends Error {
  constructor() {
    super('Tool state projection failed');
    this.name = 'ToolStateProjectionError';
  }
}

function serializeToolResult(result: unknown): { content: string; stateOutput: unknown } {
  if (typeof result === 'string') return { content: result, stateOutput: result };
  try {
    const content = JSON.stringify(result, null, 2);
    return typeof content === 'string'
      ? { content, stateOutput: JSON.parse(content) }
      : { content: 'null', stateOutput: null };
  } catch {
    return { content: 'null', stateOutput: null };
  }
}

function projectToolCallForState(
  skill: SkillDefinition,
  input: unknown,
  result: unknown,
  stateOutput: unknown,
  meta: { latencyMs: number; resultSize: number },
): { input: unknown; output: unknown } {
  if (!skill.summarizeForState) return { input, output: stateOutput };

  let projection: unknown;
  try {
    projection = skill.summarizeForState(input, result, meta);
  } catch {
    throw new ToolStateProjectionError();
  }
  let normalizedProjection: unknown;
  try {
    const serialized = JSON.stringify(projection);
    if (serialized === undefined) throw new ToolStateProjectionError();
    normalizedProjection = JSON.parse(serialized);
  } catch {
    throw new ToolStateProjectionError();
  }
  if (!normalizedProjection
    || typeof normalizedProjection !== 'object'
    || Array.isArray(normalizedProjection)
    || !Object.hasOwn(normalizedProjection, 'input')
    || !Object.hasOwn(normalizedProjection, 'output')) {
    throw new ToolStateProjectionError();
  }
  return normalizedProjection as { input: unknown; output: unknown };
}

function extractedValueSummary(value: unknown): { type: string; keys: string[]; draftTestCases: string } {
  const keys = value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
  const draftTestCases = (value as any)?.draftTestCases ? typeof (value as any).draftTestCases : 'missing';
  return { type: typeof value, keys, draftTestCases };
}

/**
 * Consume an extraction-stage stream (Phase 1.5 nudge / Phase 2 retry loop),
 * accumulating content and token usage.
 */
async function consumeExtractionStream(
  provider: AIProvider,
  messages: ChatMessage[],
  options: ChatOptions,
  observer: { onThinking?: (name: string, text: string, type: 'reasoning' | 'content', phase: 'react' | 'extraction') => void },
  name: string,
  usage: { input: number; output: number; reasoning: number; cached: number },
): Promise<string> {
  let content = '';
  for await (const chunk of provider.streamChat(messages, options)) {
    if (chunk.type === 'content' && chunk.content) {
      content += chunk.content;
      observer?.onThinking?.(name, chunk.content, 'content', 'extraction');
    }
    if (chunk.type === 'done' && chunk.usage) {
      usage.input += (chunk.usage.promptTokens || 0);
      usage.output += (chunk.usage.completionTokens || 0);
      usage.reasoning += (chunk.usage.reasoningTokens || 0);
      usage.cached += (chunk.usage.cachedPromptTokens || 0);
    }
  }
  return content;
}

// ============================================================
// Phase 1-declare-extract: Tool Use 强制结构化输出
// ============================================================

/**
 * 从 ReAct 工具调用记录中提取 declare_case / declare_step 调用并拼装成
 * { draftTestCases: [...] } 结构，供 DesignerRuntimeSchema.parse 验证。
 *
 * - declare_case 提供 case 元数据（id/title/conditionId/...）
 * - declare_step 提供每步（caseId/stepNumber/verb/targetHint/data/expectation）
 * - 多个 declare_step 按 caseId 分组，按 stepNumber 升序
 * - 同一 caseId 的多次 declare_case 取最后一次（覆盖）—— 避免 LLM 重复注册
 * - 同一 (caseId, stepNumber) 的多次 declare_step 取最后一次 —— 避免 LLM 重试
 * - action 从 {verb, targetHint, data} 拼装为 `${verb} ${targetHint}` 或带 data 后缀
 * - intent 从 {targetHint, data, expectation} 构造
 * - selfReview 默认填 {score:7, ...}（避免 LLM 必填 selfReview 拖慢流程）
 *
 * 返回 null 表示 LLM 没调过 declare_* 工具，或 contentText 中含有更完整的
 * JSON draft（LLM 中途弃用工具转 JSON）——此时调用方应走 Phase 1.5/2 JSON 提取。
 */
export function tryExtractFromDeclareTools(
  toolCallRecords: ToolCallRecord[],
  contentText: string,
  agentName: string,
): Record<string, unknown> | null {
  const declareCases = toolCallRecords.filter((r) => r.name === 'declare_case');
  const declareSteps = toolCallRecords.filter((r) => r.name === 'declare_step');
  if (declareCases.length === 0 && declareSteps.length === 0) return null;
  // 必须有 declare_step（不然没有 case content）；declare_case 至少要有一个（建立 case 框架）
  if (declareSteps.length === 0) return null;

  const extractLog = Log.for(`llm:${agentName}:declare-extract`);

  // 关键：LLM 常在声明少数 case 后弃用工具、改用 thinking 文本 JSON 输出其余 case
  //（实测声明 1 case + 12 个 JSON case）。若 contentText 中有更完整的 draftTestCases，
  // 工具路径构建的 draft 必然因"覆盖不全"被 validateConditionCoverage 拒绝——
  // 与其浪费一次注定失败的 parse，直接弃用工具路径，信 contentText 的完整 JSON。
  const thinkingJson = extractDraftJsonFromText(contentText);
  if (thinkingJson) {
    const jsonCaseCount = Array.isArray(thinkingJson) ? thinkingJson.length : (Array.isArray((thinkingJson as any)?.draftTestCases) ? (thinkingJson as any).draftTestCases.length : 0);
    const declaredCaseCount = declareSteps.length > 0
      ? new Set(declareSteps.map((s) => String((s.input as any)?.caseId ?? ''))).size
      : 0;
    if (jsonCaseCount > declaredCaseCount) {
      extractLog.info(`declared ${declaredCaseCount} case(s) via tools but thinking text has ${jsonCaseCount} — LLM switched to JSON; deferring to JSON extraction`);
      return null;
    }
  }

  extractLog.info(`declare_case=${declareCases.length}, declare_step=${declareSteps.length}`);

  // Build case metadata map (last-write-wins for duplicates)
  const caseMeta = new Map<string, Record<string, unknown>>();
  for (const rec of declareCases) {
    if (!rec.input || typeof rec.input !== 'object') continue;
    const id = String((rec.input as any).id ?? '').trim();
    if (!id) continue;
    caseMeta.set(id, rec.input as Record<string, unknown>);
  }

  // Group steps by caseId (last-write-wins for duplicate stepNumbers).
  // declare_step 支持两种形态，此处统一扁平化：
  //   1. 批量：input.steps = [{stepNumber?, verb, targetHint, data?, expectation?, expected?}, ...]
  //      缺省 stepNumber 时按数组顺序自动编号 1,2,3…（推荐，一次声明整个 case）。
  //   2. 单步（向后兼容）：input 直接含 verb/targetHint(+stepNumber)。
  const stepsByCase = new Map<string, Map<number, Record<string, unknown>>>();
  for (const rec of declareSteps) {
    if (!rec.input || typeof rec.input !== 'object') continue;
    const input = rec.input as Record<string, unknown>;
    const caseId = String(input.caseId ?? '').trim();
    if (!caseId) continue;

    const batch = Array.isArray(input.steps) ? input.steps : [];
    if (batch.length > 0) {
      if (!stepsByCase.has(caseId)) stepsByCase.set(caseId, new Map());
      batch.forEach((rawStep, idx) => {
        if (!rawStep || typeof rawStep !== 'object') return;
        const step = rawStep as Record<string, unknown>;
        const autoNumber = (Number(step.stepNumber) || 0) > 0
          ? Number(step.stepNumber)
          : idx + 1;
        stepsByCase.get(caseId)!.set(autoNumber, { ...step, stepNumber: autoNumber, caseId });
      });
    } else if (input.verb != null || input.targetHint != null) {
      const stepNumber = Number(input.stepNumber);
      if (Number.isFinite(stepNumber) && stepNumber > 0) {
        if (!stepsByCase.has(caseId)) stepsByCase.set(caseId, new Map());
        stepsByCase.get(caseId)!.set(stepNumber, input);
      }
    }
  }

  // If the LLM declared steps but no case metadata, fall back to a single anonymous case
  const draftTestCases: Record<string, unknown>[] = [];
  for (const [caseId, stepMap] of stepsByCase) {
    const meta = caseMeta.get(caseId) ?? {
      id: caseId,
      title: `Test case ${caseId}`,
      conditionId: '',
      requirementId: '',
      priority: 'medium',
      category: 'functional',
      testLevel: 'component',
      techniqueApplied: 'Equivalence Partitioning',
    };
    const sortedSteps = [...stepMap.values()].sort((a, b) => Number(a.stepNumber) - Number(b.stepNumber));
    const expectedExpected = (meta.coveredConditions as string[] | undefined) ?? [];
    const constructed = constructDraftTestCase(meta, sortedSteps, expectedExpected);
    draftTestCases.push(constructed);
  }

  if (draftTestCases.length === 0) return null;
  extractLog.info(`built ${draftTestCases.length} draft test case(s) from declare_* tools`);
  return { draftTestCases };
}

/**
 * 从 ReAct 的 thinking 文本（contentText）中提取 draftTestCases 数组（如有）。
 *
 * 收紧判定（修复实测："declared 13 via tools but thinking text has 51" → 误弃工具路径）：
 * 仅当文本中 JSON 是**结构合法的 draftTestCases 包装**（`{ draftTestCases: [...] }`
 * 且每个元素带 `steps` 数组）才返回该数组。LLM 在 thinking 里常写规划数组/数字键对象
 * （如 `{0:…, 1:…, 50:…}`）——它们看起来"数量更多"，但并非可落盘用例；据此弃用
 * 已声明的工具路径只会白烧一轮 + 触发 Phase 1/2 重发。
 * 返回 null 表示无合法 draftTestCases JSON——调用方保留工具路径。
 */
function extractDraftJsonFromText(contentText: string): unknown[] | null {
  if (!contentText || typeof contentText !== 'string') return null;
  const parsed = tryExtractJson(contentText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const list = (parsed as any).draftTestCases;
  if (!Array.isArray(list) || list.length === 0) return null;
  // 每个元素必须像真实用例：对象且带 steps 数组（规划占位/摘要对象不算）
  const looksReal = list.every((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
    && Array.isArray((item as any).steps)
    && (typeof (item as any).id === 'string' || typeof (item as any).conditionId === 'string')
  );
  return looksReal ? list : null;
}

function constructDraftTestCase(
  meta: Record<string, unknown>,
  stepInputs: Record<string, unknown>[],
  expectedCovered: string[],
): Record<string, unknown> {
  const steps = stepInputs.map((s) => constructStep(s));
  const conditionId = String(meta.conditionId ?? '').trim();
  const covered = expectedCovered.length > 0
    ? expectedCovered
    : (conditionId ? [conditionId] : []);
  return {
    id: meta.id,
    title: meta.title,
    conditionId: meta.conditionId,
    requirementId: meta.requirementId,
    priority: meta.priority ?? 'medium',
    category: meta.category ?? 'functional',
    testLevel: meta.testLevel ?? 'component',
    techniqueApplied: meta.techniqueApplied ?? 'Equivalence Partitioning',
    coveredConditions: covered,
    referencedComponentConditions: Array.isArray(meta.referencedComponentConditions) ? meta.referencedComponentConditions : [],
    preconditions: Array.isArray(meta.preconditions) ? meta.preconditions : [],
    testData: Array.isArray(meta.testData) ? meta.testData : [],
    postconditions: Array.isArray(meta.postconditions) ? meta.postconditions : [],
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    steps,
    // selfReview: LLM doesn't declare it via tool; default prevents schema rejection on truncation
    selfReview: { score: 7, strengths: [], weaknesses: [], suggestions: [] },
  };
}

function constructStep(input: Record<string, unknown>): Record<string, unknown> {
  const verb = String(input.verb ?? '').trim();
  const targetHint = String(input.targetHint ?? '').trim();
  const data = typeof input.data === 'string' ? input.data : undefined;
  const expectation = input.expectation && typeof input.expectation === 'object'
    ? input.expectation as Record<string, unknown>
    : undefined;
  const expectedFromTool = typeof input.expected === 'string' ? input.expected : '';

  // Reconstruct the action sentence: `${verb} ${targetHint}` (with data appended if present)
  // For `clear` and `verify` the data/targetHint is enough; the verb + targetHint reads naturally.
  const actionParts = [verb, targetHint].filter(Boolean);
  let action = actionParts.join(' ');
  if (data != null && data !== '') {
    const full = `${action} with '${data}'`;
    // DesignerRuntimeSchema 的 action superRefine 要求 ≤200 chars。超长 fill 值
    // （如 BVA 的 too-long 边界测试，用户名 200+ 字符）直接拼接会拒整批。
    // 截断 action 中 data 的展示，保留完整值在 intent.data（机器契约）——
    // Recorder 从 intent.data 解析实际值，action 仅是人工可读。
    if (full.length <= 200) {
      action = full;
    } else {
      const suffix = `'…' (value ${data.length} chars)`;
      const maxData = 200 - action.length - 10; // 留足 " with '...' (value N chars)" 的空间
      const keep = Math.max(4, Math.min(data.length, maxData));
      action = `${action} with '${data.slice(0, keep)}${suffix}`;
      // 保险：若仍超长（极端 targetHint 很长），再砍到硬上限
      if (action.length > 200) action = action.slice(0, 197) + '...';
    }
  }

  // Reconstruct intent
  const intent: Record<string, unknown> = {};
  if (targetHint) intent.targetHint = targetHint;
  // intent.data 始终保留完整值（即使 action 因超长被截断展示）——Recorder 依赖它。
  if (data != null && data !== '') intent.data = data;
  if (expectation) intent.expectation = expectation;

  // expected: prefer what the LLM wrote; fall back to a derived phrasing from
  // the expectation kind+value; fall back to "" (Quality layer typically fills).
  let expected = expectedFromTool;
  if (!expected && expectation) {
    const kind = String(expectation.kind ?? '');
    const value = String(expectation.value ?? '');
    const valuePhrase = value ? `'${value}'` : '';
    const urlPattern = String(expectation.urlPattern ?? '');
    if (kind === 'url') expected = `The URL ${value ? 'contains ' + valuePhrase : 'is the expected page'}.`;
    else if (kind === 'text-visible') expected = `The element displays ${valuePhrase}.`;
    else if (kind === 'element-visible') expected = `The element is visible.`;
    else if (kind === 'element-hidden') expected = `The element is hidden.`;
    else if (kind === 'value') expected = `The input value is ${valuePhrase}.`;
    else if (kind === 'element-state') expected = `The element is ${value}.`;
    else if (kind === 'network') expected = `The request ${urlPattern ? 'to ' + urlPattern : ''} returns ${value || 'success'}.`;
    else expected = `The expected state is reached.`;
  }

  return {
    stepNumber: Number(input.stepNumber),
    action,
    expected,
    intent: Object.keys(intent).length > 0 ? intent : undefined,
  };
}

interface ReActResult {
  contentText: string;
  thinkingText: string;
  toolCallRecords: ToolCallRecord[];
  usage: { input: number; output: number; reasoning: number; cached: number };
  conversationMessages: ChatMessage[];
}

/**
 * Execute the ReAct loop: LLM thinks → call tool → observe result → continue thinking
 * At most MAX_REACT_ROUNDS rounds; exit when there are no tool_calls
 */
async function runAgentReActLoop(
  provider: AIProvider,
  messages: ChatMessage[],
  skills: SkillDefinition[],
  outputProfile: StructuredOutputProfile<unknown>,
  observer: {
    onStep?: (name: string, idx: number, step: string) => void;
    onThinking?: (name: string, text: string, type: 'reasoning' | 'content', phase: 'react' | 'extraction') => void;
    onToolCall?: (name: string, toolCall: ToolCallRecord) => void;
  },
  agentName: string,
  extra: Partial<ChatOptions> | undefined,
): Promise<ReActResult> {
  const skillMap = new Map(skills.map((s) => [s.name, s]));
  const log = Log.for(`react:${agentName}`);
  log.info(`ReAct loop start ── ${skills.length} skills: ${skills.map(s => s.name).join(', ')}`);
  const allMessages: ChatMessage[] = [...messages];
  let contentText = '';
  let thinkingText = '';
  const toolCallRecords: ReActResult['toolCallRecords'] = [];
  let capturedUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cached: 0,
  };
  let totalRounds = 0;

  observer?.onStep?.(agentName, 0, 'Phase 1: Analysis started');

  for (let round = 0; round < MAX_REACT_ROUNDS; round++) {
    totalRounds = round + 1;
    // Stream call to LLM (with tools)
    let roundContent = '';
    let roundThinking = '';
    const pendingToolCalls: ToolCall[] = [];

    // 上下文窗口压缩：只发送 base + 最近几轮完整消息，更早轮次的工具结果摘要化，
    // 防止每轮重发全部历史导致 O(n²) token 膨胀（实测 Designer 单 run input 260k tokens）。
    const sendMessages = compactReActConversation(allMessages, messages.length);

    for await (const chunk of provider.streamChat(sendMessages, buildThinkingChatOptions(skills, extra))) {
      if (chunk.type === 'reasoning' && chunk.content) {
        roundThinking += chunk.content;
        observer?.onThinking?.(agentName, chunk.content, 'reasoning', 'react');
      }
      if (chunk.type === 'content' && chunk.content) {
        roundContent += chunk.content;
        observer?.onThinking?.(agentName, chunk.content, 'content', 'react');
      }
      if (chunk.type === 'tool_call_start' && chunk.toolCall) {
        pendingToolCalls.push(chunk.toolCall);
      }
      if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
        const existing = pendingToolCalls.find((tc) => tc.id === chunk.toolCall!.id);
        if (existing) {
          existing.args = chunk.toolCall.args; // The last delta contains the complete args
        } else {
          pendingToolCalls.push(chunk.toolCall);
        }
      }
      if (chunk.type === 'tool_call_end' && chunk.toolCall) {
        const existing = pendingToolCalls.find((tc) => tc.id === chunk.toolCall!.id);
        if (existing) {
          existing.args = chunk.toolCall.args;
          existing.malformed = chunk.toolCall.malformed;
        }
      }
      if (chunk.type === 'done' && chunk.usage) {
        capturedUsage = {
          input: capturedUsage.input + (chunk.usage.promptTokens || 0),
          output: capturedUsage.output + (chunk.usage.completionTokens || 0),
          reasoning: capturedUsage.reasoning + (chunk.usage.reasoningTokens || 0),
          cached: capturedUsage.cached + (chunk.usage.cachedPromptTokens || 0),
        };
      }
    }

    contentText += roundContent;
    thinkingText += roundThinking;

    // E1: Early termination check — if the same skill is called for 3 consecutive rounds, force terminate
    // declare_case / declare_step are BATCH-DECLARATION tools: the LLM is SUPPOSED to call
    // declare_step repeatedly (once per step). Exclude them from the stuck-detection so the
    // loop isn't aborted mid-way through a tool-based declaration (a real failure that forced
    // the LLM to abandon Mode A and fall back to JSON).
    const nonDeclarationRecords = toolCallRecords.filter(
      (r) => r.name !== 'declare_case' && r.name !== 'declare_step',
    );
    if (nonDeclarationRecords.length >= 3) {
      const recentCalls = nonDeclarationRecords.slice(-3);
      const uniqueRecent = new Set(recentCalls.map(r => r.name));
      if (uniqueRecent.size === 1) {
        log.info(`Early termination: stuck repeating skill "${recentCalls[0].name}"`);
        break;
      }
    }

    if (pendingToolCalls.length === 0) {
      log.info(`Round ${round + 1}: no tool calls, exiting loop`);
      break;
    }

    log.info(`Round ${round + 1}: ${pendingToolCalls.length} tool calls: ${pendingToolCalls.map(tc => tc.name).join(', ')}`);

    // Filter out empty-named tool calls (hallucinated by some providers)
    const namedToolCalls = pendingToolCalls.filter(tc => tc.name);
    const skippedCount = pendingToolCalls.length - namedToolCalls.length;
    if (skippedCount > 0) log.warn(`Skipped ${skippedCount} tool call(s) with empty name`);

    if (namedToolCalls.length === 0) {
      log.info(`No named tool calls, exiting loop`);
      break;
    }

    // Execute tool calls
    const toolResults: ChatMessage[] = [];
    const criticalTools = new Set(['requirement_detail_query', 'istqb_guide', 'requirement_graph_query', 'flow_detail_query', 'html_knowledge_query']);
    
    for (const tc of namedToolCalls) {
      const skill = skillMap.get(tc.name);
      if (!skill) {
        log.warn(`Unknown tool call: ${tc.name}`);
        toolResults.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: "${tc.name}". You can only call the tools explicitly provided to you. Do NOT invent or call any tool that is not in the available tool list. Continue your analysis in plain text and let the automatic extraction step produce the final structured output.` }, null, 2), toolCallId: tc.id });
        continue;
      }

      const skillStart = Date.now();
      try {
        let args = tc.args;
        if (typeof tc.args === 'string') {
          try {
            args = JSON.parse(tc.args);
          } catch (error) {
            // The HTML skill validates its own untrusted model input and returns
            // a bounded correction instead of turning malformed arguments into
            // a critical retrieval failure.
            if (tc.name !== 'html_knowledge_query') throw error;
          }
        }

        // Tool-schema validation at call time — only for declare_* tools.
        // Their enum/refine (verb whitelist, data-required, expectation coupling) MUST be
        // enforced HERE — otherwise invalid args reach declare-extract and only get
        // rejected later by validateStepContract, wasting the whole draft + a Phase 2
        // retry (real logs: "refresh browser page" non-vocab verb, fill-without-data,
        // element-state value "visible" all acked). Reject immediately with a clear
        // message so the LLM self-corrects in the next round.
        // Other skills (data queries, html_knowledge_query) intentionally handle their
        // own untrusted/malformed input leniently — do not gate them on schema here.
        const isDeclareTool = tc.name === 'declare_step' || tc.name === 'declare_case';
        const schemaCheck = isDeclareTool ? skill.schema?.safeParse(args) : undefined;
        if (schemaCheck && !schemaCheck.success) {
          const reasons = schemaCheck.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          const message = `${tc.name} arguments rejected by schema: ${reasons}. Fix the arguments and call the tool again.`;
          log.warn(message);
          const toolCallRecord: ToolCallRecord = {
            name: tc.name,
            input: tc.args,
            output: { error: message },
            latencyMs: Date.now() - skillStart,
          };
          toolCallRecords.push(toolCallRecord);
          observer?.onToolCall?.(agentName, toolCallRecord);
          toolResults.push({ role: 'tool', content: JSON.stringify({ error: message }, null, 2), toolCallId: tc.id });
          observer?.onStep?.(agentName, round + 1, `${tc.name} args rejected`);
          continue;
        }

        const result = await skill.func(args as Record<string, unknown>);
        const latencyMs = Date.now() - skillStart;
        const serializedResult = serializeToolResult(result);
        const persisted = projectToolCallForState(skill, args, result, serializedResult.stateOutput, {
          latencyMs,
          resultSize: serializedResult.content.length,
        });
        log.kv(`${tc.name}`, `completed (${latencyMs}ms)`);
        const toolCallRecord: ToolCallRecord = {
          name: tc.name,
          input: persisted.input,
          output: persisted.output,
          latencyMs,
        };
        toolCallRecords.push(toolCallRecord);
        observer?.onToolCall?.(agentName, toolCallRecord);
        toolResults.push({ role: 'tool', content: truncateToolResult(serializedResult.content), toolCallId: tc.id });
        observer?.onStep?.(agentName, round + 1, `Called ${tc.name} (${latencyMs}ms)`);
      } catch (err: any) {
        const latencyMs = Date.now() - skillStart;
        log.error(`Skill ${tc.name} FAILED (${latencyMs}ms): ${err.message}`);

        if (err instanceof ToolStateProjectionError) throw err;
        
        // Critical Tool Failure - Abort immediately instead of letting the LLM hallucinate
        if (criticalTools.has(tc.name)) {
          log.error(`CRITICAL TOOL FAILURE: ${tc.name} failed. Aborting ReAct loop to prevent hallucination.`);
          throw new Error(`Critical tool execution failed: [${tc.name}] ${err.message}. Aborting to prevent context hallucination.`);
        }

        const toolCallRecord: ToolCallRecord = {
          name: tc.name,
          input: tc.args,
          output: { error: err.message },
          latencyMs,
        };
        toolCallRecords.push(toolCallRecord);
        observer?.onToolCall?.(agentName, toolCallRecord);
        toolResults.push({ role: 'tool', content: JSON.stringify({ error: err.message }, null, 2), toolCallId: tc.id });
      }
    }

    // Append assistant message (with tool_calls) + tool results
    allMessages.push({
      role: 'assistant',
      content: roundContent || null as any,
      toolCalls: namedToolCalls.map((tc) => ({
        type: 'function' as const,
        function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) },
        id: tc.id,
      })),
    });

    allMessages.push(...toolResults);
  }

  const toolCallCount = toolCallRecords.length;
  observer?.onStep?.(agentName, 1, toolCallCount > 0
    ? `Phase 1: Analysis completed (${totalRounds} rounds, ${toolCallCount} tools)`
    : `Phase 1: Analysis completed (${totalRounds} rounds)`);

  return { contentText, thinkingText, toolCallRecords, usage: capturedUsage, conversationMessages: allMessages };
}

// ============================================================
// Main Entry: callLLMWithStructuredOutput
// ============================================================

/**
 * Call the LLM using a two-phase strategy:
 *   Phase 1: ReAct Loop — thinking + tool calls (if skills exist)
 *   Phase 2: Extraction — if Phase 1 does not produce valid JSON, make a second call to extract the structured output
 */
export async function callLLMWithStructuredOutput<T>(
  provider: AIProvider,
  messages: ChatMessage[],
  skills: SkillDefinition[],
  outputProfile: StructuredOutputProfile<T>,
  observer?: {
    onStep?: (name: string, idx: number, step: string) => void;
    onThinking?: (name: string, text: string, type: 'reasoning' | 'content', phase: 'react' | 'extraction') => void;
    onToolCall?: (name: string, toolCall: ToolCallRecord) => void;
  },
  agentName?: string,
  extra?: Partial<ChatOptions>,
): Promise<{ output: T; usage: { input: number; output: number; reasoning: number; cached: number }; toolCallRecords?: ToolCallRecord[] }> {
  const name = agentName ?? '';

  // ── Phase 1: ReAct Loop ──
  const reactResult = await runAgentReActLoop(
    provider,
    messages,
    skills,
    outputProfile,
    {
      onStep: observer?.onStep,
      onThinking: observer?.onThinking,
      onToolCall: observer?.onToolCall,
    },
    name,
    extra,
  );

  const { contentText, thinkingText, toolCallRecords, usage: capturedUsage, conversationMessages } = reactResult;

  if (!contentText && !thinkingText) {
    throw new Error('LLM produced no content in thinking phase');
  }

  const llmLog = Log.for(`llm:${name}`);

  // ── Phase 1-declare-extract ─────────────────────────────────────────────
  // Tool Use 强制结构化输出：如果 LLM 在 ReAct 中调用了 declare_case / declare_step
  // 工具，从 toolCallRecords 收集并拼成符合 DesignerRuntimeSchema 的 JSON。
  // verb 在工具层已由 enum 强制 → LLM 不可能写出非词表 action。
  const declareResult = tryExtractFromDeclareTools(toolCallRecords, contentText, name);
  if (declareResult) {
    try {
      const normalized = outputProfile.normalize(declareResult);
      const result = outputProfile.parse(normalized);
      llmLog.success('Phase 1 declare-extract valid ── skipping JSON extraction');
      observer?.onStep?.(name, 2, 'Phase 1: Declare-tool extraction success');
      return { output: result, usage: capturedUsage, toolCallRecords };
    } catch (parseErr: any) {
      const fullError = outputProfile.formatValidationError(parseErr);
      llmLog.warn(`Phase 1 declare-extract schema validation failed:\n${fullError}\n  → falling back to JSON extraction`);
    }
  }

  let phase1FailReason = 'no contentText';

  if (contentText) {
    const extracted = tryExtractJson(contentText);
    if (extracted) {
      if (outputProfile.shouldAttemptPhase1Extraction && !outputProfile.shouldAttemptPhase1Extraction(extracted)) {
        const { type: extractedType, keys } = extractedValueSummary(extracted);
        phase1FailReason = `unexpected wrapper (type=${extractedType}, keys=[${keys.join(',')}])`;
        llmLog.info(`Phase 1 JSON skipped ── ${phase1FailReason}`);
      } else {
      try {
        const normalized = outputProfile.normalize(extracted);
        const result = outputProfile.parse(normalized);
        llmLog.success('Phase 1 JSON valid ── skipping Phase 2');
        observer?.onStep?.(name, 2, 'Phase 1: Extraction direct success');
        return { output: result, usage: capturedUsage, toolCallRecords };
      } catch (parseErr: any) {
        const { type: extractedType, keys, draftTestCases: draftType } = extractedValueSummary(extracted);
        // Log the FULL validation error (not truncated) as an independent entry
        const fullError = outputProfile.formatValidationError(parseErr);
        phase1FailReason = `schema parse failed: ${fullError.split('\n')[0]}`;
        const errorBlock = [
          `Phase 1 JSON found but schema parse failed`,
          `  agent: ${name}`,
          `  extracted: type=${extractedType}, keys=[${keys.join(',')}], draftTestCases=${draftType}`,
          `  validation errors:`,
          ...fullError.split('\n').map(l => `    ${l}`),
        ].join('\n');
        llmLog.warn(errorBlock);
      }
      }
    } else {
      phase1FailReason = 'no JSON block found in contentText';
    }

  }

  // Phase 1.5: Nudge — if the LLM exited the ReAct loop without producing JSON,
  // send a follow-up in the SAME conversation (with full tool-result context)
  // asking it to output the final JSON. Phase 2 strips the conversation, losing
  // tool results — the nudge preserves them. Only triggers when no JSON was
  // found at all (not for schema-validation failures, which need Phase 2's
  // error-feedback loop).
  if (phase1FailReason === 'no JSON block found in contentText' && conversationMessages.length > 2) {
    llmLog.info('Phase 1.5: nudging LLM to output final JSON (full conversation context)');
    observer?.onStep?.(name, 2, 'Phase 1.5: Nudge for JSON output');

    const nudgeMessages: ChatMessage[] = [
      ...conversationMessages,
      { role: 'user' as const, content: buildExtractionPrompt(outputProfile) },
    ];

    const nudgeContent = await consumeExtractionStream(
      provider,
      nudgeMessages,
      buildExtractionChatOptions(outputProfile, extra),
      { onThinking: observer?.onThinking },
      name,
      capturedUsage,
    );

    if (nudgeContent) {
      const nudgeExtracted = tryExtractJson(nudgeContent);
      if (nudgeExtracted) {
        if (!outputProfile.shouldAttemptPhase1Extraction || outputProfile.shouldAttemptPhase1Extraction(nudgeExtracted)) {
          try {
            const normalized = outputProfile.normalize(nudgeExtracted);
            const result = outputProfile.parse(normalized);
            llmLog.success('Phase 1.5 JSON valid ── skipping Phase 2');
            observer?.onStep?.(name, 2, 'Phase 1.5: Nudge extraction success');
            return { output: result, usage: capturedUsage, toolCallRecords };
          } catch (parseErr: any) {
            const fullError = outputProfile.formatValidationError(parseErr);
            phase1FailReason = `Phase 1.5 schema parse failed: ${fullError.split('\n')[0]}`;
            llmLog.warn(`Phase 1.5 JSON found but schema parse failed:\n${fullError}`);
          }
        } else {
          const { keys } = extractedValueSummary(nudgeExtracted);
          llmLog.warn(`Phase 1.5 nudge produced unexpected wrapper (keys=[${keys.join(',')}])`);
        }
      } else {
        const preview = nudgeContent.length > 200 ? `${nudgeContent.slice(0, 200)}...` : nudgeContent;
        llmLog.warn(`Phase 1.5 nudge produced no parseable JSON ── length=${nudgeContent.length} ── preview: "${preview}"`);
      }
    } else {
      llmLog.warn('Phase 1.5 nudge produced no content');
    }
  }

  llmLog.info(`Phase 1 JSON invalid ── entering Phase 2 (schema extraction) ── reason: ${phase1FailReason}`);

  observer?.onStep?.(name, 2, 'Phase 2: Extracting structured output');

  // Phase 2: only send system + user + synthesized contentText + extraction prompt.
  // Skip all ReAct tool calls/results — contentText already synthesizes the findings
  // from tool calls. This avoids re-sending potentially large tool result payloads
  // (e.g., istqb_guide ~7k tokens, requirement_graph_query ~2k tokens per call).
  // Fallback: if contentText is too short (LLM put analysis in tool results, not content),
  // include the full conversation to preserve context.
  const PHASE2_MIN_CONTENT_LENGTH = 100;
  const useFullConversation = !contentText || contentText.length < PHASE2_MIN_CONTENT_LENGTH;

  let extractionMessages: ChatMessage[];
  if (useFullConversation) {
    llmLog.info(`Phase 2: contentText too short (${contentText.length} chars), using full conversation`);
    extractionMessages = [
      ...conversationMessages,
      { role: 'assistant' as const, content: contentText || '(analysis completed in earlier messages)' },
      { role: 'user' as const, content: buildExtractionPrompt(outputProfile) },
    ];
  } else {
    llmLog.info(`Phase 2: using condensed messages (system + user + contentText only), skipping ${conversationMessages.length - messages.length} ReAct messages`);
    extractionMessages = [
      ...messages,
      { role: 'assistant' as const, content: contentText },
      { role: 'user' as const, content: buildExtractionPrompt(outputProfile) },
    ];
  }

  const MAX_PHASE2_RETRIES = 3;
  let lastError: Error | null = null;
  const baseMessagesLength = extractionMessages.length;
  let lastErrorFeedback: ChatMessage[] | null = null;

  let lastExtractContent = '';

  for (let attempt = 1; attempt <= MAX_PHASE2_RETRIES; attempt++) {
    // Reset to base messages, then re-attach the most recent error feedback so
    // the LLM can self-correct on the next attempt (without unbounded token
    // growth from accumulating feedback across all retries).
    extractionMessages.splice(baseMessagesLength);
    if (lastErrorFeedback) {
      extractionMessages.push(...lastErrorFeedback);
    }

    if ((extra as any)?.signal?.aborted) {
      const reason: any = (extra as any)?.signal?.reason;
      const timedOut = reason != null && String(reason?.name) === 'TimeoutError';
      llmLog.error(`Phase 2 aborted on attempt ${attempt} (${timedOut ? 'timeout' : 'cancelled'})`);
      throw lastError || new Error(
        timedOut
          ? `Agent ${agentName || 'unknown'} timed out after ${(extra as any)?.timeoutMs ?? 'the configured'}ms`
          : 'Aborted',
      );
    }

    llmLog.info(`Phase 2 attempt ${attempt}/${MAX_PHASE2_RETRIES}`);
    observer?.onStep?.(name, 2, `Phase 2: Attempt ${attempt}/${MAX_PHASE2_RETRIES}`);
    const extractContent = await consumeExtractionStream(
      provider,
      extractionMessages,
      buildExtractionChatOptions(outputProfile, extra),
      { onThinking: observer?.onThinking },
      name,
      capturedUsage,
    );

    if (extractContent) {
      // Schema-constrained output should produce valid JSON, but still try parse with fallback
      const parsed = tryExtractJson(extractContent) ?? (() => {
        try { return JSON.parse(extractContent); } catch { return null; }
      })();

      if (parsed) {
        try {
          const result = outputProfile.parse(outputProfile.normalize(parsed));
          llmLog.success(`Phase 2 extraction successful on attempt ${attempt}`);
          observer?.onStep?.(name, 3, 'Phase 2: Extraction successful');
          return { output: result, usage: capturedUsage, toolCallRecords };
        } catch (schemaErr: any) {
          // Log the FULL validation error (not truncated) as an independent entry
          const fullError = outputProfile.formatValidationError(schemaErr);
          const errorBlock = [
            `Phase 2 schema validation failed on attempt ${attempt}`,
            `  agent: ${name}`,
            `  validation errors:`,
            ...fullError.split('\n').map(l => `    ${l}`),
          ].join('\n');
          llmLog.warn(errorBlock);
          // Attach the raw LLM content to the error so scope.ts can persist it
          // to error_raw_response for offline debugging.
          (schemaErr as any).rawResponse = extractContent;
          lastError = schemaErr;

          lastErrorFeedback = [
            { role: 'assistant', content: extractContent },
            { role: 'user', content: `Your JSON was valid, but schema validation failed: ${outputProfile.formatValidationError(schemaErr)} Please fix these errors and output the corrected JSON matching the schema exactly.` },
          ];
        }
      } else {
        const preview = extractContent.length > 500 ? `${extractContent.slice(0, 500)}...` : extractContent;
        llmLog.warn(`Phase 2 produced unparseable content on attempt ${attempt} ── length=${extractContent.length} ── content preview: "${preview}"`);
        lastExtractContent = extractContent;
        lastError = new Error('Unparseable content');
        // Persist the raw content for offline debugging.
        (lastError as any).rawResponse = extractContent;

        lastErrorFeedback = [
          { role: 'assistant', content: extractContent },
          { role: 'user', content: 'The output was not valid JSON. Common issues: missing commas between properties, unquoted property names (use "key" not key), trailing commas before ] or }, or unclosed braces/brackets. Output a single valid JSON object matching the schema with no extra text.' },
        ];
      }
    } else {
      llmLog.warn(`Phase 2 produced no content on attempt ${attempt}`);
      lastError = new Error('No content produced');

      lastErrorFeedback = [
        { role: 'assistant', content: '(no output)' },
        { role: 'user', content: 'No content was generated. Please ensure you output a single valid JSON object matching the schema.' },
      ];
    }
  }

  if (lastExtractContent) {
    llmLog.error(`Last Phase 2 content (full):\n${lastExtractContent}`);
  }
  llmLog.error(`FAILED to extract structured output after ${MAX_PHASE2_RETRIES} attempts`);
  observer?.onStep?.(name, 3, 'Phase 2: Extraction failed');
  throw lastError || new Error('Failed to extract structured output from LLM response');
}
