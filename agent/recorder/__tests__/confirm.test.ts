import { describe, it, expect } from 'vitest';
import { applyAiAssertions, emitAssertions, decideConfirmationVerdict, harvestAssertionResults } from '../refiner';
import type { TestStep, StepAssertion } from '../../../shared/contracts/index';

describe('refiner · harvestAssertionResults', () => {
  it('collects structured assertion results from execution logs by id', () => {
    const logs = [
      { stepId: 's1', status: 'INFO', message: 'step start' },
      { stepId: 's1', status: 'PASS', message: '✅ [UI_PAGE_URL] CONTAINS', metadata: { assertionId: 'A1', passed: true, actualValue: 'https://x/dashboard' } },
      { stepId: 's2', status: 'FAIL', message: '❌ mismatch', metadata: { assertionId: 'A2', passed: false, actualValue: '' } },
      { stepId: 's2', status: 'PASS', message: 'no metadata' },
      { stepId: 's3', status: 'PASS', message: 'bad meta shape', metadata: { assertionId: 42, passed: 'yes' } },
    ];
    const harvested = harvestAssertionResults(logs as any);
    expect(harvested.get('A1')).toEqual([{ passed: true, actualValue: 'https://x/dashboard', message: '✅ [UI_PAGE_URL] CONTAINS' }]);
    expect(harvested.get('A2')![0].passed).toBe(false);
    expect(harvested.size).toBe(2);
  });
});


const pass = (actual?: string): { passed: boolean; actualValue?: string } => ({ passed: true, actualValue: actual });
const fail = (actual?: string): { passed: boolean; actualValue?: string } => ({ passed: false, actualValue: actual });

describe('confirm · decideConfirmationVerdict（判定矩阵）', () => {
  it('PASS+PASS → ai-confirmed', () => {
    expect(decideConfirmationVerdict([pass('a'), pass('a')])).toBe('ai-confirmed');
  });
  it('PASS+FAIL 与 FAIL+PASS → needs-review', () => {
    expect(decideConfirmationVerdict([pass(), fail()])).toBe('needs-review');
    expect(decideConfirmationVerdict([fail(), pass()])).toBe('needs-review');
  });
  it('FAIL+FAIL → needs-review', () => {
    expect(decideConfirmationVerdict([fail(), fail()])).toBe('needs-review');
  });
  it('证据不足（仅一次运行）→ needs-review', () => {
    expect(decideConfirmationVerdict([pass()])).toBe('needs-review');
  });
});

// === Emit 三态 ===

function stepWith(overrides: Partial<TestStep> & { id: string }): TestStep {
  return {
    action: 'fill',
    target: '#user',
    data: '',
    description: '',
    isVerified: true,
    metadata: {},
    ...overrides,
  } as TestStep;
}

describe('refiner · applyAiAssertions provenance', () => {
  it('records origin into metadata.assertionProvenance（缺省 ai）', () => {
    const s1 = stepWith({ id: 'a' });
    (s1.metadata as any).aiAssertion = { source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: 'admin', expectedText: 'shows admin' };
    const s2 = stepWith({ id: 'b' });
    (s2.metadata as any).aiAssertion = { source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: '/home', origin: 'rule' };

    const [out1, out2] = applyAiAssertions([s1, s2]);
    expect((out1.metadata as any).assertionProvenance['assert-a']).toBe('ai');
    expect(out1.assertions![0].id).toBe('assert-a');
    expect((out2.metadata as any).assertionProvenance['assert-b']).toBe('rule');
  });
});

describe('refiner · emitAssertions 三态落库', () => {
  const mkAssert = (id: string): StepAssertion => ({
    id, source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: '/dashboard',
  });

  it('report=null：ai 来源标 unconfirmed 保留可执行？——不，移入 review', () => {
    const step = stepWith({ id: 'x', assertions: [mkAssert('A')], metadata: { assertionProvenance: { A: 'ai' } } });
    const out = emitAssertions([step], null)[0];
    expect(out.assertions).toHaveLength(0);
    const review = (out.metadata as any).reviewAssertions;
    expect(review[0]).toMatchObject({ reason: 'not exercised by confirmation run' });
  });

  it('report=null：rule 来源直接落库带 [rule] 标记', () => {
    const step = stepWith({ id: 'x', assertions: [mkAssert('R')], metadata: { assertionProvenance: { R: 'rule' } } });
    const out = emitAssertions([step], null)[0];
    expect(out.assertions![0].message).toContain('[rule]');
    expect((out.metadata as any).reviewAssertions).toBeUndefined();
  });

  it('两次 PASS → [ai-confirmed×2] 可执行', () => {
    const step = stepWith({ id: 'x', assertions: [mkAssert('A')], metadata: { assertionProvenance: { A: 'ai' } } });
    const report = { entries: [{ assertionId: 'A', runs: [pass(), pass()] }], completedRuns: 2, infraFailureRuns: 0 };
    const out = emitAssertions([step], report as any)[0];
    expect(out.assertions![0].message).toContain('[ai-confirmed×2]');
  });

  it('flaky / 全败 / 基础设施故障 → review 并附证据', () => {
    const mk = (runs: Array<{ passed: boolean; actualValue?: string }> = [], infra = 0) =>
      stepWith({
        id: 'x',
        assertions: [mkAssert('A')],
        metadata: { assertionProvenance: { A: 'ai' } },
      });
    const flaky = emitAssertions([mk([])], { entries: [{ assertionId: 'A', runs: [pass(), fail('404')] }], completedRuns: 2, infraFailureRuns: 0 } as any)[0];
    expect(flaky.assertions).toHaveLength(0);
    expect(((flaky.metadata as any).reviewAssertions as any[])[0]).toMatchObject({ reason: 'flaky across confirmation runs' });

    const allFail = emitAssertions([mk([])], { entries: [{ assertionId: 'A', runs: [fail('a'), fail('b')] }], completedRuns: 2, infraFailureRuns: 0 } as any)[0];
    expect(((allFail.metadata as any).reviewAssertions as any[])[0]).toMatchObject({ reason: 'failed all confirmation runs' });
    expect(((allFail.metadata as any).reviewAssertions as any[])[0].runs[1].actualValue).toBe('b');

    const infra = emitAssertions([mk([])], { entries: [{ assertionId: 'A', runs: [pass(), pass()] }], completedRuns: 0, infraFailureRuns: 1 } as any)[0];
    expect(infra.assertions).toHaveLength(0);
    expect(((infra.metadata as any).reviewAssertions as any[])[0]).toMatchObject({ reason: 'confirmation run infrastructure failure' });
  });
});
