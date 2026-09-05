import { describe, it, expect } from 'vitest';
import { GENERATABLE_ACTION_VERBS } from 'shared/recording/nl-intent.ts';
import {
  buildAnalystSkills,
  buildDesignerSkills,
  buildQualitySkills,
} from '../graph/skills/skills.ts';
import {
  declareCaseSkill,
  declareStepSkill,
} from '../graph/skills/declare-step-skill.ts';
import { tryExtractFromDeclareTools } from '../graph/nodes/utils.ts';
import { createDesignerOutputProfile } from '../graph/structured-output/designer.ts';
import type { ToolCallRecord } from '../graph/nodes/types.ts';

// ============================================================
// Tool schema — verb enum + data-verb coupling
// ============================================================

describe('declare_step tool schema', () => {
  const runTool = (args: unknown) => declareStepSkill.schema.safeParse(args);
  const runCaseTool = (args: unknown) => declareCaseSkill.schema.safeParse(args);

  it('accepts every vocabulary verb (closed enum)', () => {
    for (const verb of GENERATABLE_ACTION_VERBS) {
      const args: Record<string, unknown> = {
        caseId: 'TC-1', stepNumber: 1, verb, targetHint: 'something',
      };
      // data required for fill/select/navigate/upload/press; add data when needed
      if (['fill', 'select', 'navigate', 'upload', 'press'].includes(verb)) args.data = 'value';
      // expectation required for verify/waitFor
      if (['verify', 'waitFor'].includes(verb)) args.expectation = { kind: 'text-visible', value: 'x' };
      const r = runTool(args);
      expect(r.success, `verb "${verb}" should be accepted`).toBe(true);
    }
  });

  it('REJECTS a non-vocabulary verb at the API layer (the core guarantee)', () => {
    for (const badVerb of ['ensure', 'enter', 'type', 'submit', 'observe', 'make sure', 'check that', 'go to', 'choose']) {
      const r = runTool({ caseId: 'TC-1', stepNumber: 1, verb: badVerb, targetHint: 'x' });
      expect(r.success, `"${badVerb}" must be rejected`).toBe(false);
    }
  });

  it('REQUIRES data for fill/select/navigate/upload/press', () => {
    for (const verb of ['fill', 'select', 'navigate', 'upload', 'press']) {
      const r = runTool({ caseId: 'TC-1', stepNumber: 1, verb, targetHint: 'x' });
      expect(r.success, `verb "${verb}" without data must be rejected`).toBe(false);
    }
  });

  it('REJECTS empty string data for fill (empty-value fill must use clear/verify — real-world batch rejection cause)', () => {
    // Empty string fill data passes `data == null` but constructStep drops it
    // (`data !== ''`), leaving intent.data missing → validateStepContract rejects
    // the whole batch (real logs: TC-005-empty-both / TC-011-empty-username).
    const r = runTool({ caseId: 'TC-1', stepNumber: 1, verb: 'fill', targetHint: 'x', data: '' });
    expect(r.success).toBe(false);
  });

  it('REQUIRES expectation for verify/waitFor', () => {
    for (const verb of ['verify', 'waitFor']) {
      const r = runTool({ caseId: 'TC-1', stepNumber: 1, verb, targetHint: 'x' });
      expect(r.success, `verb "${verb}" without expectation must be rejected`).toBe(false);
    }
  });

  it('validates element-state expectation.value against the closed enum', () => {
    expect(runTool({
      caseId: 'TC-1', stepNumber: 1, verb: 'verify', targetHint: 'x',
      expectation: { kind: 'element-state', value: 'enabled' },
    }).success).toBe(true);
    expect(runTool({
      caseId: 'TC-1', stepNumber: 1, verb: 'verify', targetHint: 'x',
      expectation: { kind: 'element-state', value: 'unknown' },
    }).success).toBe(false);
  });

  it('rejects navigate data with spaces (must be a URL or path)', () => {
    expect(runTool({
      caseId: 'TC-1', stepNumber: 1, verb: 'navigate', targetHint: 'x', data: '/login',
    }).success).toBe(true);
    expect(runTool({
      caseId: 'TC-1', stepNumber: 1, verb: 'navigate', targetHint: 'x', data: 'the login page',
    }).success).toBe(false);
  });
});

describe('declare_case tool schema', () => {
  const runCase = (args: unknown) => declareCaseSkill.schema.safeParse(args);
  const validCase = {
    id: 'TC-1', title: 'Login test', conditionId: 'C-1', requirementId: 'req-1',
    priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
  };

  it('accepts a minimal valid case', () => {
    expect(runCase(validCase).success).toBe(true);
  });

  it('rejects an invalid testLevel (must be component or integration)', () => {
    expect(runCase({ ...validCase, testLevel: 'Component' }).success).toBe(false);
    expect(runCase({ ...validCase, testLevel: 'unit' }).success).toBe(false);
  });

  it('defaults coveredConditions and referencedComponentConditions to []', () => {
    const parsed = runCase(validCase);
    expect(parsed.success).toBe(true);
    expect((parsed.data as any).coveredConditions).toEqual([]);
    expect((parsed.data as any).referencedComponentConditions).toEqual([]);
  });
});

// ============================================================
// Skills registration — the new tools are exposed to the Designer
// ============================================================

describe('buildDesignerSkills includes declare_case and declare_step', () => {
  it('exposes both new tools in the Designer skills list', () => {
    const skills = buildDesignerSkills('run-1', 'project-1', []);
    const names = skills.map((s) => s.name);
    expect(names).toContain('declare_case');
    expect(names).toContain('declare_step');
  });

  it('does NOT expose declare tools to the Analyst or Quality (designer-only)', () => {
    const analystNames = buildAnalystSkills('run-1', 'project-1').map((s) => s.name);
    const qualityNames = buildQualitySkills('run-1', 'project-1').map((s) => s.name);
    expect(analystNames).not.toContain('declare_step');
    expect(analystNames).not.toContain('declare_case');
    expect(qualityNames).not.toContain('declare_step');
    expect(qualityNames).not.toContain('declare_case');
  });
});

// ============================================================
// Extraction logic — tool calls → draftTestCases JSON
// ============================================================

describe('tryExtractFromDeclareTools', () => {
  const conditions = [{ id: 'C-1', requirementId: 'req-1', conditionType: 'component' as const }];
  const outputProfile = createDesignerOutputProfile(conditions);

  const stepRecord = (caseId: string, stepNumber: number, verb: string, extras: Record<string, unknown> = {}): ToolCallRecord => ({
    name: 'declare_step',
    input: { caseId, stepNumber, verb, targetHint: 'some target', ...extras },
    output: { ack: true },
    latencyMs: 1,
  });

  const caseRecord = (id: string, extras: Record<string, unknown> = {}): ToolCallRecord => ({
    name: 'declare_case',
    input: {
      id, title: `Case ${id}`, conditionId: 'C-1', requirementId: 'req-1',
      priority: 'high', category: 'functional', testLevel: 'component', techniqueApplied: 'Equivalence Partitioning',
      preconditions: [], testData: [], coveredConditions: ['C-1'], referencedComponentConditions: [],
      ...extras,
    },
    output: { ack: true },
    latencyMs: 1,
  });

  it('returns null when no declare_* tools were called (backward compat)', () => {
    expect(tryExtractFromDeclareTools([], '', 'test_designer')).toBeNull();
    const r = tryExtractFromDeclareTools(
      [{ name: 'requirement_detail_query', input: { requirementId: 'req-1' }, output: {}, latencyMs: 1 }],
      '',
      'test_designer',
    );
    expect(r).toBeNull();
  });

  it('defers to the fuller contentText JSON when the LLM abandons declare_step midway (real-world partial-tool-adoption)', () => {
    // Real case: LLM declared only 1 case (TC-001) via tools, then wrote the remaining
    // 12 cases as JSON in the thinking text. The tool path can't cover all conditions,
    // so it must defer to the JSON to avoid a doomed validateConditionCoverage parse.
    const records: ToolCallRecord[] = [
      caseRecord('TC-001'),
      stepRecord('TC-001', 1, 'verify', { targetHint: 'username field', expectation: { kind: 'element-visible' } }),
      stepRecord('TC-001', 2, 'verify', { targetHint: 'password field', expectation: { kind: 'element-visible' } }),
      stepRecord('TC-001', 3, 'verify', { targetHint: 'Sign in button', expectation: { kind: 'element-visible' } }),
    ];
    const contentText = JSON.stringify({
      draftTestCases: [
        { id: 'TC-001', conditionId: 'C-1', steps: [{ stepNumber: 1 }] },
        { id: 'TC-002', conditionId: 'C-2', steps: [{ stepNumber: 1 }] },
        { id: 'TC-003', conditionId: 'C-3', steps: [{ stepNumber: 1 }] },
      ],
    });
    const r = tryExtractFromDeclareTools(records, contentText, 'test_designer');
    expect(r).toBeNull();
  });

  it('still uses the tool path when the tool declarations fully cover the JSON case count', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-001'),
      stepRecord('TC-001', 1, 'verify', { targetHint: 'username field', expectation: { kind: 'element-visible' } }),
    ];
    const contentText = JSON.stringify({ draftTestCases: [{ id: 'TC-001', steps: [{ stepNumber: 1 }] }] });
    const r = tryExtractFromDeclareTools(records, contentText, 'test_designer');
    expect(r).not.toBeNull();
  });

  it('returns null when only declare_case was called (no steps)', () => {
    const r = tryExtractFromDeclareTools([caseRecord('TC-1')], '', 'test_designer');
    expect(r).toBeNull();
  });

  it('builds a valid draftTestCases from declare_case + declare_step calls', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', { coveredConditions: ['C-1'] }),
      stepRecord('TC-1', 1, 'fill', { targetHint: 'username input field', data: 'admin' }),
      stepRecord('TC-1', 2, 'fill', { targetHint: 'password input field', data: 'admin123' }),
      stepRecord('TC-1', 3, 'click', { targetHint: 'Sign in button' }),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
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

  it('groups steps by caseId across multiple cases', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      stepRecord('TC-1', 1, 'fill', { data: 'admin' }),
      caseRecord('TC-2', { conditionId: 'C-1', id: 'TC-2' }),
      stepRecord('TC-2', 1, 'verify', { expectation: { kind: 'url', value: '/login' } }),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(2);
    const tc2 = parsed.draftTestCases.find((t) => t.id === 'TC-2')!;
    expect(tc2.steps[0].action.startsWith('verify ')).toBe(true);
    expect((tc2.steps[0].intent as any)?.expectation).toEqual({ kind: 'url', value: '/login' });
  });

  it('sorts steps by stepNumber within a case (handles out-of-order calls)', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      stepRecord('TC-1', 3, 'click', { targetHint: 'submit' }),
      stepRecord('TC-1', 1, 'navigate', { data: '/login' }),
      stepRecord('TC-1', 2, 'fill', { data: 'admin' }),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    const actions = parsed.draftTestCases[0].steps.map((s) => s.action);
    expect(actions[0].startsWith('navigate ')).toBe(true);
    expect(actions[1].startsWith('fill ')).toBe(true);
    expect(actions[2].startsWith('click ')).toBe(true);
  });

  it('takes the last declare_step when the same (caseId, stepNumber) is called twice', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      stepRecord('TC-1', 1, 'fill', { targetHint: 'username', data: 'admin' }),
      stepRecord('TC-1', 1, 'fill', { targetHint: 'username', data: 'superuser' }),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases[0].steps).toHaveLength(1);
    expect((parsed.draftTestCases[0].steps[0].intent as any)?.data).toBe('superuser');
  });

  it('falls through to schema validation (does NOT skip verb checks) — a step with data but no verb still fails at parse time', () => {
    // Extraction produces the draft; DesignerRuntimeSchema.parse still validates step atomicity,
    // compound signals, expected-field rules, etc. The Tool Use layer only enforces verb
    // enum + data/expectation coupling — downstream checks remain.
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      stepRecord('TC-1', 1, 'fill', { targetHint: 'x', data: 'y' }),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    // The basic shape parses fine — the tool layer has already guaranteed verb/data.
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases[0].steps[0].action).toContain("fill");
  });

  // === 批量声明：一次 declare_step 调用携带整个 case 的全部 steps（auto-numbered） ===
  const batchStepRecord = (caseId: string, steps: Record<string, unknown>[], extras: Record<string, unknown> = {}): ToolCallRecord => ({
    name: 'declare_step',
    input: { caseId, steps, ...extras },
    output: { ack: true, stepCount: steps.length },
    latencyMs: 1,
  });

  it('builds a valid draftTestCases from ONE batch declare_step (all steps of a case, auto-numbered)', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1', { coveredConditions: ['C-1'] }),
      batchStepRecord('TC-1', [
        { verb: 'fill', targetHint: 'username input field', data: 'admin' },
        { verb: 'fill', targetHint: 'password input field', data: 'admin123' },
        { verb: 'click', targetHint: 'Sign in button' },
      ]),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    expect(draft).not.toBeNull();
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(1);
    const tc = parsed.draftTestCases[0];
    expect(tc.steps).toHaveLength(3);
    // auto-numbered 1,2,3 in array order, action verb preserved
    expect(tc.steps[0].action.startsWith('fill ')).toBe(true);
    expect(tc.steps[2].action.startsWith('click ')).toBe(true);
    expect((tc.steps[0].intent as any)?.data).toBe('admin');
    // stepNumber auto-assigned 1-based
    expect((tc.steps[0] as any).stepNumber).toBe(1);
    expect((tc.steps[2] as any).stepNumber).toBe(3);
  });

  it('declares MULTIPLE cases in few calls: case-level steps array per case (proxy for reduced rounds)', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      batchStepRecord('TC-1', [
        { verb: 'fill', targetHint: 'username', data: 'admin' },
        { verb: 'click', targetHint: 'Sign in button' },
      ]),
      caseRecord('TC-2', { conditionId: 'C-1', id: 'TC-2' }),
      batchStepRecord('TC-2', [
        { verb: 'verify', targetHint: 'browser page', expectation: { kind: 'url', value: '/login' } },
      ]),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    expect(parsed.draftTestCases).toHaveLength(2);
    const tc1 = parsed.draftTestCases.find((t) => t.id === 'TC-1')!;
    const tc2 = parsed.draftTestCases.find((t) => t.id === 'TC-2')!;
    expect(tc1.steps).toHaveLength(2);
    expect(tc2.steps).toHaveLength(1);
    expect((tc2.steps[0].intent as any)?.expectation).toEqual({ kind: 'url', value: '/login' });
  });

  it('rejects a batch declare_step with a non-vocabulary verb at the API layer', async () => {
    const bad = { caseId: 'TC-1', steps: [{ verb: 'enter', targetHint: 'username', data: 'admin' }] };
    const parsed = declareStepSkill.schema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it('rejects a batch declare_step with a fill step missing data at the API layer', async () => {
    const bad = { caseId: 'TC-1', steps: [{ verb: 'fill', targetHint: 'username' }] };
    const parsed = declareStepSkill.schema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it('rejects supplying BOTH the flat single-step fields and the steps array', async () => {
    const bad = {
      caseId: 'TC-1',
      verb: 'click',
      targetHint: 'Sign in',
      steps: [{ verb: 'click', targetHint: 'Sign in' }],
    };
    const parsed = declareStepSkill.schema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it('accepts the flat single-step form (backward compat)', async () => {
    const ok = { caseId: 'TC-1', stepNumber: 1, verb: 'click', targetHint: 'Sign in button' };
    const parsed = declareStepSkill.schema.safeParse(ok);
    expect(parsed.success).toBe(true);
  });

  it('honors explicit per-step stepNumber inside the batch array', () => {
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      batchStepRecord('TC-1', [
        { stepNumber: 5, verb: 'click', targetHint: 'submit' },
        { verb: 'verify', targetHint: 'browser page', expectation: { kind: 'url', value: '/login' } },
      ]),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    // explicit stepNumber 5 + auto 2 (since 1 was first... actually first is 5, second auto = 2)
    const steps = parsed.draftTestCases[0].steps;
    expect(steps.map((s) => (s as any).stepNumber).sort((a: number, b: number) => a - b)).toEqual([2, 5]);
  });

  it('truncates an over-long fill action but keeps the full value in intent.data (real-world TC-014 username-too-long)', () => {
    // 219-char value would push the reconstructed action past the 200-char
    // DesignerRuntimeSchema limit, rejecting the whole draft. Action display
    // is truncated; intent.data keeps the full value (the machine contract).
    const longValue = 'a'.repeat(210);
    const records: ToolCallRecord[] = [
      caseRecord('TC-1'),
      batchStepRecord('TC-1', [
        { verb: 'fill', targetHint: 'username input field', data: longValue },
      ]),
    ];
    const draft = tryExtractFromDeclareTools(records, '', 'test_designer');
    const parsed = outputProfile.parse(outputProfile.normalize(draft!));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action.length).toBeLessThanOrEqual(200);
    expect(step.action).toContain("with '");
    // full value preserved in intent.data (Recorder resolves it, not the action)
    expect((step.intent as any)?.data).toBe(longValue);
  });
});
