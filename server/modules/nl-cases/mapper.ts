import type { NlTestCase, NlTestCaseStep, NlTestCaseTestData } from '../../shared/contracts/index.ts';
import { asId, asText, asArray } from '../../shared/utils/index.ts';

function normalizeTestDataEntry(d: unknown): NlTestCaseTestData {
  if (typeof d === 'string') {
    // LLM 生成格式：key = value (description) 或 key: value (description)
    const sep = d.indexOf('=') >= 0 ? d.indexOf('=') : d.indexOf(':');
    if (sep > 0) {
      const key = d.slice(0, sep).trim();
      const rest = d.slice(sep + 1).trim();
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
    // 统一测试标准（docs/08）：结构化意图必须随 NL 用例落库。
    ...(obj.intent && typeof obj.intent === 'object' ? { intent: obj.intent as NlTestCaseStep['intent'] } : {}),
  };
}

export function normalizeNlCase(input: Partial<NlTestCase>): NlTestCase {
  return {
    id: asId(input.id, 'nlc'),
    projectId: asText(input.projectId),
    title: asText(input.title, 'New Test Case'),
    requirementId: input.requirementId,
    conditionId: input.conditionId,
    techniqueApplied: input.techniqueApplied,
    priority: (input.priority || 'medium') as NlTestCase['priority'],
    category: input.category,
    testLevel: input.testLevel,
    preconditions: asArray(input.preconditions),
    testData: asArray(input.testData).map(normalizeTestDataEntry),
    steps: asArray(input.steps).map(normalizeStep),
    postconditions: asArray(input.postconditions),
    tags: asArray(input.tags),
    selfReview: input.selfReview,
    reviewSummary: input.reviewSummary,
    changeLog: input.changeLog || [],
    status: (input.status || 'DRAFT') as NlTestCase['status'],
    generatedSuiteId: input.generatedSuiteId,
  };
}