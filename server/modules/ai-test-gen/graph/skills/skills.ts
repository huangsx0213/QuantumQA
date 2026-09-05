import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SkillDefinition } from '../nodes/types.ts';
import type { BatchRequirement } from '../state.ts';
import {
  makeRequirementDetailQuery,
  makeRequirementGraphQuery,
  makeFlowDetailQuery,
  makeCrossEpicImpactQuery,
  makePreviousBatchConditionsQuery,
  makePreviousBatchCasesQuery,
  type RequirementSkillRepository,
} from './data-skills.ts';
import { declareCaseSkill, declareStepSkill } from './declare-step-skill.ts';
import { Log } from '../../../../shared/services/logger.ts';
import {
  makeHtmlKnowledgeQuery,
  type ResolvedHtmlKnowledgeRuntime,
} from './html-knowledge.ts';
import { requirementsFromHtmlSnapshot } from '../../html-knowledge/requirement-snapshot.ts';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

// ============================================================
// Knowledge Skill Factory
// ============================================================

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the frontmatter fields and the body (content after the closing `---`).
 * If no frontmatter is present, returns an empty object and the original content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const [, rawFm, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of rawFm.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/**
 * Create a Knowledge Skill from a Markdown file following Anthropic's
 * standard SKILL.md format. The file name becomes the skill name
 * (stripped of .md suffix, hyphens → underscores). The description is
 * read from the YAML frontmatter; if absent, a generic one is generated
 * from the file name. The frontmatter is stripped from the body before
 * returning the content to the LLM.
 */
function createKnowledgeSkill(mdFilePath: string): SkillDefinition {
  const fileName = basename(mdFilePath, '.md');
  const skillName = fileName.replace(/-/g, '_');

  // Read once at registration time: extract frontmatter for description,
  // cache the body (without frontmatter) for runtime invocation.
  const rawContent = readFileSync(mdFilePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(rawContent);

  // Use frontmatter description if available; otherwise generate from filename
  const description = frontmatter.description ?? (() => {
    const label = fileName
      .replace(/^istqb_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `Load the "${label}" knowledge guide. Use when you need detailed methodology, steps, examples, or common mistakes for this technique or domain topic.`;
  })();

  // 每 run 单次加载缓存：知识文件是静态内容，且 prompt 强制 LLM 调用（MANDATORY）。
  // 实测 LLM 在同一次 ReAct 中会重复调用（designer_rules 曾加载 2 次 = 45k chars，
  // 白白进上下文）。第二次起返回简短 ack，引用首次加载的内容即可。
  let loadedOnce = false;

  return {
    name: skillName,
    description,
    schema: z.object({
      context: z
        .string()
        .optional()
        .describe('Brief context of what you are testing, to get tailored guidance'),
    }),
    func: async ({ context }) => {
      if (loadedOnce) {
        Log.for(`skill:${skillName}`).info(`already loaded this run — ack (saved ${body.length} chars)`);
        return `(${skillName} already loaded above — the full rules are in your context. Do not reload; continue.)`;
      }
      loadedOnce = true;
      Log.for(`skill:${skillName}`).info(`Loaded (${body.length} chars)${context ? `, context: ${String(context).slice(0, 60)}` : ''}`);
      return context ? `${body}\n\n---\nApplying to your context: ${context}` : body;
    },
  };
}

/**
 * Scan the knowledge directory and auto-register all .md files as Knowledge Skills.
 * Excludes individual ISTQB technique guides (already merged into the unified istqb_guide).
 *
 * 返回工厂（而非共享实例）：knowledge skill 内含"每 run 单次加载"缓存闭包。
 * 若在模块级共享实例，缓存会跨 run 泄漏（run A 加载过 → run B 误以为已加载，
 * 而 run B 上下文中其实没有内容）。每次 build*Skills 调用 create() 得到新实例。
 */
function loadKnowledgeSkills(): Array<{ name: string; create: () => SkillDefinition }> {
  const knowledgeDir = join(__dirname, 'knowledge');
  try {
    const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.md') && !f.startsWith('istqb-'));
    return files.map((f) => {
      const path = join(knowledgeDir, f);
      const name = createKnowledgeSkill(path).name;
      return { name, create: () => createKnowledgeSkill(path) };
    });
  } catch (err: any) {
    Log.for('skills').warn(`Knowledge directory not found or empty (${knowledgeDir}): ${err.message}`);
    return [];
  }
}

/**
 * Combined ISTQB technique guides: loads all ISTQB technique documents in one call.
 */
const ISTQB_GUIDE_FILES = [
  'istqb-equivalence-partitioning.md',
  'istqb-boundary-value-analysis.md',
  'istqb-decision-table.md',
  'istqb-state-transition.md',
  'istqb-use-case-testing.md',
  'istqb-integration-testing.md',
];

function normalizeTechniqueLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/^istqb[\s_-]*/, '')
    .replace(/\bguide\b/g, '')
    .replace(/\btechnique\b/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTechniqueAliases(value: string): string[] {
  const normalized = normalizeTechniqueLabel(value);
  const aliases = new Set<string>([normalized]);
  if (normalized.endsWith(' testing')) {
    aliases.add(normalized.slice(0, -' testing'.length).trim());
  }
  return Array.from(aliases);
}

// Cache ISTQB guide file contents at registration time — files are static,
// avoids repeated readFileSync on every LLM skill invocation.
const _istqbKnowledgeDir = join(__dirname, 'knowledge');
const _istqbOverviewBody = parseFrontmatter(readFileSync(join(_istqbKnowledgeDir, 'istqb-overview.md'), 'utf-8')).body;
const _istqbGuideBodies: Record<string, string> = {};
for (const f of ISTQB_GUIDE_FILES) {
  _istqbGuideBodies[f] = parseFrontmatter(readFileSync(join(_istqbKnowledgeDir, f), 'utf-8')).body;
}

// 每 run 已加载的 istqb_guide 请求集（按 techniques 规范化键），避免 LLM 重复
// 请求同一批指南时全量重发（实测单 run 重复加载，Analyst 一次拉全 6 本 33k chars）。
// 注意：缓存放工厂函数闭包内，每次 buildSkills 新建实例 —— 避免跨 run 泄漏
//（run A 加载过 ≠ run B 上下文里已有内容）。
function createIstqbGuideSkill(): SkillDefinition {
  const loadedGuideSets = new Set<string>();
  return {
  name: 'istqb_guide',
  description: 'Load ISTQB technique guide(s). Pass the SPECIFIC techniques/test levels you need (e.g. ["Equivalence Partitioning"]) — each run, load ONLY the 1-2 techniques your conditions actually use; loading all 6 wastes context. Use when you need methodology, steps, examples, or common mistakes for a test design technique or test level.',
  schema: z.object({
    techniques: z
      .array(z.string())
      .optional()
      .describe('Specific techniques or test levels to focus on (omit to load the compact overview only)'),
    context: z
      .string()
      .optional()
      .describe('Brief context of what you are testing'),
  }),
  func: async ({ techniques, context }) => {
    const requestedTechniqueAliases = Array.isArray(techniques)
      ? techniques.flatMap((technique) => buildTechniqueAliases(String(technique)))
      : [];

    // 每 run 按 techniques 集缓存：LLM 常在同一次 ReAct 中重复调用 istqb_guide
    //（实测 designer 2 次、analyst 曾一次加载 6/6 指南 33k chars）。相同请求集
    // 第二次起返回 ack，避免同样的指南重复进上下文。
    const cacheKey = requestedTechniqueAliases.length > 0
      ? [...requestedTechniqueAliases].sort().join('|')
      : '__overview__';
    if (loadedGuideSets.has(cacheKey)) {
      const ack = requestedTechniqueAliases.length > 0
        ? '(ISTQB guides for these techniques already loaded above — refer to them; do not reload.)'
        : '(ISTQB overview already loaded above — refer to it; do not reload.)';
      Log.for('skill:istqb_guide').info(`already loaded "${cacheKey}" this run — ack`);
      return ack;
    }
    loadedGuideSets.add(cacheKey);

    // P1: When no techniques specified, return only the compact overview
    // (decision table + selection rules). The LLM should call again with
    // specific techniques after deciding which ones to apply.
    if (!Array.isArray(techniques) || techniques.length === 0) {
      const overview = _istqbOverviewBody;
      Log.for('skill:istqb_guide').info(`Loaded overview only (${overview.length} chars) — call again with techniques for detailed guides`);
      return context
        ? `${overview}\n\n---\nApplying to your context: ${context}`
        : overview;
    }

    const selectedFiles = ISTQB_GUIDE_FILES.filter((f) => {
      const fileTechniqueName = f.replace(/^istqb-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
      const fileAliases = buildTechniqueAliases(fileTechniqueName);
      return requestedTechniqueAliases.some((requested) => fileAliases.includes(requested));
    });

    // 单次最多返回 3 本指南（实测 LLM 常一次请求 6/6 → 33.6k chars 全进上下文，
    // 占 token 大头）。超出时只返回前 3 本，并提示按需再请求——本 batch 若确实
    // 覆盖多种技术，LLM 可针对剩余技术单独调用（缓存保证不重复加载前 3 本）。
    const MAX_GUIDES_PER_CALL = 3;
    const served = selectedFiles.slice(0, MAX_GUIDES_PER_CALL);
    const dropped = selectedFiles.slice(MAX_GUIDES_PER_CALL);
    const parts = served.map((f) => _istqbGuideBodies[f]);
    const combined = parts.join('\n\n---\n\n');
    const loadNote = dropped.length > 0
      ? `\n\n(Loaded ${served.length}/${selectedFiles.length} requested guides — this call caps at ${MAX_GUIDES_PER_CALL}. If you still need ${dropped.map((f) => f.replace(/^istqb-/, '').replace(/\.md$/, '').replace(/-/g, ' ')).join(', ')}, call istqb_guide again with just that technique.)`
      : '';
    Log.for('skill:istqb_guide').info(`Loaded ${served.length}/${selectedFiles.length} guides (${combined.length} chars)${dropped.length > 0 ? `, capped ${dropped.length}` : ''}`);
    return context
      ? `${combined}${loadNote}\n\n---\nApplying to your context: ${context}`
      : `${combined}${loadNote}`;
  },
  };
}

// ============================================================
// Skill Groups
// ============================================================

// Registry of knowledge .md files — lazily scanned at import time.
// File CONTENTS are read on-demand when the skill function is invoked.
const knowledgeSkills = loadKnowledgeSkills();

/**
 * Skills bound to the Analyst: Data + ISTQB Guide + Knowledge Base.
 * Requires runId for historical logs and projectId for tenant-scoped data lookups.
 * Passes batchRequirements for requirement_detail_query fallback.
 */
export function buildAnalystSkills(
  runId: string,
  projectId: string,
  batchRequirements?: BatchRequirement[],
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime,
): SkillDefinition[] {
  const requirementRepository = snapshotRequirementRepository(htmlKnowledge);
  const cacheScope = requirementCacheScope(runId, projectId, htmlKnowledge);
  const skills: SkillDefinition[] = [
    makeRequirementDetailQuery(projectId, batchRequirements, requirementRepository, cacheScope),
    makeRequirementGraphQuery(projectId, requirementRepository),
    makeFlowDetailQuery(projectId, requirementRepository, cacheScope),
    makeCrossEpicImpactQuery(projectId, requirementRepository),
    makePreviousBatchConditionsQuery(runId, projectId, undefined, requirementRepository),
    createIstqbGuideSkill(),
    ...knowledgeSkills.filter((s) => s.name === 'analyst_rules').map((s) => s.create()),
  ];
  if (htmlKnowledge) {
    skills.push(makeHtmlKnowledgeQuery({
      runId,
      currentBatch: batchRequirements ?? [],
      runtime: htmlKnowledge,
    }));
  }
  return skills;
}

/**
 * Skills bound to the Designer: Data (subset) + ISTQB Guide + Knowledge Base.
 * Requires runId for historical logs and projectId for tenant-scoped data lookups.
 * Passes batchRequirements for requirement_detail_query fallback.
 */
export function buildDesignerSkills(
  runId: string,
  projectId: string,
  batchRequirements?: BatchRequirement[],
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime,
): SkillDefinition[] {
  const requirementRepository = snapshotRequirementRepository(htmlKnowledge);
  const cacheScope = requirementCacheScope(runId, projectId, htmlKnowledge);
  const skills: SkillDefinition[] = [
    makeRequirementDetailQuery(projectId, batchRequirements, requirementRepository, cacheScope),
    makeRequirementGraphQuery(projectId, requirementRepository),
    makeFlowDetailQuery(projectId, requirementRepository, cacheScope),
    makePreviousBatchCasesQuery(runId, projectId, undefined, requirementRepository),
    createIstqbGuideSkill(),
    ...knowledgeSkills.filter((s) => s.name === 'designer_rules').map((s) => s.create()),
    // Tool Use 强制结构化：verb 在 API 层 enum 强制，data/expectation 按 verb 配对强制。
    // LLM 写 step 必须通过 declare_step，无法写出非词表 verb。
    declareCaseSkill,
    declareStepSkill,
  ];
  if (htmlKnowledge) {
    skills.push(makeHtmlKnowledgeQuery({
      runId,
      currentBatch: batchRequirements ?? [],
      runtime: htmlKnowledge,
    }));
  }
  return skills;
}

/**
 * Skills bound to the Quality Manager: Data + Knowledge Base.
 * Requires runId for historical logs and projectId for tenant-scoped data lookups.
 * Passes batchRequirements for requirement_detail_query fallback.
 */
export function buildQualitySkills(
  runId: string,
  projectId: string,
  batchRequirements?: BatchRequirement[],
  htmlKnowledge?: ResolvedHtmlKnowledgeRuntime,
): SkillDefinition[] {
  const requirementRepository = snapshotRequirementRepository(htmlKnowledge);
  const cacheScope = requirementCacheScope(runId, projectId, htmlKnowledge);
  const skills: SkillDefinition[] = [
    makeRequirementDetailQuery(projectId, batchRequirements, requirementRepository, cacheScope),
    makeFlowDetailQuery(projectId, requirementRepository, cacheScope),
    makePreviousBatchCasesQuery(runId, projectId, undefined, requirementRepository),
    createIstqbGuideSkill(),
    ...knowledgeSkills.filter((s) => s.name === 'quality_rules').map((s) => s.create()),
  ];
  if (htmlKnowledge) {
    skills.push(makeHtmlKnowledgeQuery({
      runId,
      currentBatch: batchRequirements ?? [],
      runtime: htmlKnowledge,
    }));
  }
  return skills;
}

function snapshotRequirementRepository(
  htmlKnowledge: ResolvedHtmlKnowledgeRuntime | undefined,
): RequirementSkillRepository | undefined {
  if (!htmlKnowledge) return undefined;
  const requirements = requirementsFromHtmlSnapshot(htmlKnowledge.snapshot);
  return {
    listByProject: (projectId) => {
      if (projectId !== htmlKnowledge.projectId) {
        throw new Error('HTML knowledge requirement source belongs to another project');
      }
      return requirements;
    },
  };
}

function requirementCacheScope(
  runId: string,
  projectId: string,
  htmlKnowledge: ResolvedHtmlKnowledgeRuntime | undefined,
): string {
  return htmlKnowledge
    ? `${projectId}:${runId}:${htmlKnowledge.reference.knowledgeSetId}:${htmlKnowledge.reference.requirementSnapshotHash}`
    : projectId;
}

