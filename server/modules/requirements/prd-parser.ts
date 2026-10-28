import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type { PrdParsedPreviewItem, PrdParsePreviewResult, Requirement } from '../../../shared/contracts/index.ts';
import { randomId } from '../../shared/utils/index.ts';
import { parseMarkdownRequirements, parseCsvRequirements } from './import.ts';
import { parseStoryMarkdown, parseACMarkdown } from './format-parser.ts';
import { providerConfigRepo } from '../provider-configs/repository.ts';
import { createAIProvider } from '../ai-test-gen/infra/provider.ts';
import { Log } from '../../shared/services/logger.ts';
import { decryptApiKey } from '../../shared/crypto.ts';

export interface ParsePrdOptions {
  fileName: string;
  buffer: Buffer;
  projectId: string;
  documentTitle: string;
  providerConfigId?: string;
  model?: string;
  existingRequirements?: Requirement[];
  existingVersionsCount?: number;
}

export interface PrdCompileResult {
  items: PrdParsedPreviewItem[];
  warnings: string[];
}

/**
 * Extracts an explicit version tag from file name or document text snippet (e.g., "v1.1", "1.2").
 */
export function extractVersionTag(fileName: string, textSnippet?: string): string | null {
  const fileMatch = fileName.match(/(?:^|[-_ .])v?(\d+\.\d+(?:\.\d+)?)(?:[-_ .]|$)/i);
  if (fileMatch) {
    return `v${fileMatch[1]}`;
  }
  if (textSnippet) {
    const textMatch = textSnippet.match(/(?:version|v)\s*(\d+\.\d+(?:\.\d+)?)/i);
    if (textMatch) {
      return `v${textMatch[1]}`;
    }
  }
  return null;
}

/**
 * Strips trailing version patterns from document title so PRDs don't get stuck with e.g. "-v1.0" in their persistent title.
 */
export function cleanDocumentTitle(title: string): string {
  return title.replace(/[-_ .]v?\d+\.\d+(?:\.\d+)?$/i, '').trim() || title;
}

/**
 * Compile Gate for PRD Items:
 * Adheres to CONTEXT.md Compile Gate rule — validates all items before database admission.
 * - Enforces valid levels ('epic' | 'story' | 'ac')
 * - Two-pass ID resolution: handles out-of-order parent-child relationships and detects orphans
 * - Validates Gherkin format for Acceptance Criteria (Given/When/Then)
 * - Emits warnings on any fallback or non-fatal anomaly
 */
export function compilePrdGate(
  rawItems: any[],
  fallbackAnchorPrefix = 'Section'
): PrdCompileResult {
  const warnings: string[] = [];
  const items: PrdParsedPreviewItem[] = [];

  if (!Array.isArray(rawItems)) {
    return { items: [], warnings: ['Invalid PRD items payload: expected an array'] };
  }

  // Pass 1: Collect tempIds and allocate IDs
  const idMap = new Map<string, string>();
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const key = raw.tempId ? String(raw.tempId).trim() : `idx_${i}`;
    if (!idMap.has(key)) {
      idMap.set(key, raw.id || randomId('req'));
    }
  }

  // Pass 2: Validate hierarchy, resolve parents, check Gherkin syntax
  let lastEpicId: string | null = null;
  let lastStoryId: string | null = null;

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const tempKey = raw.tempId ? String(raw.tempId).trim() : `idx_${i}`;
    const realId = idMap.get(tempKey) || randomId('req');
    const rawLevel = String(raw.level || '').toLowerCase().trim();

    // 1. Level validation
    let level: 'epic' | 'story' | 'ac' = 'story';
    if (rawLevel === 'epic' || rawLevel === 'story' || rawLevel === 'ac') {
      level = rawLevel;
    } else {
      warnings.push(`Item "${raw.title || i}" has invalid level "${raw.level}", defaulted to "story".`);
      level = 'story';
    }

    // 2. Parent resolution
    let parentId: string | null = null;
    if (level === 'epic') {
      parentId = null; // Epics are root-level
      lastEpicId = realId;
      lastStoryId = null;
    } else {
      if (raw.parentTempId) {
        const pKey = String(raw.parentTempId).trim();
        if (idMap.has(pKey)) {
          parentId = idMap.get(pKey)!;
        } else {
          warnings.push(`Orphan item: "${raw.title || i}" references unknown parentTempId "${raw.parentTempId}". Attached to preceding context.`);
          parentId = level === 'ac' ? (lastStoryId || lastEpicId) : lastEpicId;
        }
      } else if (raw.parentId) {
        parentId = String(raw.parentId);
      } else {
        // Natural context fallback
        parentId = level === 'ac' ? (lastStoryId || lastEpicId) : lastEpicId;
      }

      if (level === 'story') {
        lastStoryId = realId;
      }
    }

    const title = String(raw.title || `Requirement ${i + 1}`).trim();
    const description = String(raw.description || '').trim();

    // 3. Gherkin check for ACs
    if (level === 'ac') {
      const hasGiven = /\bgiven\b/i.test(description);
      const hasWhen = /\bwhen\b/i.test(description);
      const hasThen = /\bthen\b/i.test(description);
      if (!hasGiven || !hasWhen || !hasThen) {
        warnings.push(`AC "${title}" does not strictly follow Given/When/Then Gherkin format.`);
      }
    }

    // Preserve the diff annotation supplied by the caller. In the parse-preview
    // flow computePrdDiff overwrites this right after; in the commit flow the
    // items arrive with the diffStatus computed at preview time, and losing it
    // here would stamp every row APPROVED on the new version and resurrect
    // rows that should be DEPRECATED.
    const rawDiffStatus = String(raw.diffStatus || '');
    const diffStatus = (['added', 'modified', 'deprecated', 'unchanged'] as const).includes(rawDiffStatus as any)
      ? (rawDiffStatus as PrdParsedPreviewItem['diffStatus'])
      : 'added';

    items.push({
      id: realId,
      title,
      description,
      level,
      parentId,
      isFlow: Boolean(raw.isFlow),
      flowType: level === 'ac' ? (raw.flowType || 'atomic') : null,
      sourceAnchor: raw.sourceAnchor || `${fallbackAnchorPrefix} ${i + 1}`,
      diffStatus,
    });
  }

  return { items, warnings };
}

/**
 * Computes Diff against existing requirements:
 * 1. Prioritizes matching by sourceAnchor (e.g. Row 14, Section 2.1)
 * 2. Falls back to normalized title matching
 * 3. Identifies added, modified, unchanged, and deprecated items
 */
/**
 * Normalizes title for robust fuzzy/structural matching across PRD versions.
 * Strips leading numbering (e.g. "1.1", "##", "Chapter 1:"), punctuation, and excess whitespace.
 */
export function normalizeTitleForMatch(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/^(?:chapter|section|module|epic|story|ac|part)\s*[\d.:-]*\s*/i, '')
    .replace(/^\d+(?:\.\d+)*\s*[-:、.]\s*/, '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '')
    .trim();
}

/**
 * Normalizes source anchor for matching (e.g. "Row 14", "row: 14", "Row #14" -> "row14")
 */
export function normalizeAnchorForMatch(anchor?: string | null): string {
  if (!anchor) return '';
  return anchor.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '').trim();
}

/**
 * Normalizes multi-line text (e.g. Gherkin criteria) for diff comparison by trimming lines and normalizing line breaks.
 */
export function normalizeTextForComparison(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanForFuzzyText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compares two requirement descriptions semantically.
 * Handles literal matches, newline-vs-comma delimiter formatting variations,
 * and structured Agile story (As a... I want... So that...) and Gherkin AC segments.
 */
export function areDescriptionsEquivalent(
  desc1: string | null | undefined,
  desc2: string | null | undefined,
  level?: string
): boolean {
  const d1 = (desc1 || '').trim();
  const d2 = (desc2 || '').trim();
  if (d1 === d2) return true;
  if (!d1 && !d2) return true;
  if (!d1 || !d2) return false;

  // 1. Literal line-trimmed match
  if (normalizeTextForComparison(d1) === normalizeTextForComparison(d2)) {
    return true;
  }

  // 2. Delimiter & punctuation invariant (e.g. commas vs newlines in user stories, trailing periods)
  if (cleanForFuzzyText(d1) === cleanForFuzzyText(d2)) {
    return true;
  }

  // 3. Structured Agile story semantic comparison
  if (level === 'story') {
    const s1 = parseStoryMarkdown(d1);
    const s2 = parseStoryMarkdown(d2);
    if (s1.hasAllSegments && s2.hasAllSegments) {
      if (
        cleanForFuzzyText(s1.role) === cleanForFuzzyText(s2.role) &&
        cleanForFuzzyText(s1.action) === cleanForFuzzyText(s2.action) &&
        cleanForFuzzyText(s1.value) === cleanForFuzzyText(s2.value) &&
        cleanForFuzzyText(s1.remainder) === cleanForFuzzyText(s2.remainder)
      ) {
        return true;
      }
    }
  }

  // 4. Structured Gherkin AC semantic comparison
  if (level === 'ac') {
    const a1 = parseACMarkdown(d1);
    const a2 = parseACMarkdown(d2);
    if (a1.hasAllSegments && a2.hasAllSegments) {
      if (
        cleanForFuzzyText(a1.given) === cleanForFuzzyText(a2.given) &&
        cleanForFuzzyText(a1.when) === cleanForFuzzyText(a2.when) &&
        cleanForFuzzyText(a1.then) === cleanForFuzzyText(a2.then) &&
        cleanForFuzzyText(a1.remainder) === cleanForFuzzyText(a2.remainder)
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasRowAnchorContinuity(existingItem: Requirement, newItem: PrdParsedPreviewItem): boolean {
  if (areDescriptionsEquivalent(existingItem.description, newItem.description, newItem.level)) {
    return true;
  }
  const eNorm = normalizeTitleForMatch(existingItem.title);
  const nNorm = normalizeTitleForMatch(newItem.title);
  if (eNorm.length >= 3 && nNorm.length >= 3 && (eNorm.includes(nNorm) || nNorm.includes(eNorm))) {
    return true;
  }
  return false;
}

/**
 * Computes difference between newly parsed PRD items and existing project requirements.
 * Implements a hierarchical, level-isolated matching engine to guarantee that multi-version
 * imports (Excel, Word, Markdown, CSV) never confuse Epics/Stories/ACs, and never mistakenly
 * deprecate requirements due to row shifts, anchor collisions, or minor AI rewordings.
 */
export function computePrdDiff(
  newItems: PrdParsedPreviewItem[],
  existingRequirements: Requirement[] = []
): { items: PrdParsedPreviewItem[]; deprecatedCount: number } {
  if (existingRequirements.length === 0) {
    return { items: newItems, deprecatedCount: 0 };
  }

  const matchedExistingIds = new Set<string>();
  // Maps new temporary ID -> existing stable database ID
  const stableIdMap = new Map<string, string>();

  // Partition existing requirements by level for strict level isolation
  const existingEpics = existingRequirements.filter((r) => r.level === 'epic');
  const existingStories = existingRequirements.filter((r) => r.level === 'story');
  const existingAcs = existingRequirements.filter((r) => r.level === 'ac');

  const newEpics = newItems.filter((i) => i.level === 'epic');
  const newStories = newItems.filter((i) => i.level === 'story');
  const newAcs = newItems.filter((i) => i.level === 'ac');

  // Helper to bind a new item to an existing stable item
  function bindMatch(newItem: PrdParsedPreviewItem, existing: Requirement) {
    matchedExistingIds.add(existing.id);
    if (newItem.id) {
      stableIdMap.set(newItem.id, existing.id);
    }
    newItem.id = existing.id;

    const existingNormTitle = normalizeTitleForMatch(existing.title);
    const newNormTitle = normalizeTitleForMatch(newItem.title);
    const titleMatch = existingNormTitle === newNormTitle && newNormTitle.length > 0;

    const descMatch = areDescriptionsEquivalent(existing.description, newItem.description, newItem.level);

    const isTabular = Boolean(
      newItem.sourceAnchor && /^Row\s+\d+/i.test(newItem.sourceAnchor) &&
      existing.sourceAnchor && /^Row\s+\d+/i.test(existing.sourceAnchor)
    );

    if (isTabular) {
      if (newItem.level === 'epic' || newItem.level === 'story') {
        // In spreadsheets, Epic and Story columns only contain titles (descriptions are AI synthesized).
        // If the title did not change in the sheet, it is unchanged.
        if (titleMatch) {
          newItem.title = existing.title;
          if (existing.description) newItem.description = existing.description;
          newItem.diffStatus = 'unchanged';
        } else {
          newItem.diffStatus = 'modified';
        }
      } else if (newItem.level === 'ac') {
        // In spreadsheets, the criteria cell is the source of truth (AC title is AI-synthesized).
        // If criteria text didn't change in the sheet, it is unchanged.
        if (descMatch) {
          newItem.title = existing.title;
          if (existing.description) newItem.description = existing.description;
          newItem.diffStatus = 'unchanged';
        } else {
          newItem.diffStatus = 'modified';
        }
      } else {
        newItem.diffStatus = titleMatch && descMatch ? 'unchanged' : 'modified';
      }
    } else {
      // Document formats (Markdown / Word / Freeform):
      // Epics in PRD documents rarely have standalone descriptions in the source text;
      // if title is matched, preserve approved description and treat as unchanged.
      if (newItem.level === 'epic') {
        if (titleMatch) {
          newItem.title = existing.title;
          if (existing.description) newItem.description = existing.description;
          newItem.diffStatus = 'unchanged';
        } else {
          newItem.diffStatus = 'modified';
        }
      } else if (titleMatch && descMatch) {
        if (existing.description) newItem.description = existing.description;
        newItem.diffStatus = 'unchanged';
      } else {
        newItem.diffStatus = 'modified';
      }
    }

    if (newItem.diffStatus === 'modified') {
      newItem.previousTitle = existing.title;
      newItem.previousDescription = existing.description;
    }
  }

  // --- TIER 1: Match Epics (Multi-pass across all newEpics) ---
  const unmatchedNewEpics = new Set(newEpics);

  // Pass 1A: Exact normalized title
  for (const newEpic of unmatchedNewEpics) {
    const newNormTitle = normalizeTitleForMatch(newEpic.title);
    if (!newNormTitle) continue;
    const candidate = existingEpics.find(
      (e) => !matchedExistingIds.has(e.id) && normalizeTitleForMatch(e.title) === newNormTitle
    );
    if (candidate) {
      bindMatch(newEpic, candidate);
      unmatchedNewEpics.delete(newEpic);
    }
  }

  // Pass 1B: Exact anchor match (for remaining unmatched Epics; require content continuity for physical rows)
  for (const newEpic of unmatchedNewEpics) {
    const newNormAnchor = normalizeAnchorForMatch(newEpic.sourceAnchor);
    if (!newNormAnchor) continue;
    const isRow = /^row\d+$/i.test(newNormAnchor);
    const candidate = existingEpics.find((e) => {
      if (matchedExistingIds.has(e.id)) return false;
      if (normalizeAnchorForMatch(e.sourceAnchor) !== newNormAnchor) return false;
      if (isRow && !hasRowAnchorContinuity(e, newEpic)) return false;
      return true;
    });
    if (candidate) {
      bindMatch(newEpic, candidate);
      unmatchedNewEpics.delete(newEpic);
    }
  }

  // Pass 1C: Substring / Substantial title match (for remaining unmatched Epics)
  for (const newEpic of unmatchedNewEpics) {
    const newNormTitle = normalizeTitleForMatch(newEpic.title);
    if (newNormTitle.length < 3) continue;
    const candidate = existingEpics.find((e) => {
      if (matchedExistingIds.has(e.id)) return false;
      const eNorm = normalizeTitleForMatch(e.title);
      return eNorm.includes(newNormTitle) || newNormTitle.includes(eNorm);
    });
    if (candidate) {
      bindMatch(newEpic, candidate);
      unmatchedNewEpics.delete(newEpic);
    }
  }

  for (const newEpic of unmatchedNewEpics) {
    newEpic.diffStatus = 'added';
  }

  // --- TIER 2: Match Stories (Multi-pass across all newStories) ---
  const unmatchedNewStories = new Set(newStories);

  // Pass 2A: Same parent Epic + Exact normalized title
  for (const newStory of unmatchedNewStories) {
    const newNormTitle = normalizeTitleForMatch(newStory.title);
    if (!newNormTitle) continue;
    const targetParentId = newStory.parentId ? (stableIdMap.get(newStory.parentId) || newStory.parentId) : null;
    const candidate = existingStories.find((s) => {
      if (matchedExistingIds.has(s.id)) return false;
      const sameParent = targetParentId ? s.parentId === targetParentId : true;
      return sameParent && normalizeTitleForMatch(s.title) === newNormTitle;
    });
    if (candidate) {
      bindMatch(newStory, candidate);
      unmatchedNewStories.delete(newStory);
    }
  }

  // Pass 2B: Global exact normalized title (in case parent Epic changed)
  for (const newStory of unmatchedNewStories) {
    const newNormTitle = normalizeTitleForMatch(newStory.title);
    if (!newNormTitle) continue;
    const candidate = existingStories.find(
      (s) => !matchedExistingIds.has(s.id) && normalizeTitleForMatch(s.title) === newNormTitle
    );
    if (candidate) {
      bindMatch(newStory, candidate);
      unmatchedNewStories.delete(newStory);
    }
  }

  // Pass 2C: Same parent Epic + Exact anchor match (for renamed stories sharing anchor)
  for (const newStory of unmatchedNewStories) {
    const newNormAnchor = normalizeAnchorForMatch(newStory.sourceAnchor);
    if (!newNormAnchor) continue;
    const isRow = /^row\d+$/i.test(newNormAnchor);
    const targetParentId = newStory.parentId ? (stableIdMap.get(newStory.parentId) || newStory.parentId) : null;
    const candidate = existingStories.find((s) => {
      if (matchedExistingIds.has(s.id)) return false;
      const sameParent = targetParentId ? s.parentId === targetParentId : true;
      if (!sameParent || normalizeAnchorForMatch(s.sourceAnchor) !== newNormAnchor) return false;
      if (isRow && !hasRowAnchorContinuity(s, newStory)) return false;
      return true;
    });
    if (candidate) {
      bindMatch(newStory, candidate);
      unmatchedNewStories.delete(newStory);
    }
  }

  // Pass 2D: Global exact anchor match within story level (require content continuity for physical rows)
  for (const newStory of unmatchedNewStories) {
    const newNormAnchor = normalizeAnchorForMatch(newStory.sourceAnchor);
    if (!newNormAnchor) continue;
    const isRow = /^row\d+$/i.test(newNormAnchor);
    const candidate = existingStories.find((s) => {
      if (matchedExistingIds.has(s.id)) return false;
      if (normalizeAnchorForMatch(s.sourceAnchor) !== newNormAnchor) return false;
      if (isRow && !hasRowAnchorContinuity(s, newStory)) return false;
      return true;
    });
    if (candidate) {
      bindMatch(newStory, candidate);
      unmatchedNewStories.delete(newStory);
    }
  }

  // Pass 2E: Same parent Epic + Substring / Substantial title match
  for (const newStory of unmatchedNewStories) {
    const newNormTitle = normalizeTitleForMatch(newStory.title);
    if (newNormTitle.length < 3) continue;
    const targetParentId = newStory.parentId ? (stableIdMap.get(newStory.parentId) || newStory.parentId) : null;
    if (!targetParentId) continue;
    const candidate = existingStories.find((s) => {
      if (matchedExistingIds.has(s.id)) return false;
      if (s.parentId !== targetParentId) return false;
      const sNorm = normalizeTitleForMatch(s.title);
      return sNorm.includes(newNormTitle) || newNormTitle.includes(sNorm);
    });
    if (candidate) {
      bindMatch(newStory, candidate);
      unmatchedNewStories.delete(newStory);
    }
  }

  for (const newStory of unmatchedNewStories) {
    newStory.diffStatus = 'added';
  }

  // --- TIER 3: Match ACs (Multi-pass across all newAcs) ---
  const unmatchedNewAcs = new Set(newAcs);

  // Pass 3A: Same parent Story + Exact normalized title
  for (const newAc of unmatchedNewAcs) {
    const newNormTitle = normalizeTitleForMatch(newAc.title);
    if (!newNormTitle) continue;
    const targetParentId = newAc.parentId ? (stableIdMap.get(newAc.parentId) || newAc.parentId) : null;
    const candidate = existingAcs.find((a) => {
      if (matchedExistingIds.has(a.id)) return false;
      const sameParent = targetParentId ? a.parentId === targetParentId : true;
      return sameParent && normalizeTitleForMatch(a.title) === newNormTitle;
    });
    if (candidate) {
      bindMatch(newAc, candidate);
      unmatchedNewAcs.delete(newAc);
    }
  }

  // Pass 3B: Same parent Story + Exact description match
  for (const newAc of unmatchedNewAcs) {
    const desc = (newAc.description || '').trim();
    if (!desc) continue;
    const targetParentId = newAc.parentId ? (stableIdMap.get(newAc.parentId) || newAc.parentId) : null;
    if (!targetParentId) continue;
    const candidate = existingAcs.find((a) => {
      if (matchedExistingIds.has(a.id)) return false;
      return a.parentId === targetParentId && (a.description || '').trim() === desc;
    });
    if (candidate) {
      bindMatch(newAc, candidate);
      unmatchedNewAcs.delete(newAc);
    }
  }

  // Pass 3C: Global exact normalized title
  for (const newAc of unmatchedNewAcs) {
    const newNormTitle = normalizeTitleForMatch(newAc.title);
    if (!newNormTitle) continue;
    const candidate = existingAcs.find(
      (a) => !matchedExistingIds.has(a.id) && normalizeTitleForMatch(a.title) === newNormTitle
    );
    if (candidate) {
      bindMatch(newAc, candidate);
      unmatchedNewAcs.delete(newAc);
    }
  }

  // Pass 3D: Same parent Story + Exact anchor match (for renamed ACs; require content continuity for physical rows)
  for (const newAc of unmatchedNewAcs) {
    const newNormAnchor = normalizeAnchorForMatch(newAc.sourceAnchor);
    if (!newNormAnchor) continue;
    const isRow = /^row\d+$/i.test(newNormAnchor);
    const targetParentId = newAc.parentId ? (stableIdMap.get(newAc.parentId) || newAc.parentId) : null;
    const candidate = existingAcs.find((a) => {
      if (matchedExistingIds.has(a.id)) return false;
      const sameParent = targetParentId ? a.parentId === targetParentId : true;
      if (!sameParent || normalizeAnchorForMatch(a.sourceAnchor) !== newNormAnchor) return false;
      if (isRow && !hasRowAnchorContinuity(a, newAc)) return false;
      return true;
    });
    if (candidate) {
      bindMatch(newAc, candidate);
      unmatchedNewAcs.delete(newAc);
    }
  }

  // Pass 3E: Ordinal position match under the same Story if counts match
  for (const newAc of unmatchedNewAcs) {
    const targetParentId = newAc.parentId ? (stableIdMap.get(newAc.parentId) || newAc.parentId) : null;
    if (!targetParentId) continue;
    const newAcsUnderParent = newAcs.filter((a) => (stableIdMap.get(a.parentId || '') || a.parentId) === targetParentId);
    const existingAcsUnderParent = existingAcs.filter((a) => a.parentId === targetParentId && !matchedExistingIds.has(a.id));
    if (newAcsUnderParent.length === existingAcsUnderParent.length) {
      const newIndex = newAcsUnderParent.indexOf(newAc);
      if (newIndex !== -1 && newIndex < existingAcsUnderParent.length) {
        const candidate = existingAcsUnderParent[newIndex];
        if (candidate) {
          bindMatch(newAc, candidate);
          unmatchedNewAcs.delete(newAc);
        }
      }
    }
  }

  for (const newAc of unmatchedNewAcs) {
    newAc.diffStatus = 'added';
  }

  // --- TIER 4: Rewrite parent references through stableIdMap ---
  for (const item of newItems) {
    if (item.parentId && stableIdMap.has(item.parentId)) {
      item.parentId = stableIdMap.get(item.parentId)!;
    }
  }

  // --- TIER 5: Detect truly deprecated items (present in v1 but removed in v2) ---
  let deprecatedCount = 0;
  for (const existing of existingRequirements) {
    if (!matchedExistingIds.has(existing.id)) {
      deprecatedCount++;
      newItems.push({
        id: existing.id,
        title: existing.title,
        description: existing.description,
        level: existing.level,
        parentId: existing.parentId,
        isFlow: existing.isFlow,
        flowType: existing.flowType,
        sourceAnchor: existing.sourceAnchor || undefined,
        diffStatus: 'deprecated',
      });
    }
  }

  return { items: newItems, deprecatedCount };
}

const AI_CHUNK_CHARS = 30000; // per-call budget for the AI structuring path

/**
 * Splits long extracted text into heading-aligned parts so the AI structuring
 * call always sees complete epic/story sections instead of a hard character
 * cut (which silently dropped the tail of large documents).
 * Major headings (# Epic or ## Story) are used as split boundaries so ACs (####)
 * are never detached from their parent stories.
 */
function splitForAI(text: string, target: number): string[] {
  if (text.length <= target) return [text];
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    // Only split on major headings (# Epic or ## Story), never on ACs (####)
    const isMajorHeading = /^#{1,2}\s/.test(line);
    if (current.length > 0 && size + line.length + 1 > target && isMajorHeading) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Local heuristic parser for 3-column XLSX spreadsheets when AI is not configured or fails.
 */
export function parseXlsxHeuristic(buffer: Buffer): { rawItems: any[]; warnings: string[] } {
  const rawItems: any[] = [];
  const warnings: string[] = [];
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rawItems, warnings: ['Empty workbook: no sheets found'] };
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { header: 1, defval: '' }) as any[][];

  if (rows.length === 0) return { rawItems, warnings };

  let headerIdx = 0;
  let epicCol = 0;
  let storyCol = 1;
  let acCol = 2;

  // Sniff header row with word boundaries to avoid false positives (e.g. "Account" matching "ac")
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r].map((c) => String(c).trim());
    const eIdx = row.findIndex((c) => /模块|系统/i.test(c) || /\b(?:epic|module)\b/i.test(c));
    const sIdx = row.findIndex((c) => /功能|需求/i.test(c) || /\b(?:story|feature)\b/i.test(c));
    const aIdx = row.findIndex((c) => /验收|规则|准则/i.test(c) || /\b(?:ac|criteria|acceptance)\b/i.test(c));
    if (eIdx !== -1 || sIdx !== -1 || aIdx !== -1) {
      headerIdx = r;
      if (eIdx !== -1) epicCol = eIdx;
      if (sIdx !== -1) storyCol = sIdx;
      if (aIdx !== -1) acCol = aIdx;
      break;
    }
  }

  let currentEpicTempId: string | null = null;
  let currentStoryTempId: string | null = null;
  let tempCounter = 1;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c).trim())) continue;

    const epicVal = String(row[epicCol] || '').trim();
    const storyVal = String(row[storyCol] || '').trim();
    const acVal = String(row[acCol] || '').trim();

    // New Epic
    if (epicVal && (!currentEpicTempId || rawItems.find((i) => i.tempId === currentEpicTempId)?.title !== epicVal)) {
      const epicTempId = `e_${tempCounter++}`;
      currentEpicTempId = epicTempId;
      currentStoryTempId = null;
      rawItems.push({
        tempId: epicTempId,
        title: epicVal,
        description: `Epic: ${epicVal}`,
        level: 'epic',
        parentTempId: null,
        sourceAnchor: `Row ${r + 1}`,
      });
    }

    // New Story
    if (storyVal && (!currentStoryTempId || rawItems.find((i) => i.tempId === currentStoryTempId)?.title !== storyVal)) {
      const storyTempId = `s_${tempCounter++}`;
      currentStoryTempId = storyTempId;
      rawItems.push({
        tempId: storyTempId,
        title: storyVal,
        description: `Story: ${storyVal}`,
        level: 'story',
        parentTempId: currentEpicTempId,
        sourceAnchor: `Row ${r + 1}`,
      });
    }

    // AC row
    if (acVal) {
      const isGherkin = /^given\b/i.test(acVal.trim());
      rawItems.push({
        tempId: `a_${tempCounter++}`,
        title: acVal.slice(0, 80),
        description: isGherkin
          ? acVal
          : `Given the system is ready\nWhen ${acVal}\nThen ${acVal}`,
        level: 'ac',
        flowType: 'atomic',
        parentTempId: currentStoryTempId || currentEpicTempId,
        sourceAnchor: `Row ${r + 1}`,
      });
    }
  }

  return { rawItems, warnings };
}

export async function parsePrdDocument(opts: ParsePrdOptions): Promise<PrdParsePreviewResult> {
  const { fileName, buffer, projectId, documentTitle, providerConfigId, model } = opts;
  const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
  const fileType = (fileExt === 'xlsx' || fileExt === 'xls')
    ? 'xlsx'
    : (fileExt === 'csv' ? 'csv' : (fileExt === 'md' ? 'markdown' : 'docx'));

  let extractedText = '';
  let rawItems: any[] = [];
  const allWarnings: string[] = [];

  Log.for('prd-parser').info(`Parsing PRD: ${fileName} (${fileType}, ${buffer.length} bytes)`);

  // 1. Text extraction based on file type
  if (fileType === 'docx') {
    try {
      const res = await (mammoth as any).convertToMarkdown({ buffer });
      // Mammoth escapes hyphens, dots, asterisks etc. (\- -> -) which breaks literal title matches
      extractedText = (res.value || '').replace(/\\([-_*.`~])/g, '$1');
    } catch (e: any) {
      Log.for('prd-parser').warn(`Mammoth markdown extraction failed, falling back to raw text: ${e.message}`);
      const rawRes = await (mammoth as any).extractRawText({ buffer });
      extractedText = rawRes.value;
    }
  } else if (fileType === 'xlsx') {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames[0] || 'Sheet1';
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' }) as any[][];
      const textLines: string[] = [];
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.every((c) => !String(c).trim())) continue;
        const lineContent = row.map((c) => String(c).trim()).filter(Boolean).join(' | ');
        textLines.push(`[Row ${r + 1}] ${lineContent}`);
      }
      extractedText = textLines.join('\n');
    } catch (e: any) {
      Log.for('prd-parser').warn(`XLSX text extraction failed: ${e.message}`);
    }
  } else if (fileType === 'csv') {
    const rawCsv = buffer.toString('utf-8');
    const lines = rawCsv.split('\n');
    extractedText = lines
      .map((line, idx) => {
        const trimmed = line.trim();
        return trimmed ? `[Row ${idx + 1}] ${trimmed}` : '';
      })
      .filter(Boolean)
      .join('\n');
  } else {
    // Markdown
    extractedText = buffer.toString('utf-8');
  }

  // 2. Full AI Structuring (all formats go through AI when providerConfigId is provided)
  if (extractedText && providerConfigId) {
    try {
      const providerConfig = providerConfigRepo.get(providerConfigId);
      if (providerConfig) {
        const provider = createAIProvider({
          ...providerConfig,
          apiKey: decryptApiKey(providerConfig.encryptedApiKey),
          model: model || providerConfig.model,
        } as any);

        const isTabular = fileType === 'xlsx' || fileType === 'csv';
        const systemPrompt = `You are a Senior QA Architect and Agile Business Analyst.
Analyze the provided PRD content (${fileType.toUpperCase()}) and extract a structured hierarchy of requirements:
- Epics (top-level system modules)
- Stories (user stories under an Epic. Format description as Agile user story: "As a [role], I want [action], So that [benefit]")
- Acceptance Criteria (ACs under a Story. Format description strictly as Gherkin: "Given [precondition]\\nWhen [action]\\nThen [expected result]")

Important Instructions for Traceability & Stability:
${isTabular ? '- The input has rows prefixed with "[Row N]". Set "sourceAnchor" to the exact originating row (e.g. "Row 2", "Row 14").' : '- For document headings/sections, set "sourceAnchor" to the exact heading (e.g. "## 1.1 SMS Login" or "Section 2.1").'}
- When the input text already contains Acceptance Criteria or rules in Given/When/Then or structured steps, PRESERVE THE EXACT TEXT VERBATIM. Do not paraphrase or alter existing phrasing.
- For Epics and Stories, extract the exact title as written in the source document.
- Only transform informal or plain text acceptance notes into Gherkin when not already formatted.

Output strictly valid JSON with this shape:
{
  "items": [
    {
      "tempId": "e1",
      "level": "epic",
      "title": "Epic Title",
      "description": "Epic description",
      "sourceAnchor": "${isTabular ? 'Row 2' : '# Authentication'}"
    },
    {
      "tempId": "s1",
      "parentTempId": "e1",
      "level": "story",
      "title": "Story Title",
      "description": "As a [role], I want [action], So that [benefit]",
      "isFlow": false,
      "sourceAnchor": "${isTabular ? 'Row 3' : '## Login Page'}"
    },
    {
      "tempId": "a1",
      "parentTempId": "s1",
      "level": "ac",
      "title": "AC Title",
      "description": "Given ...\\nWhen ...\\nThen ...",
      "flowType": "atomic",
      "sourceAnchor": "${isTabular ? 'Row 4' : 'Criteria 1'}"
    }
  ]
}`;

        const chunks = splitForAI(extractedText, AI_CHUNK_CHARS);
        const mergedItems: any[] = [];
        for (let ci = 0; ci < chunks.length; ci++) {
          const userPrompt = `PRD Document (${fileName}), part ${ci + 1}/${chunks.length}:\n\n${chunks[ci]}`;

          let responseText = '';
          for await (const chunk of provider.streamChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ], { responseFormat: 'json_object', temperature: 0 })) {
            if (chunk.type === 'content' && chunk.content) {
              responseText += chunk.content;
            }
          }

          let cleanResponse = responseText.trim();
          if (cleanResponse.startsWith('```')) {
            cleanResponse = cleanResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          }
          let parsed: any;
          try {
            parsed = JSON.parse(cleanResponse || '{}');
          } catch {
            const { jsonrepair } = await import('jsonrepair');
            parsed = JSON.parse(jsonrepair(cleanResponse) || '{}');
          }

          if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
            throw new Error(`AI structuring returned no items for part ${ci + 1}/${chunks.length}`);
          }
          // Namespace per-chunk tempIds so they cannot collide across parts
          for (const item of parsed.items) {
            if (item.tempId !== undefined) item.tempId = `c${ci}_${item.tempId}`;
            if (item.parentTempId !== undefined) item.parentTempId = `c${ci}_${item.parentTempId}`;
          }
          mergedItems.push(...parsed.items);
        }

        if (mergedItems.length > 0) {
          rawItems = mergedItems;
        }
      } else {
        allWarnings.push(`AI provider config "${providerConfigId}" not found. Fell back to heuristic parser.`);
      }
    } catch (err: any) {
      Log.for('prd-parser').error(`AI structuring call failed: ${err.message}`);
      allWarnings.push(`AI structuring call failed (${err.message}). Fell back to heuristic parser.`);
    }
  }

  // 3. Heuristic Fallback (if rawItems still empty because no provider configured or AI failed)
  if (rawItems.length === 0) {
    if (fileType === 'xlsx') {
      const xlsxResult = parseXlsxHeuristic(buffer);
      rawItems = xlsxResult.rawItems;
      if (xlsxResult.warnings.length > 0) {
        allWarnings.push(...xlsxResult.warnings);
      }
    } else if (fileType === 'csv') {
      const csvResult = parseCsvRequirements(buffer.toString('utf-8'), projectId);
      if (csvResult.warnings.length > 0) {
        allWarnings.push(...csvResult.warnings);
      }
      rawItems = csvResult.requirements.map((r, i) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        level: r.level,
        parentId: r.parentId,
        sourceAnchor: `Row ${i + 2}`,
      }));
    } else {
      // docx or markdown
      if (extractedText) {
        const mdResult = parseMarkdownRequirements(extractedText, projectId);
        if (mdResult.warnings.length > 0) {
          allWarnings.push(...mdResult.warnings);
        }
        rawItems = mdResult.requirements.map((r, i) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          level: r.level,
          parentId: r.parentId,
          sourceAnchor: `Heading: ${r.title}`,
        }));
      }
    }
  }

  // 3. Compile Gate Validation
  const compileResult = compilePrdGate(rawItems, fileType === 'xlsx' ? 'Row' : 'Heading');
  allWarnings.push(...compileResult.warnings);
  let items = compileResult.items;

  // 4. Diff Calculation (Anchor-first + Title fallback + Deprecated detection)
  const existingReqs = opts.existingRequirements || [];
  computePrdDiff(items, existingReqs);

  // 5. Version Tag calculation (prioritize explicit version in filename or snippet)
  let versionTag = extractVersionTag(fileName, fileType === 'markdown' ? buffer.toString('utf-8', 0, 500) : undefined);
  if (!versionTag) {
    if (opts.existingVersionsCount !== undefined && opts.existingVersionsCount > 0) {
      versionTag = `v1.${opts.existingVersionsCount}`;
    } else if (existingReqs.length > 0) {
      versionTag = 'v1.1';
    } else {
      versionTag = 'v1.0';
    }
  }

  const rawTitle = documentTitle || fileName.replace(/\.[^/.]+$/, '');
  const finalDocTitle = cleanDocumentTitle(rawTitle);

  const epics = items.filter((i) => i.level === 'epic').length;
  const stories = items.filter((i) => i.level === 'story').length;
  const acs = items.filter((i) => i.level === 'ac').length;
  const added = items.filter((i) => i.diffStatus === 'added').length;
  const modified = items.filter((i) => i.diffStatus === 'modified').length;
  const deprecated = items.filter((i) => i.diffStatus === 'deprecated').length;
  const unchanged = items.filter((i) => i.diffStatus === 'unchanged').length;

  return {
    fileName,
    fileSize: buffer.length,
    fileType,
    documentTitle: finalDocTitle,
    versionTag,
    items,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    stats: {
      total: items.length,
      epics,
      stories,
      acs,
      added,
      modified,
      deprecated,
      unchanged,
    },
  };
}
