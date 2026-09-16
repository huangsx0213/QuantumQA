import { describe, it, expect } from 'vitest';
import {
  emitConditionSkill,
  emitAnalysisSkill,
} from '../graph/skills/emit-condition-skill.ts';
import { buildAnalystSkills, buildDesignerSkills, buildQualitySkills } from '../graph/skills/skills.ts';
import { createAnalystOutputProfile } from '../graph/structured-output/analyst.ts';
import { createDesignerOutputProfile } from '../graph/structured-output/designer.ts';
import type { ToolCallRecord } from '../graph/nodes/types.ts';

// ============================================================
// Tool schema
// ============================================================

describe('emit_condition tool schema', () => {
  const validCondition = (extras: Record<string, unknown> = {}) => ({
    id: 'C-1', requirementId: 'REQ-1', condition: 'Verify that ...', conditionType: 'component',
    category: 'functional', priority: 'high', riskLevel: 'high',
    primaryTechnique: 'Equivalence Partitioning', techniqueRationale: '...', ...extras,
  });

  it('accepts a valid component condition', () => {
    expect(emitConditionSkill.schema.safeParse(validCondition()).success).toBe(true);
  });

  it('REJECTS an invalid conditionType (closed enum)', () => {
    expect(emitConditionSkill.schema.safeParse(validCondition({ conditionType: 'unit' })).success).toBe(false);
  });

  it('requires non-empty flowStepRefs for flow conditions (schema-level coupling)', () => {
    // flow condition without flowStepRefs is still schema-valid here (the business gate
    // validates it at parse time), but flowStepRefs entries must be well-formed.
    const flow = validCondition({
      id: 'C-2', conditionType: 'flow',
      flowStepRefs: [{ flowId: 'FLOW-1', sequence: 1, actionSummary: 'Auth API returns 200' }],
    });
    expect(emitConditionSkill.schema.safeParse(flow).success).toBe(true);

    const badRef = validCondition({
      conditionType: 'flow',
      flowStepRefs: [{ flowId: 'FLOW-1', sequence: 1 }], // missing actionSummary
    });
    expect(emitConditionSkill.schema.safeParse(badRef).success).toBe(false);
  });
});

describe('emit_analysis tool schema', () => {
  it('accepts overallApproach + riskAssessmentSummary', () => {
    expect(emitAnalysisSkill.schema.safeParse({ overallApproach: 'x', riskAssessmentSummary: 'y' }).success).toBe(true);
  });

  it('REQUIRES both fields', () => {
    expect(emitAnalysisSkill.schema.safeParse({}).success).toBe(false);
  });
});

// ============================================================
// Skills registration
// ============================================================

describe('buildAnalystSkills includes emit tools', () => {
  it('exposes emit_analysis + emit_condition to the Analyst', () => {
    const names = buildAnalystSkills('run-1', 'project-1').map((s) => s.name);
    expect(names).toContain('emit_analysis');
    expect(names).toContain('emit_condition');
  });

  it('does NOT expose Analyst emit tools to Designer or Quality', () => {
    expect(buildDesignerSkills('run-1', 'project-1', []).map((s) => s.name)).not.toContain('emit_condition');
    expect(buildQualitySkills('run-1', 'project-1').map((s) => s.name)).not.toContain('emit_condition');
  });
});

// ============================================================
// Mode A merge — emit_analysis + emit_condition → raw
// ============================================================

describe('Analyst emit-extract', () => {
  const conditionRecord = (input: Record<string, unknown>): ToolCallRecord => ({
    name: 'emit_condition', input, output: { ack: true }, latencyMs: 1,
  });
  const analysisRecord = (input: Record<string, unknown>): ToolCallRecord => ({
    name: 'emit_analysis', input, output: { ack: true }, latencyMs: 1,
  });

  it('assembles requirementAnalysis + testConditions from emit tools', () => {
    const records: ToolCallRecord[] = [
      analysisRecord({ overallApproach: 'EP + BVA for validation', riskAssessmentSummary: 'Auth is highest risk' }),
      conditionRecord({
        id: 'C-1', requirementId: 'REQ-1', condition: 'Verify login rejects invalid password', conditionType: 'component',
        category: 'error', priority: 'high', riskLevel: 'high',
        primaryTechnique: 'Equivalence Partitioning', techniqueRationale: 'partition valid/invalid', coverageDimensions: ['validation'],
      }),
      conditionRecord({
        id: 'C-2', requirementId: 'FLOW-1', condition: 'Verify cross-component login successful', conditionType: 'flow',
        flowStepRefs: [{ flowId: 'FLOW-1', sequence: 1, actionSummary: 'Auth API returns 200' }],
        category: 'integration', priority: 'critical', riskLevel: 'critical',
        primaryTechnique: 'Use Case Testing', techniqueRationale: 'cross-component journey', coverageDimensions: ['integration'],
      }),
    ];

    const profile = createAnalystOutputProfile();
    const raw = profile.emitExtract!(records, '', 'test_analyst');
    expect(raw).not.toBeNull();

    const parsed = profile.parse(profile.normalize(raw!));
    expect(parsed.requirementAnalysis.overallApproach).toBe('EP + BVA for validation');
    expect(parsed.testConditions).toHaveLength(2);
    expect(parsed.testConditions[0].id).toBe('C-1');
    expect(parsed.testConditions[1].conditionType).toBe('flow');
  });

  it('takes the LAST emit_condition for the same id (overwrite)', () => {
    const records: ToolCallRecord[] = [
      conditionRecord({ id: 'C-1', requirementId: 'REQ-1', condition: 'first', conditionType: 'component', category: 'functional', priority: 'high', riskLevel: 'high', primaryTechnique: 'Equivalence Partitioning', techniqueRationale: 'x' }),
      conditionRecord({ id: 'C-1', requirementId: 'REQ-1', condition: 'overwritten', conditionType: 'component', category: 'error', priority: 'high', riskLevel: 'high', primaryTechnique: 'Equivalence Partitioning', techniqueRationale: 'x' }),
    ];
    const profile = createAnalystOutputProfile();
    const raw = profile.emitExtract!(records, '', 'test_analyst');
    const parsed = profile.parse(profile.normalize(raw!));
    expect(parsed.testConditions).toHaveLength(1);
    expect(parsed.testConditions[0].condition).toBe('overwritten');
  });

  it('returns null when no emit tools were called', () => {
    const profile = createAnalystOutputProfile();
    expect(profile.emitExtract!([], '', 'test_analyst')).toBeNull();
  });
});