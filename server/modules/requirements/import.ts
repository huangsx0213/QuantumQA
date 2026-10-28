import type { Requirement } from '../../shared/contracts/index.ts';
import { normalizeRequirement } from './mapper.ts';
import { randomId } from '../../shared/utils/index.ts';

interface ImportResult {
  imported: number;
  requirements: Requirement[];
  warnings: string[];
}

const headingToLevel: Record<number, Requirement['level']> = {
  0: 'epic',
  1: 'story',
  2: 'story',
  3: 'ac',
};

export function parseMarkdownRequirements(markdown: string, projectId: string): ImportResult {
  const lines = markdown.split('\n');
  const requirements: Requirement[] = [];
  const levelStack: { level: number; id: string; levelName: Requirement['level'] }[] = [];
  const warnings: string[] = [];
  let currentReq: Partial<Requirement> | null = null;
  let descriptionLines: string[] = [];
  let inAcSectionForStoryId: string | null = null;

  function flushCurrent() {
    if (!currentReq) return;
    currentReq.description = descriptionLines.join('\n').trim();
    requirements.push(normalizeRequirement(currentReq));
    currentReq = null;
    descriptionLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = line.match(/^(#{1,})\s+(.+)/);

    if (headingMatch) {
      flushCurrent();
      const hashCount = headingMatch[1].length;
      const level = hashCount - 1;
      const title = headingMatch[2].trim();

      // Check if this heading is just an "Acceptance Criteria" section header under a story
      if (/^acceptance criteria$/i.test(title)) {
        // Find the closest story in levelStack
        const storyInStack = [...levelStack].reverse().find((item) => item.levelName === 'story');
        if (storyInStack) {
          inAcSectionForStoryId = storyInStack.id;
          continue;
        }
      } else {
        inAcSectionForStoryId = null;
      }

      let resolvedLevel = headingToLevel[level] || 'story';
      if (!headingToLevel[level]) {
        warnings.push(`Line "${line}" has ${hashCount} heading markers, exceeding max depth 4. Falling back to "story" level.`);
      }

      // If heading title specifically denotes an AC (e.g. "### AC 1: ...", "### AC: ...", "### Given ...")
      if (/^(?:ac(?:\s*\d+)?[:.-]|given\b)/i.test(title)) {
        resolvedLevel = 'ac';
      }

      while (levelStack.length > 0 && levelStack[levelStack.length - 1].level >= level) {
        levelStack.pop();
      }
      const parentId = levelStack.length > 0 ? levelStack[levelStack.length - 1].id : undefined;

      if (levelStack.length === 0 && level > 0) {
        warnings.push(`"${title}" (level ${resolvedLevel}) has no parent — imported as a root node.`);
      }

      const id = randomId('req');
      currentReq = { id, projectId, parentId, title, level: resolvedLevel };
      levelStack.push({ level, id, levelName: resolvedLevel });
    } else if (trimmed) {
      // Check for bullet acceptance criteria under a story
      const isBullet = /^[-*]\s+(.+)/.test(trimmed);
      const isExplicitAcBullet = /^[-*]\s+(?:(?:(?:\[\s*\]\s*)?AC(?:\s*\d+)?[:.-]?\s*)|(?:Given\s+.*))/i.test(trimmed);

      const targetStoryId = inAcSectionForStoryId || (currentReq && currentReq.level === 'story' ? currentReq.id : null);

      if (targetStoryId && (isExplicitAcBullet || (inAcSectionForStoryId && isBullet))) {
        // Extract bullet text
        const rawContent = trimmed.replace(/^[-*]\s+/, '');
        const cleanTitle = rawContent.replace(/^\[\s*\]\s*/, '').trim();

        const acId = randomId('req');
        requirements.push(
          normalizeRequirement({
            id: acId,
            projectId,
            parentId: targetStoryId,
            title: cleanTitle.length > 120 ? cleanTitle.slice(0, 117) + '...' : cleanTitle,
            description: cleanTitle,
            level: 'ac',
            status: 'DRAFT',
          })
        );
      } else if (currentReq) {
        descriptionLines.push(trimmed);
      }
    }
  }
  flushCurrent();

  return { imported: requirements.length, requirements, warnings };
}

export function parseCsvRequirements(csvText: string, projectId: string): ImportResult {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { imported: 0, requirements: [], warnings: [] };

  const headers = lines[0].split(',').map(h => h.trim());
  const requirements: Requirement[] = [];
  const titleToId: Record<string, string> = {};
  const warnings: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => { record[h] = values[idx] || ''; });

    if (!record.title) {
      warnings.push(`Row ${i + 1} is missing a title — skipped.`);
      continue;
    }

    const id = randomId('req');
    titleToId[record.title] = id;

    let parentId: string | undefined;
    if (record.parent_title) {
      if (titleToId[record.parent_title]) {
        parentId = titleToId[record.parent_title];
      } else {
        warnings.push(`Row "${record.title}" references parent "${record.parent_title}" which was not found — imported as a root node.`);
      }
    }

    requirements.push(normalizeRequirement({
      id,
      projectId,
      parentId,
      title: record.title,
      description: record.description || '',
      level: (record.level || 'story') as Requirement['level'],
    }));
  }

  return { imported: requirements.length, requirements, warnings };
}