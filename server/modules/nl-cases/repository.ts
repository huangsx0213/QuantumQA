import type { NlTestCase, NlTestCaseStep, NlTestCaseTestData } from '../../shared/contracts/index.ts';
import { db } from '../../shared/db/client.ts';
import { BaseCrudRepository } from '../../shared/db/BaseCrudRepository.ts';
import { randomId, asText } from '../../shared/utils/index.ts';

function normalizeTestDataEntry(d: unknown): NlTestCaseTestData {
  if (typeof d === 'string') {
    // LLM 生成格式：key = value (description) 或 key: value (description)
    // 同时支持 : 和 = 两种分隔符（prompt 示例用 =，协议兼容 :）
    const sep = d.indexOf('=') >= 0 ? d.indexOf('=') : d.indexOf(':');
    if (sep > 0) {
      const key = d.slice(0, sep).trim();
      const rest = d.slice(sep + 1).trim();
      // 提取括号内的 description：value (description) → value + description
      const parenMatch = rest.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
      if (parenMatch) {
        return { key, value: parenMatch[1].trim(), description: parenMatch[2].trim() };
      }
      return { key, value: rest, description: '' };
    }
    return { key: d, value: '', description: '' };
  }
  const obj = (d || {}) as Record<string, unknown>;
  return { key: asText(obj.key), value: asText(obj.value), description: asText(obj.description) };
}

function normalizeStep(s: unknown): NlTestCaseStep {
  const obj = (s || {}) as Record<string, unknown>;
  return {
    sequence: (obj.sequence as number) ?? (obj.stepNumber as number) ?? 0,
    action: asText(obj.action),
    expected: asText(obj.expected),
    // 统一测试标准（docs/08）：结构化意图必须随 NL 用例落库，
    // 否则 AI 录制器无 intent 可消费，编译回退旧推断链路。
    ...(obj.intent && typeof obj.intent === 'object' ? { intent: obj.intent as NlTestCaseStep['intent'] } : {}),
  };
}

type DbNlCaseRow = {
  id: string;
  project_id: string;
  title: string;
  requirement_id: string | null;
  condition_id: string | null;
  technique_applied: string | null;
  priority: string;
  category: string | null;
  test_level: string | null;
  preconditions: string;
  test_data: string;
  steps: string;
  postconditions: string;
  tags: string;
  self_review: string | null;
  review_summary: string | null;
  change_log: string;
  status: string;
  generated_suite_id: string | null;
};

class NlCaseRepository extends BaseCrudRepository<NlTestCase> {
  protected table = 'natural_language_test_cases';

  list(): NlTestCase[] {
    const rows = db.prepare('SELECT id FROM natural_language_test_cases ORDER BY rowid').all() as Array<{ id: string }>;
    return rows.map(r => this.get(r.id)).filter(Boolean) as NlTestCase[];
  }

  listByProject(projectId: string): NlTestCase[] {
    const rows = db.prepare(
      'SELECT id FROM natural_language_test_cases WHERE project_id = ? ORDER BY rowid'
    ).all(projectId) as Array<{ id: string }>;
    return rows.map(r => this.get(r.id)).filter(Boolean) as NlTestCase[];
  }

  remove(id: string): void {
    db.prepare('DELETE FROM natural_language_test_cases WHERE id = ?').run(id);
  }

  get(id: string): NlTestCase | undefined {
    const row = db.prepare('SELECT * FROM natural_language_test_cases WHERE id = ?').get(id) as DbNlCaseRow | undefined;
    if (!row) return undefined;
    return this.rowToCase(row);
  }

  save(record: Partial<NlTestCase>): NlTestCase {
    const id = record.id || randomId('nlc');
    db.prepare(`
      INSERT INTO natural_language_test_cases (id, project_id, title, requirement_id, condition_id, technique_applied, priority, category, test_level, preconditions, test_data, steps, postconditions, tags, self_review, review_summary, change_log, status, generated_suite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        requirement_id = excluded.requirement_id,
        condition_id = excluded.condition_id,
        technique_applied = excluded.technique_applied,
        priority = excluded.priority,
        category = excluded.category,
        test_level = excluded.test_level,
        preconditions = excluded.preconditions,
        test_data = excluded.test_data,
        steps = excluded.steps,
        postconditions = excluded.postconditions,
        tags = excluded.tags,
        self_review = excluded.self_review,
        review_summary = excluded.review_summary,
        change_log = excluded.change_log,
        status = excluded.status,
        generated_suite_id = excluded.generated_suite_id,
        updated_at = datetime('now')
    `).run(
      id,
      record.projectId || '',      record.title || '',
      record.requirementId || null,
      record.conditionId || null,
      record.techniqueApplied || null,
      record.priority || 'medium',
      record.category || null,
      record.testLevel || null,
      JSON.stringify(record.preconditions || []),
      JSON.stringify(record.testData || []),
      JSON.stringify(record.steps || []),
      JSON.stringify(record.postconditions || []),
      JSON.stringify(record.tags || []),
      record.selfReview ? JSON.stringify(record.selfReview) : null,
      record.reviewSummary || null,
      JSON.stringify(record.changeLog || []),
      record.status || 'DRAFT',
      record.generatedSuiteId || null,
    );
    return this.get(id)!;
  }

  rowToCase(row: DbNlCaseRow): NlTestCase {
    const rawTestData = JSON.parse(row.test_data || '[]');
    const rawSteps = JSON.parse(row.steps || '[]');
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      requirementId: row.requirement_id || undefined,
      conditionId: row.condition_id || undefined,
      techniqueApplied: row.technique_applied || undefined,
      priority: row.priority as NlTestCase['priority'],
      category: row.category || undefined,
      testLevel: (row.test_level as NlTestCase['testLevel']) || undefined,
      preconditions: JSON.parse(row.preconditions || '[]'),
      testData: Array.isArray(rawTestData) ? rawTestData.map(normalizeTestDataEntry) : [],
      steps: Array.isArray(rawSteps) ? rawSteps.map(normalizeStep) : [],
      postconditions: JSON.parse(row.postconditions || '[]'),
      tags: JSON.parse(row.tags || '[]'),
      selfReview: row.self_review ? JSON.parse(row.self_review) : undefined,
      reviewSummary: row.review_summary || undefined,
      changeLog: JSON.parse(row.change_log || '[]'),
      status: row.status as NlTestCase['status'],
      generatedSuiteId: row.generated_suite_id || undefined,
    };
  }
}

export const nlCaseRepo = new NlCaseRepository();