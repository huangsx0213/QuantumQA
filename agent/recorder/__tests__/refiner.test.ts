import { describe, it, expect } from 'vitest';
import { refineDraftSuite, dedupeSteps, mapAssertions, parameterize, redactSecrets, redactValue, extractSecretValues, expandSelectors, markProvenance, applyAiAssertions } from '../refiner';
import type { TestStep, UIElement, NlTestCaseTestData } from '../../../shared/contracts/index.ts';

function makeStep(overrides: Partial<TestStep> = {}): TestStep {
  return {
    id: 's1',
    action: 'click',
    target: 'Login button',
    data: '',
    description: 'Click on Login button',
    isVerified: true,
    metadata: { recorder: { locator: { kind: 'official', selector: 'internal:role=button[name="Login"]' } } },
    ...overrides,
  };
}

describe('Refiner pipeline', () => {
  it('refineDraftSuite runs full pipeline and returns refined suite', () => {
    const steps = [
      makeStep({ id: 's1', action: 'goto', target: 'https://app.com/login', data: 'https://app.com/login' }),
      makeStep({ id: 's2', action: 'fill', target: 'Username', data: 'admin' }),
      makeStep({ id: 's3', action: 'fill', target: 'Username', data: 'admin' }), // duplicate
      makeStep({ id: 's4', action: 'fill', target: 'Password', data: 'secret123' }),
      makeStep({ id: 's5', action: 'click', target: 'Login button' }),
    ];
    const result = refineDraftSuite(steps, {
      secrets: ['secret123'],
      parameters: { username: 'admin' },
    });
    expect(result.steps.length).toBe(4); // s3 deduped
    expect(result.steps.find(s => s.target === 'Password')?.data).toBe('***');
    expect(result.steps.find(s => s.target === 'Username')?.data).toBe('{{username}}');
    expect(result.provenance).toBeDefined();
    expect(result.provenance.source).toBe('ai-recorder');
  });
});

describe('dedupeSteps', () => {
  it('removes consecutive identical steps', () => {
    const steps = [
      makeStep({ id: 's1', action: 'click', target: 'btn' }),
      makeStep({ id: 's2', action: 'click', target: 'btn' }),
      makeStep({ id: 's3', action: 'fill', target: 'input', data: 'x' }),
    ];
    expect(dedupeSteps(steps).length).toBe(2);
  });

  it('keeps non-consecutive duplicates', () => {
    const steps = [
      makeStep({ id: 's1', action: 'click', target: 'btn' }),
      makeStep({ id: 's2', action: 'fill', target: 'input', data: 'x' }),
      makeStep({ id: 's3', action: 'click', target: 'btn' }),
    ];
    expect(dedupeSteps(steps).length).toBe(3);
  });

  it('compares action+target+data', () => {
    const steps = [
      makeStep({ id: 's1', action: 'fill', target: 'input', data: 'a' }),
      makeStep({ id: 's2', action: 'fill', target: 'input', data: 'b' }),
    ];
    expect(dedupeSteps(steps).length).toBe(2);
  });

  it('preserves assertions from the deduped duplicate (start nav vs step0 goto)', () => {
    const steps = [
      makeStep({ id: 's1', action: 'goto', target: 'https://app.com/login', data: 'https://app.com/login' }),
      makeStep({
        id: 's2',
        action: 'goto',
        target: 'https://app.com/login',
        data: 'https://app.com/login',
        metadata: { aiAssertion: { source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: '/login' } },
      }),
    ];
    const out = dedupeSteps(steps);
    expect(out).toHaveLength(1);
    expect((out[0].metadata as any).aiAssertion).toMatchObject({ source: 'UI_PAGE_URL', expectedValue: '/login' });
  });
});

describe('mapAssertions', () => {
  it('marks verify/assert steps as assertions', () => {
    const steps = [
      makeStep({ id: 's1', action: 'click', target: 'btn' }),
      makeStep({ id: 's2', action: 'assertVisible', target: 'Welcome' }),
      makeStep({ id: 's3', action: 'assertText', target: 'Title', data: 'Dashboard' }),
    ];
    const result = mapAssertions(steps);
    expect((result[0] as any).isAssertion).toBeFalsy();
    expect((result[1] as any).isAssertion).toBe(true);
    expect((result[2] as any).isAssertion).toBe(true);
  });
});

describe('parameterize', () => {
  it('replaces parameter values with template syntax', () => {
    const steps = [makeStep({ action: 'fill', target: 'Username', data: 'admin' })];
    const result = parameterize(steps, { username: 'admin' });
    expect(result[0].data).toBe('{{username}}');
  });

  it('leaves non-parameter values unchanged', () => {
    const steps = [makeStep({ action: 'fill', target: 'Notes', data: 'hello' })];
    const result = parameterize(steps, { username: 'admin' });
    expect(result[0].data).toBe('hello');
  });
});

describe('redactValue', () => {
  it('replaces exact secret matches only', () => {
    expect(redactValue('secret123', ['secret123'])).toBe('***');
    expect(redactValue('login-secret123-page', ['secret123'])).toBe('login-secret123-page');
    expect(redactValue('', ['x'])).toBe('');
  });

  it('handles empty secrets list', () => {
    expect(redactValue('secret123', [])).toBe('secret123');
  });
});

describe('extractSecretValues', () => {
  it('extracts values whose key matches password/secret/token/key (case-insensitive)', () => {
    const testData: NlTestCaseTestData[] = [
      { key: 'username', value: 'admin', description: 'login user' },
      { key: 'password', value: 'pw-1', description: 'login password' },
      { key: 'apiToken', value: 'tok-1', description: 'api token' },
      { key: 'apiKey', value: 'key-1', description: 'api key' },
    ];
    expect(extractSecretValues(testData)).toEqual(['pw-1', 'tok-1', 'key-1']);
  });
});

describe('redactSecrets', () => {
  it('replaces secret values with ***', () => {
    const steps = [makeStep({ action: 'fill', target: 'Password', data: 'mypassword' })];
    const result = redactSecrets(steps, ['mypassword']);
    expect(result[0].data).toBe('***');
  });

  it('handles empty secrets list', () => {
    const steps = [makeStep({ action: 'fill', target: 'Password', data: 'mypassword' })];
    const result = redactSecrets(steps, []);
    expect(result[0].data).toBe('mypassword');
  });
});

describe('expandSelectors', () => {
  it('adds fallback selectors from locatorCandidates', () => {
    const step = makeStep({
      metadata: {
        recorder: {
          locator: { kind: 'official', selector: 'internal:role=button[name="Login"]' },
          locatorCandidates: [
            { kind: 'css', selector: '#login-btn' },
            { kind: 'xpath', selector: '//button[@id="login-btn"]' },
          ],
        },
      },
    });
    const result = expandSelectors([step]);
    expect((result[0].metadata?.recorder as any)?.allLocators).toBeDefined();
    expect((result[0].metadata?.recorder as any)?.allLocators.length).toBe(3); // primary + 2 candidates
  });
});

describe('markProvenance', () => {
  it('marks each step with ai-recorder provenance', () => {
    const steps = [makeStep()];
    const result = markProvenance(steps, { source: 'ai-recorder', runId: 'run-1', ts: 1000 });
    expect((result[0].metadata?.provenance as any)?.source).toBe('ai-recorder');
    expect((result[0].metadata?.provenance as any)?.runId).toBe('run-1');
  });
});

describe('applyAiAssertions', () => {
  function stepWithAiAssertion(aiAssertion: Record<string, unknown>) {
    return makeStep({
      id: 's-ai',
      metadata: {
        recorder: { locator: { kind: 'official', selector: '#x' } },
        aiAssertion,
      } as any,
    });
  }

  it('attaches a valid AI proposal as StepAssertion with provenance message', () => {
    const result = applyAiAssertions([
      stepWithAiAssertion({ source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'admin', expectedText: 'The username field displays admin' }),
    ]);
    expect(result[0].assertions).toHaveLength(1);
    const a = result[0].assertions![0];
    expect(a.source).toBe('UI_VALUE');
    expect(a.operator).toBe('EQUALS');
    expect(a.expectedValue).toBe('admin');
    expect(a.id).toBe('assert-s-ai');
    expect(a.message).toContain('AI generated from expected');
    expect(a.message).toContain('The username field displays admin');
  });

  it('drops proposals with invalid source or operator', () => {
    const r1 = applyAiAssertions([stepWithAiAssertion({ source: 'MAGIC_SOURCE', operator: 'EQUALS', expectedValue: 'x' })]);
    const r2 = applyAiAssertions([stepWithAiAssertion({ source: 'UI_TEXT', operator: 'GREATER_THAN', expectedValue: '5' })]);
    expect(r1[0].assertions ?? []).toHaveLength(0);
    expect(r2[0].assertions ?? []).toHaveLength(0);
  });

  it('drops proposals missing expectedValue for operators that need it', () => {
    const r = applyAiAssertions([stepWithAiAssertion({ source: 'UI_TEXT', operator: 'EQUALS' })]);
    expect(r[0].assertions ?? []).toHaveLength(0);
  });

  it('allows EXISTS without expectedValue', () => {
    const r = applyAiAssertions([stepWithAiAssertion({ source: 'UI_ELEMENT_VISIBLE', operator: 'EXISTS' })]);
    expect(r[0].assertions).toHaveLength(1);
    expect(r[0].assertions![0].operator).toBe('EXISTS');
  });

  it('steps without aiAssertion metadata pass through unchanged', () => {
    const step = makeStep({ assertions: [{ id: 'a1', source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'x' }] });
    const result = applyAiAssertions([step]);
    expect(result[0].assertions).toHaveLength(1);
    expect(result[0].assertions![0].id).toBe('a1');
  });

  it('full pipeline: aiAssertion → assertion, expectedValue parameterized and secret redacted', () => {
    const steps = [
      makeStep({
        id: 's1',
        action: 'fill',
        target: 'Username',
        data: 'admin',
        metadata: {
          recorder: { locator: { kind: 'official', selector: '#user' } },
          aiAssertion: { source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'admin', expectedText: 'field shows admin' },
        } as any,
      }),
      makeStep({
        id: 's2',
        action: 'fill',
        target: 'Password',
        data: 'pw-secret',
        metadata: {
          recorder: { locator: { kind: 'official', selector: '#pw' } },
          aiAssertion: { source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'pw-secret', expectedText: 'password accepted' },
        } as any,
      }),
    ];
    const result = refineDraftSuite(steps, {
      secrets: ['pw-secret'],
      parameters: { username: 'admin' },
    });

    const usernameStep = result.steps.find(s => s.target === 'Username')!;
    expect(usernameStep.assertions).toHaveLength(1);
    expect(usernameStep.assertions![0].expectedValue).toBe('{{username}}'); // 参数化同步到断言
    expect(usernameStep.assertions![0].message).toContain('field shows admin');

    const passwordStep = result.steps.find(s => s.target === 'Password')!;
    expect(passwordStep.assertions![0].expectedValue).toBe('***'); // 脱敏同步到断言
  });
});
