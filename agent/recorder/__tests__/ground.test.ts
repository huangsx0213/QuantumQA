import { describe, it, expect } from 'vitest';
import { selectProbeTargets, formatLegacyEnrichment, type EvidencePack } from '../ground';
import type { RecorderStepPayload } from '../protocol';

function payload(overrides: Partial<RecorderStepPayload> = {}): RecorderStepPayload {
  return {
    action: 'click',
    locatorCandidates: [],
    pageUrl: 'https://app.test/page',
    timestamp: Date.now(),
    ...overrides,
  };
}

const officialSel = (s: string) => ({ kind: 'official' as const, selector: s });

describe('selectProbeTargets', () => {
  it('returns [] for empty or element-less payloads', () => {
    expect(selectProbeTargets([])).toEqual([]);
    expect(selectProbeTargets([
      payload({ action: 'goto', value: 'https://app.test/login' }),
      payload({ action: 'press', locatorCandidates: [] }),
    ])).toEqual([]);
  });

  it('skips goto but keeps interactive payloads with locators', () => {
    const targets = selectProbeTargets([
      payload({ action: 'goto', value: 'https://app.test/x' }),
      payload({ action: 'fill', locator: officialSel('#user') }),
      payload({ action: 'click', locator: officialSel('#btn') }),
    ]);
    expect(targets.map(t => t.action)).toEqual(['fill', 'click']);
    expect(targets.map(t => t.payloadIndex)).toEqual([1, 2]);
  });

  it('dedupes by selector keeping the LAST occurrence', () => {
    const targets = selectProbeTargets([
      payload({ action: 'fill', locator: officialSel('#user') }),
      payload({ action: 'click', locator: officialSel('#btn') }),
      payload({ action: 'fill', locator: officialSel('#user') }),
    ]);
    expect(targets).toHaveLength(2);
    const user = targets.find(t => t.locator.selector === '#user');
    expect(user?.payloadIndex).toBe(2);
    expect(user?.action).toBe('fill');
  });

  it('caps at MAX_PROBED_ELEMENTS=3 keeping chronological order', () => {
    const targets = selectProbeTargets([
      payload({ action: 'fill', locator: officialSel('#a') }),
      payload({ action: 'fill', locator: officialSel('#b') }),
      payload({ action: 'fill', locator: officialSel('#c') }),
      payload({ action: 'fill', locator: officialSel('#d') }),
    ]);
    expect(targets.map(t => t.locator.selector)).toEqual(['#b', '#c', '#d']);
    expect(targets.map(t => t.payloadIndex)).toEqual([1, 2, 3]);
  });
});

describe('formatLegacyEnrichment', () => {
  it('joins input lines and text excerpt with newlines', () => {
    const pack: EvidencePack = {
      nlStepIndex: 0,
      pageUrl: 'https://app.test',
      textExcerpt: 'Welcome back',
      inputValues: [{ name: 'username', value: 'admin' }, { name: 'pwd', value: '' }],
      actedElements: [],
      networkCalls: [],
    };
    expect(formatLegacyEnrichment(pack)).toBe('username: admin\npwd: \nWelcome back');
  });

  it('omits empty sections and handles a bare pack', () => {
    const bare: EvidencePack = { nlStepIndex: 1, pageUrl: '', textExcerpt: '', inputValues: [], actedElements: [], networkCalls: [] };
    expect(formatLegacyEnrichment(bare)).toBe('');
    const onlyText: EvidencePack = { nlStepIndex: 1, pageUrl: '', textExcerpt: 'hello', inputValues: [], actedElements: [], networkCalls: [] };
    expect(formatLegacyEnrichment(onlyText)).toBe('hello');
  });
});
