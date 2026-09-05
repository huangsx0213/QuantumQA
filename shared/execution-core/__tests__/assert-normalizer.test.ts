import { describe, it, expect } from 'vitest';
import { actionToAssertion, normalizeAssertSteps, isAssertAction } from '../assert-normalizer';
import type { TestStep } from '../../contracts/index';

function step(overrides: Partial<TestStep> & { id: string; action: string }): TestStep {
  return {
    target: '',
    data: '',
    description: '',
    isVerified: true,
    metadata: {},
    ...overrides,
  } as TestStep;
}

describe('assert-normalizer · actionToAssertion', () => {
  it('maps each assert action to the correct StepAssertion with stable id', () => {
    expect(actionToAssertion('assertVisible', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'true',
    });
    expect(actionToAssertion('assertHidden', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'false',
    });
    expect(actionToAssertion('assertInvisible', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'false',
    });
    expect(actionToAssertion('assertEnabled', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'true',
    });
    expect(actionToAssertion('assertDisabled', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_ENABLED', operator: 'EQUALS', expectedValue: 'false',
    });
    expect(actionToAssertion('assertChecked', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'true',
    });
    expect(actionToAssertion('assertUnchecked', undefined, 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ELEMENT_CHECKED', operator: 'EQUALS', expectedValue: 'false',
    });
    expect(actionToAssertion('assertText', 'Hello', 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_TEXT', operator: 'EQUALS', expectedValue: 'Hello',
    });
    expect(actionToAssertion('assertValue', 'admin', 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'admin',
    });
    expect(actionToAssertion('assertUrl', '/dashboard', 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_PAGE_URL', operator: 'EQUALS', expectedValue: '/dashboard',
    });
    expect(actionToAssertion('assertTitle', 'Dashboard', 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_PAGE_TITLE', operator: 'EQUALS', expectedValue: 'Dashboard',
    });
    expect(actionToAssertion('assertAttribute', 'aria-label=Close', 's1')).toMatchObject({
      id: 'assert-s1', source: 'UI_ATTRIBUTE', expression: 'aria-label', operator: 'EQUALS', expectedValue: 'Close',
    });
  });

  it('returns null for unconvertible or unsupported actions', () => {
    expect(actionToAssertion('assertText', undefined, 's1')).toBeNull();
    expect(actionToAssertion('assertValue', undefined, 's1')).toBeNull();
    expect(actionToAssertion('assertUrl', undefined, 's1')).toBeNull();
    expect(actionToAssertion('assertAttribute', 'noEquals', 's1')).toBeNull();
    expect(actionToAssertion('assertNotExist', undefined, 's1')).toBeNull();
    expect(actionToAssertion('click', undefined, 's1')).toBeNull();
  });

  it('isAssertAction recognizes assert verbs only', () => {
    expect(isAssertAction('assertVisible')).toBe(true);
    expect(isAssertAction('assertText')).toBe(true);
    expect(isAssertAction('click')).toBe(false);
    expect(isAssertAction('verify')).toBe(false);
  });
});

describe('assert-normalizer · Form B (standalone assert step)', () => {
  it('keeps an assert step without a merge target, attaching an explicit assertion', () => {
    const steps = [
      step({ id: 's-goto', action: 'goto', target: '/login', data: '/login' }),
      step({ id: 's-assert', action: 'assertVisible', target: 'Login Page.Forgot Link', data: '' }),
    ];
    const out = normalizeAssertSteps(steps);

    expect(out).toHaveLength(2);
    // goto step untouched
    expect(out[0]).toMatchObject({ id: 's-goto', action: 'goto' });
    expect((out[0] as any).assertions).toBeUndefined();
    // assert step kept as standalone with explicit rule assertion
    expect(out[1]).toMatchObject({ id: 's-assert', action: 'assertVisible', target: 'Login Page.Forgot Link' });
    expect(out[1].assertions).toHaveLength(1);
    expect(out[1].assertions![0]).toMatchObject({ id: 'assert-s-assert', source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'true' });
    expect((out[1].metadata as any).assertionProvenance['assert-s-assert']).toBe('rule');
  });

  it('keeps an assert after an action on a DIFFERENT element as standalone', () => {
    const steps = [
      step({ id: 's-click', action: 'click', target: 'Products Page.Add Backpack', data: '' }),
      step({ id: 's-assert', action: 'assertText', target: 'Products Page.Cart Badge', data: '1' }),
    ];
    const out = normalizeAssertSteps(steps);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 's-click', action: 'click' });
    expect(out[1]).toMatchObject({ id: 's-assert', action: 'assertText', target: 'Products Page.Cart Badge' });
    expect(out[1].assertions).toHaveLength(1);
    expect(out[1].assertions![0]).toMatchObject({ source: 'UI_TEXT', expectedValue: '1' });
  });

  it('keeps assertNotExist as a standalone step (engine handles it natively)', () => {
    const steps = [step({ id: 's-assert', action: 'assertNotExist', target: '#spinner', data: '' })];
    const out = normalizeAssertSteps(steps);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('assertNotExist');
    expect(out[0].assertions).toBeUndefined();
  });

  it('keeps an unconvertible assert (missing data) as-is', () => {
    const steps = [step({ id: 's-assert', action: 'assertText', target: '#x', data: undefined })];
    const out = normalizeAssertSteps(steps);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('assertText');
    expect(out[0].assertions).toBeUndefined();
  });

  it('clears target on standalone page-level asserts (target is not an element selector)', () => {
    const steps = [step({ id: 's-assert', action: 'assertUrl', target: '/dashboard', data: '/dashboard' })];
    const out = normalizeAssertSteps(steps);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBeUndefined();
    expect(out[0].assertions![0]).toMatchObject({ source: 'UI_PAGE_URL', expectedValue: '/dashboard' });
  });
});

describe('assert-normalizer · Form A (merge into existing step)', () => {
  it('merges an assertValue into a preceding fill on the SAME element', () => {
    const steps = [
      step({ id: 's-fill', action: 'fill', target: '#username', data: 'admin' }),
      step({ id: 's-assert', action: 'assertValue', target: '#username', data: 'admin' }),
    ];
    const out = normalizeAssertSteps(steps);

    expect(out).toHaveLength(1); // assert step removed
    expect(out[0]).toMatchObject({ id: 's-fill', action: 'fill', target: '#username', data: 'admin' });
    expect(out[0].assertions).toHaveLength(1);
    expect(out[0].assertions![0]).toMatchObject({ id: 'assert-s-assert', source: 'UI_VALUE', expectedValue: 'admin' });
    expect((out[0].metadata as any).assertionProvenance['assert-s-assert']).toBe('rule');
  });

  it('merges multiple asserts on the same element into one step', () => {
    const steps = [
      step({ id: 's-fill', action: 'fill', target: '#username', data: 'admin' }),
      step({ id: 's-a1', action: 'assertValue', target: '#username', data: 'admin' }),
      step({ id: 's-a2', action: 'assertVisible', target: '#username', data: '' }),
    ];
    const out = normalizeAssertSteps(steps);

    expect(out).toHaveLength(1);
    expect(out[0].assertions).toHaveLength(2);
    expect(out[0].assertions![0]).toMatchObject({ id: 'assert-s-a1', source: 'UI_VALUE' });
    expect(out[0].assertions![1]).toMatchObject({ id: 'assert-s-a2', source: 'UI_ELEMENT_VISIBLE' });
  });

  it('merges page-level assertUrl into the nearest action step (not the assert itself)', () => {
    const steps = [
      step({ id: 's-goto', action: 'goto', target: '/login', data: '/login' }),
      step({ id: 's-click', action: 'click', target: '#submit', data: '' }),
      step({ id: 's-assert', action: 'assertUrl', target: '', data: '/dashboard' }),
    ];
    const out = normalizeAssertSteps(steps);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 's-goto' });
    expect(out[1]).toMatchObject({ id: 's-click' });
    expect(out[1].assertions![0]).toMatchObject({ source: 'UI_PAGE_URL', expectedValue: '/dashboard' });
  });

  it('matches elements via recorder locator selector when target differs in form', () => {
    const steps = [
      step({
        id: 's-fill', action: 'fill', target: '#username', data: 'admin',
        metadata: { recorder: { locator: { kind: 'css', selector: '#username' } } },
      }),
      step({
        id: 's-assert', action: 'assertValue', target: '#username', data: 'admin',
        metadata: { recorder: { locator: { kind: 'css', selector: '#username' } } },
      }),
    ];
    const out = normalizeAssertSteps(steps);
    expect(out).toHaveLength(1);
    expect(out[0].assertions).toHaveLength(1);
  });
});

describe('assert-normalizer · idempotency', () => {
  it('does not re-normalize steps that already carry explicit assertions', () => {
    const alreadyNormalized = step({
      id: 's-assert', action: 'assertVisible', target: '#x', data: '',
      assertions: [{ id: 'assert-s-assert', source: 'UI_ELEMENT_VISIBLE', operator: 'EQUALS', expectedValue: 'true' }],
      metadata: { assertionProvenance: { 'assert-s-assert': 'rule' } },
    });
    const out = normalizeAssertSteps([alreadyNormalized]);

    expect(out).toHaveLength(1);
    expect(out[0].assertions).toHaveLength(1); // no duplicate
    expect(out[0].assertions![0].id).toBe('assert-s-assert');
  });

  it('merging is stable: result has no assert action steps left', () => {
    const steps = [
      step({ id: 's-fill', action: 'fill', target: '#a', data: 'x' }),
      step({ id: 's-assert', action: 'assertValue', target: '#a', data: 'x' }),
    ];
    const once = normalizeAssertSteps(steps);
    const twice = normalizeAssertSteps(once);
    expect(twice).toHaveLength(1);
    expect(twice[0].assertions).toHaveLength(1);
  });
});