import { describe, it, expect } from 'vitest';
import {
  emitReviewSkill,
  emitCoverageRowSkill,
} from '../graph/skills/emit-review-skill.ts';
import { buildQualitySkills, buildDesignerSkills } from '../graph/skills/skills.ts';
import { createQualityOutputProfile, type QualityDraftCase } from '../graph/structured-output/quality.ts';
import type { ToolCallRecord } from '../graph/nodes/types.ts';

// ============================================================
// Tool schema
// ============================================================

describe('emit_review tool schema', () => {
  const valid = (extras: Record<string, unknown> = {}) => ({
    caseId: 'TC-1', status: 'approved', reviewSummary: 'No changes required.', changeLog: [], ...extras,
  });

  it('accepts a valid review verdict', () => {
    expect(emitReviewSkill.schema.safeParse(valid()).success).toBe(true);
    expect(emitReviewSkill.schema.safeParse(valid({ status: 'approved_with_changes' })).success).toBe(true);
    expect(emitReviewSkill.schema.safeParse(valid({ status: 'rejected' })).success).toBe(true);
  });

  it('REJECTS an invalid status (closed enum)', () => {
    expect(emitReviewSkill.schema.safeParse(valid({ status: 'pending' })).success).toBe(false);
  });

  it('REQUIRES a reason in every changeLog entry', () => {
    const bad = valid({ changeLog: [{ field: 'testData', from: 'a', to: 'b' }] });
    expect(emitReviewSkill.schema.safeParse(bad).success).toBe(false);
  });

  it('accepts full-replacement steps and testData when provided', () => {
    const r = emitReviewSkill.schema.safeParse(valid({
      steps: [{ stepNumber: 1, action: 'click the Sign in button', expected: 'Auth API returns 200.' }],
      testData: ['quantity = 0 (one below minimum 1)'],
    }));
    expect(r.success).toBe(true);
  });
});

describe('emit_coverage_row tool schema', () => {
  it('accepts a minimal row and optional fields', () => {
    expect(emitCoverageRowSkill.schema.safeParse({ conditionId: 'C-1' }).success).toBe(true);
    expect(emitCoverageRowSkill.schema.safeParse({ conditionId: 'C-1', conditionSummary: 'x', notes: 'y' }).success).toBe(true);
  });

  it('REQUIRES a conditionId', () => {
    expect(emitCoverageRowSkill.schema.safeParse({}).success).toBe(false);
  });
});

// ============================================================
// Skills registration
// ============================================================

describe('buildQualitySkills includes emit tools', () => {
  it('exposes emit_review + emit_coverage_row to the Quality Manager', () => {
    const names = buildQualitySkills('run-1', 'project-1').map((s) => s.name);
    expect(names).toContain('emit_review');
    expect(names).toContain('emit_coverage_row');
  });

  it('does NOT expose Quality emit tools to the Designer', () => {
    const names = buildDesignerSkills('run-1', 'project-1', []).map((s) => s.name);
    expect(names).not.toContain('emit_review');
    expect(names).not.toContain('emit_coverage_row');
  });
});

// ============================================================
// Mode A merge — emit_review + emit_coverage_row → final + coverageMatrix
// ============================================================

describe('Quality emit-extract merge', () => {
  const draftCases: QualityDraftCase[] = [
    {
      id: 'TC-1', title: 'Login happy path', conditionId: 'C-1', requirementId: 'REQ-1',
      priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
      preconditions: ['User is on login page'], testData: ['username = admin (valid)'],
      steps: [{ stepNumber: 1, action: 'fill the username field with \'admin\'', expected: 'username shows admin', intent: { targetHint: 'username field' } }],
      tags: ['login'],
    },
    {
      id: 'TC-2', title: 'Quantity boundary', conditionId: 'C-2', requirementId: 'REQ-2',
      priority: 'high', category: 'boundary', testLevel: 'component', techniqueApplied: 'Boundary Value Analysis',
      testData: ['quantity = small number'],
      steps: [{ stepNumber: 1, action: 'Submit the order form', expected: 'Form rejected' }],
    },
  ];

  const reviewRecord = (input: Record<string, unknown>): ToolCallRecord => ({
    name: 'emit_review', input, output: { ack: true }, latencyMs: 1,
  });
  const rowRecord = (input: Record<string, unknown>): ToolCallRecord => ({
    name: 'emit_coverage_row', input, output: { ack: true }, latencyMs: 1,
  });

  it('merges verdicts onto draft cases and derives finalTestCases', () => {
    const records: ToolCallRecord[] = [
      reviewRecord({ caseId: 'TC-1', status: 'approved', reviewSummary: 'No changes required.', changeLog: [] }),
      reviewRecord({
        caseId: 'TC-2', status: 'approved_with_changes',
        reviewSummary: 'Corrected quantity to exact boundary.',
        changeLog: [{ field: 'testData', from: 'quantity = small number', to: 'quantity = 0 (one below minimum 1)', reason: 'BVA requires exact boundary.' }],
        testData: ['quantity = 0 (one below minimum 1)'],
      }),
      rowRecord({ conditionId: 'C-1', conditionSummary: 'Login accepts valid credentials' }),
      rowRecord({ conditionId: 'C-2', conditionSummary: 'Quantity below minimum rejected', notes: 'Boundary corrected.' }),
    ];

    const profile = createQualityOutputProfile(draftCases);
    const raw = profile.emitExtract!(records, '', 'quality_manager');
    expect(raw).not.toBeNull();

    const parsed = profile.parse(profile.normalize(raw!));
    expect(parsed.finalTestCases).toHaveLength(2);

    const tc1 = parsed.finalTestCases.find((c) => c.id === 'TC-1')!;
    expect(tc1.status).toBe('approved');
    expect(tc1.changeLog).toEqual([]);
    // draft fields preserved (intent verbatim, steps untouched)
    expect(tc1.steps[0].intent).toEqual({ targetHint: 'username field' });

    const tc2 = parsed.finalTestCases.find((c) => c.id === 'TC-2')!;
    expect(tc2.status).toBe('approved_with_changes');
    expect(tc2.testData).toEqual(['quantity = 0 (one below minimum 1)']);

    // coverageMatrix raw present so reconcileCoverageMatrix can fill the rest
    expect((parsed as any).coverageMatrix).toBeDefined();
  });

  it('defaults a case with no emit_review to approved + empty changeLog', () => {
    const records: ToolCallRecord[] = [
      reviewRecord({ caseId: 'TC-1', status: 'approved', reviewSummary: 'ok', changeLog: [] }),
    ];
    const profile = createQualityOutputProfile(draftCases);
    const raw = profile.emitExtract!(records, '', 'quality_manager');
    const parsed = profile.parse(profile.normalize(raw!));
    const tc2 = parsed.finalTestCases.find((c) => c.id === 'TC-2')!;
    expect(tc2.status).toBe('approved');
    expect(tc2.changeLog).toEqual([]);
  });

  it('takes the LAST emit_review for the same caseId (overwrite)', () => {
    const records: ToolCallRecord[] = [
      reviewRecord({ caseId: 'TC-1', status: 'approved', reviewSummary: 'first', changeLog: [] }),
      reviewRecord({ caseId: 'TC-1', status: 'rejected', reviewSummary: 'overwritten', changeLog: [] }),
    ];
    const profile = createQualityOutputProfile(draftCases);
    const raw = profile.emitExtract!(records, '', 'quality_manager');
    const parsed = profile.parse(profile.normalize(raw!));
    const tc1 = parsed.finalTestCases.find((c) => c.id === 'TC-1')!;
    expect(tc1.status).toBe('rejected');
  });

  it('returns null when no emit tools were called', () => {
    const profile = createQualityOutputProfile(draftCases);
    expect(profile.emitExtract!([{ name: 'flow_detail_query', input: {}, output: {}, latencyMs: 1 }], '', 'quality_manager')).toBeNull();
  });
});