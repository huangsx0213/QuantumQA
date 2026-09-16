import type { ToolCallRecord } from './types.ts';
import { Log } from '../../../../shared/services/logger.ts';
import { tryExtractJson } from './json-extract.ts';

// ============================================================
// Phase 1-emit-extract: Tool Use 强制结构化输出
// ============================================================

/**
 * 从 ReAct 工具调用记录中提取 emit_case 调用并拼装成 { draftTestCases: [...] }，
 * 供 DesignerRuntimeSchema.parse 验证。
 *
 * - emit_case 一次声明一个完整 case：元数据（id/title/conditionId/...） + 内嵌 steps 数组
 * - 同一 id 的多次 emit_case 取最后一次（覆盖）—— 支持定点修补（重复 emit 同 id）
 * - steps 缺省 stepNumber 时按数组顺序自动编号 1,2,3…
 * - action 从 {verb, targetHint, data} 拼装为 `verb targetHint`（或带 data 后缀）
 * - intent 从 {targetHint, data, expectation} 构造
 * - selfReview 默认填 {score:7, ...}（避免 LLM 必填 selfReview 拖慢流程）
 *
 * 返回 null 表示 LLM 没调过 emit_case，或 contentText 中含有更完整的 JSON draft
 * （LLM 中途弃用工具转 JSON）——此时调用方应走 Phase 1.5/2 JSON 提取。
 */
export function tryExtractFromEmitTools(
  toolCallRecords: ToolCallRecord[],
  contentText: string,
  agentName: string,
): Record<string, unknown> | null {
  const emitCases = toolCallRecords.filter((r) => r.name === 'emit_case');
  if (emitCases.length === 0) return null;

  const extractLog = Log.for(`llm:${agentName}:emit-extract`);

  // 关键：LLM 常在 emit 少数 case 后弃用工具、改用 thinking 文本 JSON 输出其余 case
  //（实测 emit 1 case + 12 个 JSON case）。若 contentText 中有更完整的 draftTestCases，
  // 工具路径构建的 draft 必然因"覆盖不全"被 validateConditionCoverage 拒绝——
  // 与其浪费一次注定失败的 parse，直接弃用工具路径，信 contentText 的完整 JSON。
  const thinkingJson = extractDraftJsonFromText(contentText);
  if (thinkingJson) {
    const jsonCaseCount = Array.isArray(thinkingJson) ? thinkingJson.length : (Array.isArray((thinkingJson as any)?.draftTestCases) ? (thinkingJson as any).draftTestCases.length : 0);
    const emittedCaseCount = new Set(
      emitCases.map((r) => String((r.input as any)?.id ?? '')).filter(Boolean),
    ).size;
    if (jsonCaseCount > emittedCaseCount) {
      extractLog.info(`emitted ${emittedCaseCount} case(s) via tools but thinking text has ${jsonCaseCount} — LLM switched to JSON; deferring to JSON extraction`);
      return null;
    }
  }

  extractLog.info(`emit_case=${emitCases.length}`);

  // Build case map (last-write-wins for duplicate ids).
  const casesById = new Map<string, Record<string, unknown>>();
  for (const rec of emitCases) {
    if (!rec.input || typeof rec.input !== 'object') continue;
    const id = String((rec.input as any).id ?? '').trim();
    if (!id) continue;
    casesById.set(id, rec.input as Record<string, unknown>);
  }

  const draftTestCases: Record<string, unknown>[] = [];
  for (const input of casesById.values()) {
    const steps = flattenSteps(input.steps);
    if (steps.length === 0) continue; // 防御：schema 已强制 min 1，此处仅跳过异常
    const expectedCovered = Array.isArray(input.coveredConditions) ? input.coveredConditions as string[] : [];
    const constructed = constructDraftTestCase(input, steps, expectedCovered);
    draftTestCases.push(constructed);
  }

  if (draftTestCases.length === 0) return null;
  extractLog.info(`built ${draftTestCases.length} draft test case(s) from emit_case tools`);
  return { draftTestCases };
}

/**
 * 将 emit_case 内嵌的 steps 数组扁平化：stepNumber 缺省时按数组顺序自动编号 1,2,3…，
 * 并按 stepNumber 升序排序（步骤顺序稳定，不受 LLM 输出顺序影响）。
 * 显式 stepNumber 优先（否则 auto-number 赋 idx+1）。
 */
function flattenSteps(rawSteps: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawSteps)) return [];
  const steps: Record<string, unknown>[] = [];
  rawSteps.forEach((rawStep, idx) => {
    if (!rawStep || typeof rawStep !== 'object') return;
    const step = rawStep as Record<string, unknown>;
    const autoNumber = (Number(step.stepNumber) || 0) > 0
      ? Number(step.stepNumber)
      : idx + 1;
    steps.push({ ...step, stepNumber: autoNumber });
  });
  return steps.sort((a, b) => Number(a.stepNumber) - Number(b.stepNumber));
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
  const parsed = tryExtractJson(contentText, { allowTruncatedRepair: true });
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