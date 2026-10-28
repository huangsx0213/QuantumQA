// Mirror of server/modules/requirements/format-parser.ts — keep in sync.
// Single source of truth would require a shared workspace package; mirroring is the
// current convention (see existing shared/contracts/index.ts which is also mirrored).
export interface StorySegments {
  role?: string;
  action?: string;
  value?: string;
  remainder: string;
  hasAllSegments: boolean;
}

export interface ACSegments {
  given?: string;
  when?: string;
  then?: string;
  remainder: string;
  hasAllSegments: boolean;
}

interface SegmentExtractor {
  captureGroup: (text: string) => string | null;
}

function buildSegmentExtractor(prefixes: string[]): SegmentExtractor {
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`^\\s*(?:${escaped.join('|')})\\s*?(?::|\\s+—\\s+)?(.+?)\\s*$`, 'i');
  return {
    captureGroup: (text: string) => {
      const match = text.match(pattern);
      return match ? match[1].trim() : null;
    },
  };
}

function parseSegments(
  md: string,
  extractors: { role: SegmentExtractor; action: SegmentExtractor; value: SegmentExtractor },
): { segments: { role?: string; action?: string; value?: string }; remainder: string } {
  const lines = md.split('\n');
  const segments: { role?: string; action?: string; value?: string } = {};
  const remainderLines: string[] = [];

  const tryCapture = (
    line: string,
    key: 'role' | 'action' | 'value',
    extractor: SegmentExtractor,
  ): boolean => {
    if (segments[key] !== undefined) return false;
    const captured = extractor.captureGroup(line);
    if (captured !== null) {
      segments[key] = captured;
      return true;
    }
    return false;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    const matched =
      tryCapture(line, 'role', extractors.role) ||
      tryCapture(line, 'action', extractors.action) ||
      tryCapture(line, 'value', extractors.value);
    if (!matched) remainderLines.push(line.trim());
  }

  return { segments, remainder: remainderLines.join('\n') };
}

const storyExtractors = {
  role: buildSegmentExtractor(['As an', 'As a', '作为(?:一个)?']),
  action: buildSegmentExtractor(['I want to', 'I want', '我想要', '我希望', '我想']),
  value: buildSegmentExtractor(['So that I can', 'So that we can', 'So that', '以便于?', '从而', '为了']),
};

const acExtractors = {
  role: buildSegmentExtractor(['Given', '假设', '前提']),
  action: buildSegmentExtractor(['When', '当', '如果']),
  value: buildSegmentExtractor(['Then', '那么', '则']),
};

function parseInlineStory(text: string): StorySegments | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Single-sentence or paragraph story:
  // "As a [role], I want to [action] so that [value]. [remainder...]"
  // Supports punctuation variants (commas, em-dashes, periods)
  const regex = /^\s*(?:As\s+an?|作为(?:一个)?)\s*[:—\-]?\s*(.+?)(?:,|\s+—)?\s+(?:I\s+want\s+to|I\s+want|我想要|我希望|我想)\s*[:—\-]?\s*(.+?)(?:,|\s+—)?\s+(?:So\s+that\s+(?:I|we)\s+can|So\s+that|以便于?|从而|为了)\s*[:—\-]?\s*([^.\n]+)(?:(?:\.|\n)\s*([\s\S]*))?$/i;

  const match = trimmed.match(regex);
  if (!match) return null;

  const role = match[1].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  const action = match[2].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  let value = match[3].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  let remainder = (match[4] || '').trim();

  if (value.endsWith('.')) {
    value = value.slice(0, -1).trim();
  }

  return {
    role,
    action,
    value,
    remainder,
    hasAllSegments: !!(role && action && value),
  };
}

function parseInlineAC(text: string): ACSegments | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const regex = /^\s*(?:Given|假设|前提)\s*[:—\-]?\s*(.+?)(?:,|\s+—)?\s+(?:When|当|如果)\s*[:—\-]?\s*(.+?)(?:,|\s+—)?\s+(?:Then|那么|则)\s*[:—\-]?\s*([^.\n]+)(?:(?:\.|\n)\s*([\s\S]*))?$/i;
  const match = trimmed.match(regex);
  if (!match) return null;

  const given = match[1].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  const when = match[2].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  let then = match[3].trim().replace(/^[:,—\-]\s*/, '').replace(/[,—\-]$/, '').trim();
  let remainder = (match[4] || '').trim();

  if (then.endsWith('.')) then = then.slice(0, -1).trim();

  return {
    given,
    when,
    then,
    remainder,
    hasAllSegments: !!(given && when && then),
  };
}

export function parseStoryMarkdown(md: string): StorySegments {
  // 1. Try multi-line parsing first
  const { segments, remainder } = parseSegments(md, storyExtractors);
  if (segments.role && segments.action && segments.value) {
    return {
      role: segments.role,
      action: segments.action,
      value: segments.value,
      remainder,
      hasAllSegments: true,
    };
  }

  // 2. Try inline single-sentence/paragraph story parsing
  const inline = parseInlineStory(md);
  if (inline && inline.hasAllSegments) {
    return inline;
  }

  // 3. Fallback: if inline captured more, use it; else return multiline parse result
  if (inline && (inline.role || inline.action || inline.value)) {
    return inline;
  }

  return {
    role: segments.role,
    action: segments.action,
    value: segments.value,
    remainder,
    hasAllSegments: false,
  };
}

export function parseACMarkdown(md: string): ACSegments {
  // 1. Try multi-line parsing first
  const { segments, remainder } = parseSegments(md, acExtractors);
  if (segments.role && segments.action && segments.value) {
    return {
      given: segments.role,
      when: segments.action,
      then: segments.value,
      remainder,
      hasAllSegments: true,
    };
  }

  // 2. Try inline single-sentence/paragraph AC parsing
  const inline = parseInlineAC(md);
  if (inline && inline.hasAllSegments) {
    return inline;
  }

  return {
    given: segments.role,
    when: segments.action,
    then: segments.value,
    remainder,
    hasAllSegments: false,
  };
}
