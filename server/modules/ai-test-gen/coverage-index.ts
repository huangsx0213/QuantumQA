import type { PreviousBatchCoverageSummary } from './graph/state.ts';

// ============================================================
// CoverageIndex —— run 作用域的键控覆盖记忆
//
// 单一来源：跨批次/跨运行的覆盖摘要、组件条件明细、用例明细都从这里按键查询，
// 取代"每次全量扫 agent_logs"。一次构建、批次后增量 upsert、O(1) 键查询。
// ============================================================

export interface ConditionSummaryInput {
  requirementId: string;
  category?: string;
  primaryTechnique?: string;
}

export interface CaseSummaryInput {
  requirementId?: string;
  testLevel?: string;
}

export interface IndexedComponentCondition {
  id: string;
  requirementId: string;
  condition: string;
  conditionType: string;
  category: string;
  primaryTechnique: string;
}

export interface IndexedCase {
  title: string;
  testLevel: string;
  conditionId: string;
  requirementId: string;
}

export interface ConditionInput {
  id: string;
  condition: string;
  requirementId: string;
  conditionType?: string;
  category?: string;
  primaryTechnique?: string;
}

export interface CaseInput {
  title?: string;
  testLevel?: string;
  conditionId?: string;
  requirementId?: string;
}

/**
 * 把一个 test condition 合并到覆盖摘要 Map（按 requirementId 聚合）。
 * 只增加 conditionCount / categories / techniques，不累积标题——明细由
 * componentConditionsFor 按需查询（P2 原则）。
 */
export function mergeConditionSummary(
  acc: Map<string, PreviousBatchCoverageSummary>,
  tc: ConditionSummaryInput,
): void {
  const reqId = tc.requirementId;
  if (!reqId) return;
  const category = tc.category ?? 'functional';
  const technique = tc.primaryTechnique ?? 'Unknown';
  const existing = acc.get(reqId);
  if (existing) {
    existing.conditionCount += 1;
    if (!existing.categories.includes(category)) existing.categories.push(category);
    if (!existing.techniques.includes(technique)) existing.techniques.push(technique);
  } else {
    acc.set(reqId, {
      requirementId: reqId,
      conditionCount: 1,
      categories: [category],
      techniques: [technique],
      caseCountByLevel: { component: 0, integration: 0 },
    });
  }
}

/**
 * 把一个 finalTestCase 合并到覆盖摘要 Map（按 requirementId 聚合），
 * 只按 testLevel 递增 caseCountByLevel 计数，明细由 casesFor 按需查询。
 */
export function mergeCaseSummary(
  acc: Map<string, PreviousBatchCoverageSummary>,
  tc: CaseSummaryInput,
): void {
  const reqId = tc.requirementId;
  if (!reqId) return;
  const level = (tc.testLevel ?? '').toLowerCase();
  const isIntegration = level === 'integration';
  const existing = acc.get(reqId);
  if (existing) {
    if (isIntegration) existing.caseCountByLevel.integration += 1;
    else existing.caseCountByLevel.component += 1;
  } else {
    acc.set(reqId, {
      requirementId: reqId,
      conditionCount: 0,
      categories: [],
      techniques: [],
      caseCountByLevel: {
        component: isIntegration ? 0 : 1,
        integration: isIntegration ? 1 : 0,
      },
    });
  }
}

export class CoverageIndex {
  private readonly summary = new Map<string, PreviousBatchCoverageSummary>();
  private readonly componentConditions = new Map<string, IndexedComponentCondition[]>();
  private readonly cases = new Map<string, IndexedCase[]>();

  addCondition(tc: ConditionInput): void {
    const reqId = tc.requirementId;
    if (!reqId) return;
    const category = tc.category ?? 'functional';
    const technique = tc.primaryTechnique ?? 'Unknown';
    mergeConditionSummary(this.summary, tc);

    if (tc.conditionType === 'component') {
      const list = this.componentConditions.get(reqId) ?? [];
      list.push({
        id: tc.id,
        requirementId: reqId,
        condition: tc.condition,
        conditionType: 'component',
        category,
        primaryTechnique: technique,
      });
      this.componentConditions.set(reqId, list);
    }
  }

  addCase(tc: CaseInput): void {
    const reqId = tc.requirementId;
    if (!reqId) return;
    mergeCaseSummary(this.summary, tc);

    const list = this.cases.get(reqId) ?? [];
    list.push({
      title: tc.title ?? '',
      testLevel: tc.testLevel ?? 'component',
      conditionId: tc.conditionId ?? '',
      requirementId: reqId,
    });
    this.cases.set(reqId, list);
  }

  get size(): number {
    return this.summary.size;
  }

  summaryList(): PreviousBatchCoverageSummary[] {
    return [...this.summary.values()];
  }

  /** 向后兼容旧持久化格式（`run.state` 里的 `[requirementId, summary][]` 数组）。 */
  summaryEntries(): [string, PreviousBatchCoverageSummary][] {
    return [...this.summary.entries()];
  }

  static fromSummaryEntries(entries: [string, PreviousBatchCoverageSummary][]): CoverageIndex {
    const index = new CoverageIndex();
    for (const [key, value] of entries) index.summary.set(key, value);
    return index;
  }

  componentConditionsFor(reqId: string): IndexedComponentCondition[] {
    return this.componentConditions.get(reqId) ?? [];
  }

  allComponentConditions(): IndexedComponentCondition[] {
    return [...this.componentConditions.values()].flat();
  }

  casesFor(reqId: string): IndexedCase[] {
    return this.cases.get(reqId) ?? [];
  }

  serialize(): CoverageIndexSerialized {
    return {
      summary: [...this.summary.entries()],
      componentConditions: [...this.componentConditions.entries()],
      cases: [...this.cases.entries()],
    };
  }

  static deserialize(data: unknown): CoverageIndex {
    const index = new CoverageIndex();
    if (!data || typeof data !== 'object') return index;
    const obj = data as Record<string, unknown>;

    if (Array.isArray(obj.summary)) {
      for (const [reqId, value] of obj.summary as [string, PreviousBatchCoverageSummary][]) {
        index.summary.set(reqId, value);
      }
    }
    if (Array.isArray(obj.componentConditions)) {
      for (const [reqId, items] of obj.componentConditions as [string, IndexedComponentCondition[]][]) {
        index.componentConditions.set(reqId, items);
      }
    }
    if (Array.isArray(obj.cases)) {
      for (const [reqId, items] of obj.cases as [string, IndexedCase[]][]) {
        index.cases.set(reqId, items);
      }
    }
    return index;
  }
}

export interface CoverageIndexSerialized {
  summary: [string, PreviousBatchCoverageSummary][];
  componentConditions: [string, IndexedComponentCondition[]][];
  cases: [string, IndexedCase[]][];
}