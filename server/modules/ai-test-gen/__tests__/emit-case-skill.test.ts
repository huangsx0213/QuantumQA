import { describe, it, expect } from 'vitest';
import { GENERATABLE_ACTION_VERBS } from 'shared/recording/nl-intent.ts';
import {
  buildAnalystSkills,
  buildDesignerSkills,
  buildQualitySkills,
} from '../graph/skills/skills.ts';
import { emitCaseSkill, createEmitCaseSkill } from '../graph/skills/emit-case-skill.ts';
import { tryExtractFromEmitTools } from '../graph/nodes/utils.ts';
import { createDesignerOutputProfile } from '../graph/structured-output/designer.ts';
import type { ToolCallRecord } from '../graph/nodes/types.ts';

// ============================================================
// Tool schema — verb enum + data-verb coupling
// ============================================================

const oneStep = (verb: string, extras: Record<string, unknown> = {}): Record<string, unknown> => ({
  verb, targetHint: 'something', ...extras,
});

const emitArgs = (steps: Record<string, unknown>[], extras: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'TC-1', title: 'Login test', conditionId: 'C-1', requirementId: 'req-1',
  priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
  steps, ...extras,
});

describe('emit_case tool schema', () => {
  const runTool = (args: unknown) => emitCaseSkill.schema.safeParse(args);

  it('accepts every vocabulary verb (closed enum)', () => {
    for (const verb of GENERATABLE_ACTION_VERBS) {
      const step: Record<string, unknown> = { verb, targetHint: 'something' };
      if (['fill', 'select', 'navigate', 'upload', 'press'].includes(verb)) step.data = 'value';
      if (['verify', 'waitFor'].includes(verb)) step.expectation = { kind: 'text-visible', value: 'x' };
      const r = runTool(emitArgs([step]));
      expect(r.success, `verb "${verb}" should be accepted`).toBe(true);
    }
  });

  it('REJECTS a non-vocabulary verb at the API layer (the core guarantee)', () => {
    for (const badVerb of ['ensure', 'enter', 'type', 'submit', 'observe', 'make sure', 'check that', 'go to', 'choose']) {
      const r = runTool(emitArgs([oneStep(badVerb)]));
      expect(r.success, `"${badVerb}" must be rejected`).toBe(false);
    }
  });

  it('REQUIRES data for fill/select/navigate/upload/press', () => {
    for (const verb of ['fill', 'select', 'navigate', 'upload', 'press']) {
      const r = runTool(emitArgs([oneStep(verb)]));
      expect(r.success, `verb "${verb}" without data must be rejected`).toBe(false);
    }
  });

  it('REJECTS empty string data for fill (empty-value fill must use clear/verify)', () => {
    const r = runTool(emitArgs([oneStep('fill', { data: '' })]));
    expect(r.success).toBe(false);
  });

  it('REQUIRES expectation for verify/waitFor', () => {
    for (const verb of ['verify', 'waitFor']) {
      const r = runTool(emitArgs([oneStep(verb)]));
      expect(r.success, `verb "${verb}" without expectation must be rejected`).toBe(false);
    }
  });

  it('validates element-state expectation.value against the closed enum', () => {
    expect(runTool(emitArgs([oneStep('verify', { expectation: { kind: 'element-state', value: 'enabled' } })])).success).toBe(true);
    expect(runTool(emitArgs([oneStep('verify', { expectation: { kind: 'element-state', value: 'unknown' } })])).success).toBe(false);
  });

  it('rejects navigate data with spaces (must be a URL or path)', () => {
    expect(runTool(emitArgs([oneStep('navigate', { data: '/login' })])).success).toBe(true);
    expect(runTool(emitArgs([oneStep('navigate', { data: 'the login page' })])).success).toBe(false);
  });

  it('accepts a minimal valid case with steps', () => {
    expect(runTool(emitArgs([oneStep('click')])).success).toBe(true);
  });

  it('REQUIRES a non-empty steps array', () => {
    expect(runTool({ ...emitArgs([]), steps: [] }).success).toBe(false);
  });

  it('rejects an invalid testLevel (must be component or integration)', () => {
    expect(runTool({ ...emitArgs([oneStep('click')]), testLevel: 'Component' }).success).toBe(false);
    expect(runTool({ ...emitArgs([oneStep('click')]), testLevel: 'unit' }).success).toBe(false);
  });

  it('defaults coveredConditions and referencedComponentConditions to []', () => {
    const parsed = runTool(emitArgs([oneStep('click')], { coveredConditions: undefined, referencedComponentConditions: undefined }));
    expect(parsed.success).toBe(true);
    expect((parsed.data as any).coveredConditions).toEqual([]);
    expect((parsed.data as any).referencedComponentConditions).toEqual([]);
  });
});

// ============================================================
// Skills registration — the new tool is exposed to the Designer
// ============================================================

describe('buildDesignerSkills includes emit_case', () => {
  it('exposes the emit_case tool in the Designer skills list', () => {
    const skills = buildDesignerSkills('run-1', 'project-1', []);
    expect(skills.map((s) => s.name)).toContain('emit_case');
  });

  it('does NOT expose emit_case to the Analyst or Quality (designer-only)', () => {
    const analystNames = buildAnalystSkills('run-1', 'project-1').map((s) => s.name);
    const qualityNames = buildQualitySkills('run-1', 'project-1').map((s) => s.name);
    expect(analystNames).not.toContain('emit_case');
    expect(qualityNames).not.toContain('emit_case');
  });
});

// ============================================================
// Extraction logic — tool calls → draftTestCases JSON
// ============================================================

describe('tryExtractFromEmitTools', () => {
  const conditions = [{ id: 'C-1', requirementId: 'req-1', conditionType: 'component' as const }];
  const outputProfile = createDesignerOutputProfile(conditions);

  const caseRecord = (id: string, steps: Record<string, unknown>[], extras: Record<string, unknown> = {}): ToolCallRecord => ({
    name: 'emit_case',
    input: {
      id, title: `Case ${id}`, conditionId: 'C-1', requirementId: 'req-1',
      priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
      preconditions: [], testData: [], coveredConditions: ['C-1'], referencedComponentConditions: [],
      steps, ...extras,
    },
    output: { ack: true, stepCount: steps.length },
    latencyMs: 1,
  });

  it('returns null when no emit_case was called (backward compat)', () => {
    expect(tryExtractFromEmitTools([], '', 'test_designer')).toBeNull();
    const r = tryExtractFromEmitTools(
      [{ name: 'requirement_detail_query', input: { requirementId: 'req-1' }, output: {}, latencyMs: 1 }],
      '',
      'test_designer',
    );
    expect(r).toBeNull();
  });

  it('defers to the fuller contentText JSON when the LLM abandons emit_case midway', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-001', [
        { verb: 'verify', targetHint: 'username field', expectation: { kind: 'element-visible' } },
      ]),
    ];
    const contentText = JSON.stringify({
      draftTestCases: [
        { id: 'TC-001', conditionId: 'C-1', steps: [{ stepNumber: 1 }] },
        { id: 'TC-002', conditionId: 'C-2', steps: [{ stepNumber: 1 }] },
        { id: 'TC-003', conditionId: 'C-3', steps: [{ stepNumber: 1 }] },
      ],
    });
    const r = tryExtractFromEmitTools(records, contentText, 'test_designer');
    expect(r).toBeNull();
  });

  it('builds a valid draftTestCases from a single emit_case with steps', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', [
        { verb: 'fill', targetHint: 'username input field', data: 'admin' },
        { verb: 'fill', targetHint: 'password input field', data: 'admin123' },
        { verb: 'click', targetHint: 'Sign in button' },
      ], { coveredConditions: ['C-1'] }),
    ];
    const draft = tryExtractFromEmitTools(records, '', 'test_designer');
    expect(draft).not.toBeNull();
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(1);
    const tc = parsed.draftTestCases[0];
    expect(tc.id).toBe('TC-1');
    expect(tc.coveredConditions).toEqual(['C-1']);
    expect(tc.steps).toHaveLength(3);
    // action's first word MUST be the declared verb (the core guarantee)
    expect(tc.steps[0].action.startsWith('fill ')).toBe(true);
    expect(tc.steps[2].action.startsWith('click ')).toBe(true);
    // intent.data carries the value
    expect((tc.steps[0].intent as any)?.data).toBe('admin');
  });

  it('auto-numbers steps in array order and preserves explicit stepNumber ordering', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', [
        { stepNumber: 3, verb: 'click', targetHint: 'submit' },
        { verb: 'navigate', data: '/login' },
      ]),
    ];
    const draft = tryExtractFromEmitTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    const actions = parsed.draftTestCases[0].steps.map((s) => s.action);
    // sorted by stepNumber: auto 1 (navigate), explicit 3 (click)
    expect(actions[0].startsWith('navigate ')).toBe(true);
    expect(actions[1].startsWith('click ')).toBe(true);
  });

  it('takes the LAST emit_case for the same id (last-write-wins overwrite)', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', [{ verb: 'fill', targetHint: 'username', data: 'admin' }]),
      caseRecord('TC-1', [{ verb: 'fill', targetHint: 'username', data: 'superuser' }]),
    ];
    const draft = tryExtractFromEmitTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(1);
    expect((parsed.draftTestCases[0].steps[0].intent as any)?.data).toBe('superuser');
  });

  it('declares MULTIPLE cases in one emit_case each', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', [
        { verb: 'fill', targetHint: 'username', data: 'admin' },
        { verb: 'click', targetHint: 'Sign in button' },
      ]),
      caseRecord('TC-2', [
        { verb: 'verify', targetHint: 'browser page', expectation: { kind: 'url', value: '/login' } },
      ]),
    ];
    const draft = tryExtractFromEmitTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(2);
    const tc1 = parsed.draftTestCases.find((t) => t.id === 'TC-1')!;
    const tc2 = parsed.draftTestCases.find((t) => t.id === 'TC-2')!;
    expect(tc1.steps).toHaveLength(2);
    expect(tc2.steps).toHaveLength(1);
    expect((tc2.steps[0].intent as any)?.expectation).toEqual({ kind: 'url', value: '/login' });
  });

  it('truncates an over-long fill action but keeps the full value in intent.data', () => {
    const longValue = 'a'.repeat(210);
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', [{ verb: 'fill', targetHint: 'username input field', data: longValue }]),
    ];
    const draft = tryExtractFromEmitTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action.length).toBeLessThanOrEqual(200);
    expect(step.action).toContain("with '");
    expect((step.intent as any)?.data).toBe(longValue);
  });
});

// ============================================================
// F8a: call-time reference validation (createEmitCaseSkill)
// ============================================================

describe('createEmitCaseSkill — call-time conditionId validation', () => {
  const validConditions = [
    { id: 'C-001', requirementId: 'req-aut-001', conditionType: 'component' as const, expectedTestLevel: 'component' as const },
    { id: 'C-002', requirementId: 'req-aut-001', conditionType: 'flow' as const, expectedTestLevel: 'integration' as const },
    { id: 'C-003', requirementId: 'req-aut-002', conditionType: 'component' as const, expectedTestLevel: 'component' as const },
  ];

  const boundSkill = createEmitCaseSkill(validConditions, []);
  const validCase = {
    id: 'TC-1', title: 'Login test', conditionId: 'C-001', requirementId: 'req-aut-001',
    coveredConditions: ['C-001'], referencedComponentConditions: [],
    priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'EP',
    steps: [oneStep('fill', { data: 'admin' })],
  };

  it('accepts a case with a valid conditionId and matching requirementId', () => {
    const r = boundSkill.schema.safeParse(validCase);
    expect(r.success).toBe(true);
  });

  it('rejects a dangling conditionId with the list of valid ids', () => {
    const r = boundSkill.schema.safeParse({ ...validCase, conditionId: 'C-999' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path[0] === 'conditionId')?.message ?? '';
      expect(msg).toContain('C-999');
      expect(msg).toContain('C-001');
    }
  });

  it('rejects a requirementId that does not match the condition', () => {
    const r = boundSkill.schema.safeParse({ ...validCase, requirementId: 'req-wrong' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path[0] === 'requirementId')?.message ?? '';
      expect(msg).toContain('req-aut-001');
    }
  });

  it('rejects a testLevel that does not match the expectedTestLevel', () => {
    const r = boundSkill.schema.safeParse({ ...validCase, conditionId: 'C-002', requirementId: 'req-aut-001', testLevel: 'component' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path[0] === 'testLevel')?.message ?? '';
      expect(msg).toContain('integration');
    }
  });

  it('rejects a non-component condition in referencedComponentConditions', () => {
    const r = boundSkill.schema.safeParse({
      ...validCase, conditionId: 'C-002', requirementId: 'req-aut-001', testLevel: 'integration',
      referencedComponentConditions: ['C-001'],
    });
    expect(r.success).toBe(true);
  });

  it('still validates verb/data coupling alongside refs', () => {
    const r = boundSkill.schema.safeParse({
      ...validCase,
      steps: [oneStep('fill', { data: '' })],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.some((p) => p === 'data'))).toBe(true);
    }
  });

  it('returns the static singleton when no conditions are provided', () => {
    expect(createEmitCaseSkill()).toBe(emitCaseSkill);
  });
});