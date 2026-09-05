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
 * Extract a JSON object from text. By priority:
 *   1. The entire content is JSON
 *   2. Extract the last complete JSON object from mixed text
 */
export function tryExtractJson(content: string): unknown | null {
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