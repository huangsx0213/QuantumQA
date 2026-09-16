import { jsonrepair } from 'jsonrepair';

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

/**
 * Net count of unclosed { [ vs } ] outside strings. > 0 means the text is a
 * truncated/unbalanced fragment — jsonrepair would auto-close it into a
 * "valid but incomplete" object, masking the truncation.
 */
function countUnclosedBraces(text: string): number {
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  return depth;
}

export interface TryExtractJsonOptions {
  /**
   * Allow repairing TRUNCATED JSON (unbalanced braces from max_tokens cutoff)
   * into a parseable object. Default OFF: on strict extraction paths a
   * repaired truncation is "valid but incomplete" and masks the real failure
   * (output too long) as missing-field errors. Turn ON only when scavenging
   * free text (Phase 1 / Phase 1.5 / emit-extract), where a partial catch is
   * still better than nothing.
   */
  allowTruncatedRepair?: boolean;
}

/**
 * Extract a JSON object from text. By priority:
 *   1. The entire content is JSON
 *   2. Extract the last complete JSON object from mixed text
 */
export function tryExtractJson(content: string, opts: TryExtractJsonOptions = {}): unknown | null {
  const allowTruncatedRepair = opts.allowTruncatedRepair ?? false;
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
    // Unbalanced candidate = truncated fragment; auto-closing it produces a
    // "valid but incomplete" object — only allowed when the caller opted in.
    if (!allowTruncatedRepair && countUnclosedBraces(c) > 0) continue;
    const repaired = tryRepairJson(c);
    if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
  }

  // 2.5. Handle truncated JSON (missing closing fence/braces — LLM hit max
  // output tokens). Extract from the first '{' to end of stripped content and
  // try jsonrepair, which auto-closes missing brackets/braces. Only on the
  // opt-in path — a repaired truncation masks the failure on strict paths.
  if (allowTruncatedRepair) {
    const firstBrace = stripped.indexOf('{');
    if (firstBrace !== -1) {
      const repaired = tryRepairJson(stripped.slice(firstBrace));
      if (repaired !== null) try { return JSON.parse(repaired); } catch { /* continue */ }
    }
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
      // Truncated JSON (unbalanced braces) — try jsonrepair on the tail.
      // Opt-in only: auto-closing a truncation masks the failure on strict paths.
      if (allowTruncatedRepair) {
        const repaired = tryRepairJson(content.slice(openIdx));
        if (repaired !== null) try { return JSON.parse(repaired); } catch { /* try next */ }
      }
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