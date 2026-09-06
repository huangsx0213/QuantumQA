import { describe, expect, it } from 'vitest';
import {
  CoverageIndex,
  mergeConditionSummary,
  mergeCaseSummary,
} from '../coverage-index.ts';
import type { PreviousBatchCoverageSummary } from '../graph/state.ts';

describe('mergeConditionSummary / mergeCaseSummary', () => {
  it('aggregates conditions by requirementId with deduped categories/techniques', () => {
    const acc = new Map<string, PreviousBatchCoverageSummary>();
    mergeConditionSummary(acc, { requirementId: 'r1', category: 'functional', primaryTechnique: 'Equivalence Partitioning' });
    mergeConditionSummary(acc, { requirementId: 'r1', category: 'functional', primaryTechnique: 'Boundary Value Analysis' });
    mergeConditionSummary(acc, { requirementId: 'r1', category: 'error', primaryTechnique: 'Equivalence Partitioning' });
    mergeConditionSummary(acc, { requirementId: 'r2', category: 'ui', primaryTechnique: 'State Transition' });

    expect(acc.get('r1')).toMatchObject({
      requirementId: 'r1',
      conditionCount: 3,
      categories: ['functional', 'error'],
      techniques: ['Equivalence Partitioning', 'Boundary Value Analysis'],
      caseCountByLevel: { component: 0, integration: 0 },
    });
  });

  it('counts cases by testLevel only', () => {
    const acc = new Map<string, PreviousBatchCoverageSummary>();
    mergeCaseSummary(acc, { requirementId: 'r1', testLevel: 'component' });
    mergeCaseSummary(acc, { requirementId: 'r1', testLevel: 'integration' });
    mergeCaseSummary(acc, { requirementId: 'r1', testLevel: 'integration' });
    mergeCaseSummary(acc, { testLevel: 'component' }); // missing requirementId → no-op

    expect(acc.get('r1')?.caseCountByLevel).toEqual({ component: 1, integration: 2 });
    expect(acc.size).toBe(1);
  });
});

describe('CoverageIndex', () => {
  it('accumulates summary + component detail on addCondition', () => {
    const idx = new CoverageIndex();
    idx.addCondition({ id: 'C-001', requirementId: 'r1', condition: 'login form', conditionType: 'component', category: 'functional', primaryTechnique: 'EP' });
    idx.addCondition({ id: 'C-002', requirementId: 'r1', condition: 'auth session', conditionType: 'flow', category: 'integration' });
    idx.addCondition({ id: 'C-003', requirementId: 'r2', condition: 'logout', conditionType: 'component', category: 'ui' });

    expect(idx.summaryList()).toEqual([
      expect.objectContaining({ requirementId: 'r1', conditionCount: 2 }),
      expect.objectContaining({ requirementId: 'r2', conditionCount: 1 }),
    ]);
    // only component-typed conditions land in the detail index
    expect(idx.componentConditionsFor('r1').map((c) => c.id)).toEqual(['C-001']);
    expect(idx.allComponentConditions().map((c) => c.id)).toEqual(['C-001', 'C-003']);
  });

  it('accumulates case detail keyed by requirementId', () => {
    const idx = new CoverageIndex();
    idx.addCase({ title: 't1', testLevel: 'component', conditionId: 'C-001', requirementId: 'r1' });
    idx.addCase({ title: 't2', testLevel: 'integration', conditionId: 'C-002', requirementId: 'r1' });

    expect(idx.casesFor('r1')).toEqual([
      { title: 't1', testLevel: 'component', conditionId: 'C-001', requirementId: 'r1' },
      { title: 't2', testLevel: 'integration', conditionId: 'C-002', requirementId: 'r1' },
    ]);
    expect(idx.casesFor('missing')).toEqual([]);
    expect(idx.summaryList()[0].caseCountByLevel).toEqual({ component: 1, integration: 1 });
  });

  it('round-trips through serialize/deserialize', () => {
    const idx = new CoverageIndex();
    idx.addCondition({ id: 'C-001', requirementId: 'r1', condition: 'x', conditionType: 'component' });
    idx.addCase({ title: 't1', testLevel: 'component', conditionId: 'C-001', requirementId: 'r1' });

    const restored = CoverageIndex.deserialize(idx.serialize());
    expect(restored.summaryList()).toEqual(idx.summaryList());
    expect(restored.componentConditionsFor('r1')).toEqual(idx.componentConditionsFor('r1'));
    expect(restored.casesFor('r1')).toEqual(idx.casesFor('r1'));
  });

  it('deserialize tolerates null / malformed input', () => {
    expect(CoverageIndex.deserialize(null).summaryList()).toEqual([]);
    expect(CoverageIndex.deserialize('junk').summaryList()).toEqual([]);
  });
});