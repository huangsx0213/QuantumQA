import { describe, it, expect, vi } from 'vitest';
import { deriveRuleProposals, findCoveringRule } from '../compile/rules';
import { checkProposalStatic, passesGate, sourceCompatibleWithTag, DEFAULT_MIN_CONFIDENCE, verifyAgainstEvidence, type GateProposal } from '../compile/gate';
import { AdjudicationSchema, buildAdjudicationPrompt, createStagehandProposer } from '../compile/proposer';
import type { EvidencePack } from '../ground';
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

function evidence(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    nlStepIndex: 0,
    pageUrl: 'https://app.test/dashboard',
    pageTitle: 'Dashboard',
    textExcerpt: 'Welcome back, admin',
    inputValues: [{ name: 'username', value: 'admin' }],
    actedElements: [
      { payloadIndex: 1, action: 'fill', selector: '#username', tag: 'input', value: 'admin', visible: true },
      { payloadIndex: 2, action: 'click', selector: 'internal:role=button[name="Login"]', tag: 'button', visible: true },
    ],
    networkCalls: [],
    ...overrides,
  };
}

describe('compile · rules.deriveRuleProposals', () => {
  it('derives UI_VALUE from the last value-bearing fill/selectOption', () => {
    const rules = deriveRuleProposals([
      payload({ action: 'fill', locator: { kind: 'css', selector: '#user' }, value: 'first' }),
      payload({ action: 'selectOption', locator: { kind: 'css', selector: '#role' }, value: 'admin-role' }),
      payload({ action: 'click', locator: { kind: 'css', selector: '#go' } }),
    ]);
    const value = rules.find(r => r.source === 'UI_VALUE');
    expect(value).toMatchObject({ operator: 'CONTAINS', expectedValue: 'admin-role', targetPayloadIndex: 1, origin: 'rule', confidence: 1 });
  });

  it('derives UI_PAGE_URL from goto and skips empty fills', () => {
    const rules = deriveRuleProposals([
      payload({ action: 'goto', value: 'https://app.test/login' }),
      payload({ action: 'fill', locator: { kind: 'css', selector: '#user' }, value: '' }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: 'https://app.test/login' });
  });

  it('derives UI_ELEMENT_CHECKED from check/uncheck actions', () => {
    const rules = deriveRuleProposals([
      payload({ action: 'check', locator: { kind: 'css', selector: '#tos' } }),
      payload({ action: 'uncheck', locator: { kind: 'css', selector: '#spam' } }),
    ]);
    expect(rules.find(r => r.source === 'UI_ELEMENT_CHECKED')).toMatchObject({
      operator: 'EQUALS', expectedValue: 'true', targetPayloadIndex: 0,
    });
  });

  it('returns [] when nothing derivable', () => {
    expect(deriveRuleProposals([payload({ action: 'click' })])).toEqual([]);
  });
});

describe('compile · rules.findCoveringRule', () => {
  it('covers when expected contains the filled value verbatim', () => {
    const [value] = deriveRuleProposals([payload({ action: 'fill', value: 'admin' })]);
    expect(findCoveringRule('Username field shows admin value', [value!]))!.toBe(value);
  });

  it('covers via token containment (word boundaries / punctuation)', () => {
    const [value] = deriveRuleProposals([payload({ action: 'fill', value: 'admin@example.com' })]);
    expect(findCoveringRule('The email admin@example.com is accepted', [value!]))!.toBe(value);
  });

  it('covers URL rule via hostname or path segment in expected', () => {
    const [url] = deriveRuleProposals([payload({ action: 'goto', value: 'https://portal.test/dashboard/main' })]);
    expect(findCoveringRule('User lands on the dashboard page', [url!]))!.toBe(url);
    expect(findCoveringRule('Stays on login form', [url!])).toBeNull();
  });

  it('does not cover unrelated expectations', () => {
    const [value] = deriveRuleProposals([payload({ action: 'fill', value: 'admin' })]);
    expect(findCoveringRule('A welcome banner is displayed', [value!])).toBeNull();
  });

  it('handles Chinese tokens', () => {
    const [value] = deriveRuleProposals([payload({ action: 'fill', value: '张三' })]);
    expect(findCoveringRule('用户名输入框显示张三', [value!]))!.toBe(value);
  });
});

describe('compile · gate', () => {
  it('rejects illegal enums and missing expectedValue', () => {
    const ev = evidence();
    expect(checkProposalStatic({ source: 'UI_VALUE', operator: 'HAS_LENGTH', expectedValue: '2', origin: 'ai' }, ev).ok).toBe(false);
    expect(checkProposalStatic({ source: 'NOT_A_SOURCE', operator: 'CONTAINS', origin: 'ai' }, ev).ok).toBe(false);
    expect(
      checkProposalStatic({ source: 'UI_VALUE', operator: 'CONTAINS', origin: 'ai', targetPayloadIndex: 1 }, ev).ok,
    ).toBe(false);
  });

  it('enforces confidence threshold for ai proposals; rule defaults to pass', () => {
    const ev = evidence();
    const base = { source: 'UI_TEXT', operator: 'CONTAINS' as const, expectedValue: 'Welcome', targetPayloadIndex: 2 };
    expect(checkProposalStatic({ ...base, origin: 'ai' }, ev).ok).toBe(false);
    expect(checkProposalStatic({ ...base, origin: 'ai', confidence: DEFAULT_MIN_CONFIDENCE }, ev).ok).toBe(true);
    expect(checkProposalStatic({ ...base, origin: 'rule', confidence: 1 }, ev).ok).toBe(true);
  });

  it('evidence verification rescues low-confidence proposals that match observed state', () => {
    const ev = evidence();
    // 复现真实案例：页面明明在 /dashboard，模型自报 confidence=0.32
    const url = { source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: '/dashboard', origin: 'ai', confidence: 0.32 };
    const res = checkProposalStatic(url as GateProposal, ev);
    expect(res.ok).toBe(true);
    expect(res.ok && res.proposal!.confidence).toBe(1);
    expect(res.ok && res.proposal!.rationale).toContain('verified against evidence');

    // 证据不符时低置信度仍被拒
    const wrongEv = evidence({ pageUrl: 'https://app.test/login' });
    expect(checkProposalStatic(url as GateProposal, wrongEv).ok).toBe(false);
  });

  it('evidence verification works for element-bound sources and rejects mismatches', () => {
    const ev = evidence({
      actedElements: [
        { payloadIndex: 1, action: 'fill', selector: '#username', tag: 'input', value: 'admin', visible: true },
        { payloadIndex: 2, action: 'click', selector: '#btn', tag: 'button', text: 'Welcome back, Admin!', visible: true },
      ],
    });
    const text = { source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'admin', targetPayloadIndex: 2, origin: 'ai', confidence: 0.4 };
    expect(checkProposalStatic(text as GateProposal, ev).ok).toBe(true);

    const value = { source: 'UI_VALUE', operator: 'EQUALS', expectedValue: 'admin', targetPayloadIndex: 1, origin: 'ai', confidence: 0.4 };
    expect(checkProposalStatic(value as GateProposal, ev).ok).toBe(true);

    const mismatch = { source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'Error occurred', targetPayloadIndex: 2, origin: 'ai', confidence: 0.4 };
    expect(checkProposalStatic(mismatch as GateProposal, ev).ok).toBe(false);

    // 无法实证的 source（UI_ELEMENT_COUNT）低置信度直接拒
    const unverifiable = { source: 'UI_ELEMENT_COUNT', operator: 'EQUALS', expectedValue: '3', targetPayloadIndex: 2, origin: 'ai', confidence: 0.4 };
    expect(checkProposalStatic(unverifiable as GateProposal, ev).ok).toBe(false);
  });

  it('verifyAgainstEvidence operator nuances', () => {
    const ev = evidence();
    expect(verifyAgainstEvidence({ source: 'UI_PAGE_URL', operator: 'EQUALS', expectedValue: 'https://app.test/dashboard' } as GateProposal, ev)).toBe(true);
    expect(verifyAgainstEvidence({ source: 'UI_PAGE_URL', operator: 'EQUALS', expectedValue: '/other' } as GateProposal, ev)).toBe(false);
    expect(verifyAgainstEvidence({ source: 'UI_ELEMENT_VISIBLE', operator: 'EXISTS', expectedValue: 'x', targetPayloadIndex: 1 } as GateProposal, ev)).toBe(true);
    expect(verifyAgainstEvidence({ source: 'UI_ELEMENT_VISIBLE', operator: 'EXISTS', expectedValue: 'x' } as GateProposal, ev)).toBeNull();
    expect(verifyAgainstEvidence({ source: 'UI_ATTRIBUTE', operator: 'CONTAINS', expectedValue: 'x', targetPayloadIndex: 1 } as GateProposal, ev)).toBeNull();
  });

  it('requires an element binding for element-bound sources', () => {
    const ev = evidence();
    const res = checkProposalStatic({ source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: 'admin', origin: 'rule', confidence: 1 }, ev);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('element binding');
  });

  it('applies the compatibility matrix (and unknown tags pass)', () => {
    expect(sourceCompatibleWithTag('UI_VALUE', 'input')).toBe(true);
    expect(sourceCompatibleWithTag('UI_VALUE', 'button')).toBe(false);
    expect(sourceCompatibleWithTag('UI_TEXT', 'input')).toBe(false);
    expect(sourceCompatibleWithTag('UI_ELEMENT_CHECKED', 'input')).toBe(true);
    expect(sourceCompatibleWithTag('UI_TEXT', undefined)).toBeNull();
    const badTagEv = evidence({ actedElements: [{ payloadIndex: 1, action: 'click', selector: '#x', tag: 'button' }] });
    expect(
      checkProposalStatic({ source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: 'v', origin: 'rule', confidence: 1, targetPayloadIndex: 1 }, badTagEv).ok,
    ).toBe(false);
  });

  it('passesGate resolves target uniqueness via injected counter', async () => {
    const ev = evidence();
    const proposal: GateProposal = { source: 'UI_VALUE', operator: 'CONTAINS', expectedValue: 'admin', origin: 'rule', confidence: 1, targetPayloadIndex: 1 };
    expect((await passesGate(proposal, ev, null, { resolveCount: async () => 1 })).ok).toBe(true);
    const ambiguous = await passesGate(proposal, ev, null, { resolveCount: async () => 2 });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toContain('not uniquely resolvable');
    const noSel = await passesGate(proposal, evidence({ actedElements: [{ payloadIndex: 1, action: 'fill', tag: 'input' }] }), null, {});
    expect(noSel.ok).toBe(false);
  });

  it('page-level sources skip target resolution', async () => {
    const res = await passesGate({ source: 'UI_PAGE_URL', operator: 'CONTAINS', expectedValue: '/dashboard', origin: 'rule', confidence: 1 }, evidence(), null, {});
    expect(res.ok).toBe(true);
  });
});

describe('compile · proposer', () => {
  it('schema accepts a valid propose verdict with element ref', () => {
    const parsed = AdjudicationSchema.safeParse({
      verdict: 'propose',
      proposal: { source: 'UI_TEXT', operator: 'CONTAINS', expectedValue: 'Welcome back', elementRefId: '2' },
      confidence: 0.8,
      rationale: 'banner text visible',
    });
    expect(parsed.success).toBe(true);
  });

  it('schema rejects unknown verdicts/sources', () => {
    expect(AdjudicationSchema.safeParse({ verdict: 'maybe' }).success).toBe(false);
    expect(AdjudicationSchema.safeParse({
      verdict: 'propose',
      proposal: { source: 'API_STATUS', operator: 'EQUALS' },
    }).success).toBe(false);
  });

  it('prompt carries expected原文, element menu ids, and unverifiable escape hatch', () => {
    const input = {
      expected: 'A welcome banner is displayed',
      actionText: 'Click the Login button',
      evidence: evidence(),
      ruleCandidates: deriveRuleProposals([]),
    };
    const prompt = buildAdjudicationPrompt(input);
    expect(prompt).toContain('A welcome banner is displayed');
    expect(prompt).toContain('[2] action=click');
    expect(prompt.toLowerCase()).toContain('unverifiable');
    expect(prompt).toContain('Never invent selectors');
  });

  it('adapter returns null on extract throw or schema mismatch', async () => {
    const throwing = createStagehandProposer({ extract: vi.fn().mockRejectedValue(new Error('boom')) }, async (_o, p) => p);
    expect(await throwing.adjudicate({ expected: 'x', actionText: 'y', evidence: evidence(), ruleCandidates: [] })).toBeNull();

    const mismatched = createStagehandProposer(
      { extract: vi.fn().mockResolvedValue({ verdict: 'nonsense' }) },
      async (_o, p) => p,
    );
    expect(await mismatched.adjudicate({ expected: 'x', actionText: 'y', evidence: evidence(), ruleCandidates: [] })).toBeNull();
  });

  it('adapter returns parsed adjudication on success', async () => {
    const adapter = createStagehandProposer(
      { extract: vi.fn().mockResolvedValue({ verdict: 'covered', bindsRuleCandidate: 0, rationale: 'value matches' }) },
      async (_o, p) => p,
    );
    const result = await adapter.adjudicate({ expected: 'x', actionText: 'y', evidence: evidence(), ruleCandidates: [] });
    expect(result).toMatchObject({ verdict: 'covered', bindsRuleCandidate: 0 });
  });
});
