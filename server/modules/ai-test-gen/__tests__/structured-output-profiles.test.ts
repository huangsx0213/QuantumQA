import { describe, expect, it } from 'vitest';
import {
  arrayFromRecordValues,
  coerceNumber,
  nullToEmptyArray,
  nullToUndefined,
  wrapSingleObjectInArray,
} from '../graph/structured-output/helpers.ts';
import { createAnalystOutputProfile } from '../graph/structured-output/analyst.ts';
import { createDesignerOutputProfile, designerOutputProfile } from '../graph/structured-output/designer.ts';
import { createQualityOutputProfile, qualityOutputProfile } from '../graph/structured-output/quality.ts';

describe('structured-output helpers', () => {
  it('converts null to undefined', () => {
    expect(nullToUndefined(null)).toBeUndefined();
  });

  it('converts null to empty array', () => {
    expect(nullToEmptyArray(null)).toEqual([]);
  });

  it('converts record values to an array', () => {
    expect(arrayFromRecordValues({ a: { id: '1' }, b: { id: '2' } })).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
  });

  it('wraps a single object into an array', () => {
    expect(wrapSingleObjectInArray({ id: 'tc-1' })).toEqual([{ id: 'tc-1' }]);
  });

  it('coerces numeric text to a number', () => {
    expect(coerceNumber('2')).toBe(2);
    expect(coerceNumber(2)).toBe(2);
  });

  it.each([null, '', ' ', true, false, Number.NaN, Number.POSITIVE_INFINITY])(
    'leaves invalid numeric input %s unchanged for schema validation',
    (value) => {
      expect(coerceNumber(value)).toBe(value);
    },
  );
});

function makeQualityCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TC-1',
    title: 'Verify login',
    conditionId: 'C-1',
    requirementId: 'REQ-1',
    priority: 'high',
    category: 'functional',
    testLevel: 'component',
    techniqueApplied: 'Equivalence Partitioning',
    preconditions: [],
    testData: [],
    steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
    tags: [],
    status: 'approved',
    reviewSummary: 'ok',
    changeLog: [],
    ...overrides,
  };
}

function makeDesignerCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TC-1',
    title: 'Verify login',
    conditionId: 'C-1',
    requirementId: 'REQ-1',
    priority: 'critical',
    category: 'functional',
    testLevel: 'component',
    techniqueApplied: 'Equivalence Partitioning',
    preconditions: [],
    testData: [],
    steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
    postconditions: [],
    tags: [],
    selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
    ...overrides,
  };
}

function makeCoverageMatrix(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      conditionId: 'C-1',
      conditionSummary: 'Verify login',
      requirementId: 'REQ-1',
      testLevel: 'component',
      primaryTechnique: 'Equivalence Partitioning',
      category: 'functional',
      coveredByCaseIds: ['TC-1'],
      coverageStatus: 'covered',
    }],
    summary: {
      totalConditions: 1,
      coveredConditions: 1,
      missingConditions: 0,
      byTestLevel: { component: 1 },
      byTechnique: { 'Equivalence Partitioning': 1 },
      byCategory: { functional: 1 },
    },
    ...overrides,
  };
}

function withoutField<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

describe('qualityOutputProfile validation', () => {
  it.each(['action', 'expected'] as const)('rejects a step missing %s', (field) => {
    const step = withoutField(
      { stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click' } },
      field,
    );

    expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({ steps: [step] })],
    }))).toThrow(new RegExp(field));
  });

  it('rejects null step numbers instead of defaulting them', () => {
    expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{ stepNumber: null, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click' } }],
      })],
    }))).toThrow(/stepNumber/);
  });

  it.each(['preconditions', 'testData', 'steps'] as const)(
    'rejects an omitted required %s collection',
    (field) => {
      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [withoutField(makeQualityCase(), field)],
      }))).toThrow(new RegExp(field));
    },
  );

  it.each(['preconditions', 'testData', 'steps'] as const)(
    'rejects null for required %s',
    (field) => {
      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase({ [field]: null })],
      }))).toThrow(new RegExp(field));
    },
  );

  it.each(['rows', 'summary'] as const)(
    'rejects an omitted coverageMatrix.%s field',
    (field) => {
      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: withoutField(makeCoverageMatrix(), field),
      }))).toThrow(new RegExp(field));
    },
  );

  it('rejects omitted coverageMatrix.rows[].coveredByCaseIds', () => {
    const matrix = makeCoverageMatrix();
    const row = withoutField(matrix.rows[0], 'coveredByCaseIds');

    expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: { ...matrix, rows: [row] },
    }))).toThrow(/coveredByCaseIds/);
  });

  it.each(['byTestLevel', 'byTechnique', 'byCategory'] as const)(
    'rejects an omitted coverageMatrix.summary.%s collection',
    (field) => {
      const matrix = makeCoverageMatrix();
      const summary = withoutField(matrix.summary, field);

      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: { ...matrix, summary },
      }))).toThrow(new RegExp(field));
    },
  );

  it.each([
    'conditionId',
    'conditionSummary',
    'requirementId',
    'primaryTechnique',
    'category',
    'coverageStatus',
  ] as const)('rejects an omitted coverageMatrix row %s', (field) => {
    const matrix = makeCoverageMatrix();
    const row = withoutField(matrix.rows[0], field);
    const normalized = qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: { ...matrix, rows: [row] },
    }) as any;

    expect(normalized.coverageMatrix.rows[0]).not.toHaveProperty(field);
    expect(() => qualityOutputProfile.parse(normalized)).toThrow(new RegExp(field));
  });

  it.each([
    'conditionId',
    'conditionSummary',
    'requirementId',
    'primaryTechnique',
    'category',
    'coverageStatus',
  ] as const)('rejects null for required coverageMatrix row %s', (field) => {
    const matrix = makeCoverageMatrix();

    expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: {
        ...matrix,
        rows: [{ ...matrix.rows[0], [field]: null }],
      },
    }))).toThrow(new RegExp(field));
  });

  it('accepts a coverageMatrix row with omitted testLevel (reconciled deterministically — D1, real-world Quality retry cause)', () => {
    const matrix = makeCoverageMatrix();
    const row = withoutField(matrix.rows[0], 'testLevel');
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: { ...matrix, rows: [row] },
    }));
    // testLevel now optional at schema; reconcileCoverageMatrix fills it downstream.
    expect(parsed.coverageMatrix?.rows[0]).not.toHaveProperty('testLevel');
  });

  it.each(['totalConditions', 'coveredConditions', 'missingConditions'] as const)(
    'rejects an omitted coverageMatrix.summary.%s count',
    (field) => {
      const matrix = makeCoverageMatrix();
      const summary = withoutField(matrix.summary, field);
      const normalized = qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: { ...matrix, summary },
      }) as any;

      expect(normalized.coverageMatrix.summary).not.toHaveProperty(field);
      expect(() => qualityOutputProfile.parse(normalized)).toThrow(new RegExp(field));
    },
  );

  it.each(['totalConditions', 'coveredConditions', 'missingConditions'] as const)(
    'rejects null for required coverageMatrix.summary.%s count',
    (field) => {
      const matrix = makeCoverageMatrix();

      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: {
          ...matrix,
          summary: { ...matrix.summary, [field]: null },
        },
      }))).toThrow(new RegExp(field));
    },
  );

  it.each(['flowId', 'sequence'] as const)(
    'rejects an omitted coverageMatrix row flowStepRef.%s',
    (field) => {
      const matrix = makeCoverageMatrix();
      const flowStepRef = withoutField({ flowId: 'FLOW-1', sequence: 1 }, field);
      const normalized = qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: {
          ...matrix,
          rows: [{ ...matrix.rows[0], conditionType: 'flow', flowStepRef }],
        },
      }) as any;

      expect(normalized.coverageMatrix.rows[0].flowStepRef).not.toHaveProperty(field);
      expect(() => qualityOutputProfile.parse(normalized)).toThrow(new RegExp(field));
    },
  );

  it.each(['flowId', 'sequence'] as const)(
    'rejects null for required coverageMatrix row flowStepRef.%s',
    (field) => {
      const matrix = makeCoverageMatrix();

      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: {
          ...matrix,
          rows: [{
            ...matrix.rows[0],
            conditionType: 'flow',
            flowStepRef: { flowId: 'FLOW-1', sequence: 1, [field]: null },
          }],
        },
      }))).toThrow(new RegExp(field));
    },
  );

  it('normalizes null for optional coverageMatrix fields', () => {
    const matrix = makeCoverageMatrix();
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: {
        ...matrix,
        rows: [{
          ...matrix.rows[0],
          conditionType: null,
          flowStepRef: { flowId: 'FLOW-1', sequence: 1, actionSummary: null },
          notes: null,
        }],
        summary: { ...matrix.summary, byConditionType: null },
      },
    }));

    expect(parsed.coverageMatrix?.rows[0].conditionType).toBeUndefined();
    expect(parsed.coverageMatrix?.rows[0].flowStepRef?.actionSummary).toBeUndefined();
    expect(parsed.coverageMatrix?.rows[0].notes).toBeUndefined();
    expect(parsed.coverageMatrix?.summary.byConditionType).toBeUndefined();
  });

  it.each(['totalConditions', 'coveredConditions', 'missingConditions'] as const)(
    'does not coerce coverageMatrix.summary.%s numeric text',
    (field) => {
      const matrix = makeCoverageMatrix();

      expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase()],
        coverageMatrix: {
          ...matrix,
          summary: { ...matrix.summary, [field]: '1' },
        },
      }))).toThrow(new RegExp(field));
    },
  );

  it('does not coerce coverageMatrix row flowStepRef.sequence numeric text', () => {
    const matrix = makeCoverageMatrix();

    expect(() => qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase()],
      coverageMatrix: {
        ...matrix,
        rows: [{
          ...matrix.rows[0],
          conditionType: 'flow',
          flowStepRef: { flowId: 'FLOW-1', sequence: '1' },
        }],
      },
    }))).toThrow(/sequence/);
  });
});

describe('qualityOutputProfile', () => {
  it('normalizes final test cases before parsing', () => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: {
        a: {
          id: 'TC-1',
          title: 'Verify login',
          conditionId: 'C-1',
          requirementId: 'REQ-1',
          priority: 'high',
          category: 'functional',
          testLevel: 'component',
          techniqueApplied: 'Equivalence Partitioning',
          preconditions: [],
          testData: [],
          steps: [{ stepNumber: '1', action: 'Click login', expected: 'Login starts', intent: { actionType: 'click' } }],
          tags: null,
          reviewSummary: 'Looks good',
          changeLog: [{ field: 'title', from: null, to: null, reason: 'Retained original title' }],
        },
      },
    }));

    expect(parsed.finalTestCases).toHaveLength(1);
    expect(parsed.finalTestCases[0].steps[0].stepNumber).toBe(1);
    expect(parsed.finalTestCases[0].tags).toEqual([]);
    expect(parsed.finalTestCases[0].changeLog[0].from).toBeUndefined();
    expect(parsed.finalTestCases[0].changeLog[0].to).toBeUndefined();
  });

  it.each(['Component', 'Integration', 'COMPONENT', 'INTEGRATION'] as const)(
    'normalizes uppercase testLevel %s to lowercase (real-world Quality Phase 2 retry cause)',
    (testLevel) => {
      const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
        finalTestCases: [makeQualityCase({ testLevel })],
      }));
      expect(parsed.finalTestCases[0].testLevel).toBe(testLevel.toLowerCase());
    },
  );

  it.each([
    ['elementVisible', 'element-visible'],
    ['Text', 'text-visible'],
    ['not-visible', 'element-hidden'],
    ['URL', 'url'],
    ['apiBody', 'api-body'],
    ['httpStatus', 'network'],
  ] as const)('normalizes expectation kind variant "%s" → "%s"', (rawKind, expected) => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{
          stepNumber: 1,
          action: 'verify the element',
          expected: 'The element is visible.',
          intent: { targetHint: 'element', expectation: { kind: rawKind } },
        }],
      })],
    }));
    const exp = (parsed.finalTestCases[0].steps[0].intent as any)?.expectation;
    expect(exp?.kind).toBe(expected);
  });

  it('drops an unrecognizable expectation kind instead of failing the whole batch', () => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{
          stepNumber: 1,
          action: 'verify the element',
          expected: 'The element is visible.',
          intent: { targetHint: 'element', expectation: { kind: 'completelyMadeUp' } },
        }],
      })],
    }));
    const intent = (parsed.finalTestCases[0].steps[0].intent as any);
    expect(intent?.targetHint).toBe('element');
    expect(intent?.expectation).toBeUndefined();
  });

  it('drops a transient expectation (docs/08: not assertable, rewrite as observable end state)', () => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{
          stepNumber: 1,
          action: 'click the button',
          expected: 'The button is not in loading state anymore.',
          intent: { targetHint: 'button', expectation: { kind: 'transient', value: 'loading' } },
        }],
      })],
    }));
    const intent = (parsed.finalTestCases[0].steps[0].intent as any);
    expect(intent?.targetHint).toBe('button');
    expect(intent?.expectation).toBeUndefined();
  });

  it('defaults changeLog[].reason to "" when missing (real-world Quality Phase 2 retry cause)', () => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        changeLog: [
          { field: 'testData', from: 'x', to: 'y' }, // reason omitted
          { field: 'testLevel', from: null, to: null, reason: null }, // reason null
        ],
      })],
    }));
    const clog = parsed.finalTestCases[0].changeLog;
    expect(clog[0].reason).toBe('');
    expect(clog[1].reason).toBe('');
  });

  it('strips a semicolon-joined expected to the first assertion (real-world Quality Phase 2 retry cause)', () => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{
          stepNumber: 1,
          action: 'click the submit button',
          expected: "The form submission is blocked; no navigation occurs.",
        }],
      })],
    }));
    expect(parsed.finalTestCases[0].steps[0].expected).toBe('The form submission is blocked');
  });

  it.each(['；', ';'])('strips a %s-joined expected keeping the primary assertion', (sep) => {
    const parsed = qualityOutputProfile.parse(qualityOutputProfile.normalize({
      finalTestCases: [makeQualityCase({
        steps: [{
          stepNumber: 1,
          action: 'click the submit button',
          expected: `first assertion${sep} second assertion ${sep} third`,
        }],
      })],
    }));
    expect(parsed.finalTestCases[0].steps[0].expected).toBe('first assertion');
  });

  it('falls back to the draft testLevel when the LLM writes an unrecognizable value', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'integration', referencedComponentConditions: ['C-1'] },
    ]);
    const parsed = profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase({
        testLevel: 'System Level',
        referencedComponentConditions: ['C-1'],
      })],
    }));
    expect(parsed.finalTestCases[0].testLevel).toBe('integration');
  });

  it('keeps an unrecognizable testLevel when no draft fallback exists (schema still rejects)', () => {
    const profile = createQualityOutputProfile([]);
    const normalized = profile.normalize({
      finalTestCases: [makeQualityCase({ testLevel: 'System Level', coveredConditions: ['C-1'] })],
    }) as any;
    expect(normalized.finalTestCases[0].testLevel).toBe('System Level');
    expect(() => profile.parse(normalized)).toThrow(/testLevel/);
  });

  it('rejects outputs that do not preserve every draft case id', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1' },
      { id: 'TC-2', conditionId: 'C-2', requirementId: 'REQ-2' },
    ]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        priority: 'high',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
        tags: [],
        status: 'approved',
        reviewSummary: 'ok',
        changeLog: [],
      }],
    }))).toThrow(/Missing final reviewed cases for draft case ids: TC-2/);
  });

  it('rejects an INJECTED final case outside the draft case IDs', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1' },
    ]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [
        makeQualityCase(),
        makeQualityCase({ id: 'INJECTED' }),
      ],
    }))).toThrow(/INJECTED/);
  });

  it('rejects duplicate final case IDs', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1' },
    ]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase(), makeQualityCase({ title: 'Duplicate' })],
    }))).toThrow(/duplicate.*TC-1/i);
  });

  it('rejects outputs that drift conditionId or requirementId for an existing draft case id', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1' },
    ]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-999',
        requirementId: 'REQ-999',
        priority: 'high',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
        tags: [],
        status: 'approved',
        reviewSummary: 'ok',
        changeLog: [],
      }],
    }))).toThrow(/Final reviewed case TC-1 changed conditionId or requirementId/);
  });

  it('rejects a component case that drops an expected covered condition', () => {
    const profile = createQualityOutputProfile([{
      id: 'TC-1',
      conditionId: 'C-1',
      requirementId: 'REQ-1',
      expectedTestLevel: 'component',
      coveredConditions: ['C-1', 'C-2'],
      referencedComponentConditions: [],
    }]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase({ coveredConditions: ['C-1'] })],
    }))).toThrow(/coveredConditions.*C-2/);
  });

  it('allows a component case to add a covered condition from the draft union', () => {
    const profile = createQualityOutputProfile([
      {
        id: 'TC-1',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        expectedTestLevel: 'component',
        coveredConditions: ['C-1'],
        referencedComponentConditions: [],
      },
      {
        id: 'TC-2',
        conditionId: 'C-2',
        requirementId: 'REQ-1',
        expectedTestLevel: 'component',
        coveredConditions: ['C-2'],
        referencedComponentConditions: [],
      },
    ]);

    const parsed = profile.parse(profile.normalize({
      finalTestCases: [
        makeQualityCase({ coveredConditions: ['C-1', 'C-2'] }),
        makeQualityCase({ id: 'TC-2', conditionId: 'C-2', coveredConditions: ['C-2'] }),
      ],
    }));

    expect(parsed.finalTestCases[0].coveredConditions).toEqual(['C-1', 'C-2']);
  });

  it('rejects an integration case that drops an expected covered condition', () => {
    const profile = createQualityOutputProfile([{
      id: 'TC-1',
      conditionId: 'FLOW-1',
      requirementId: 'REQ-1',
      expectedTestLevel: 'integration',
      coveredConditions: ['FLOW-1', 'FLOW-2'],
      referencedComponentConditions: ['C-1'],
    }]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase({
        conditionId: 'FLOW-1',
        testLevel: 'integration',
        coveredConditions: ['FLOW-1'],
        referencedComponentConditions: ['C-1'],
      })],
    }))).toThrow(/coveredConditions.*FLOW-2/);
  });

  it('rejects an integration case that replaces an expected component reference', () => {
    const profile = createQualityOutputProfile([{
      id: 'TC-1',
      conditionId: 'FLOW-1',
      requirementId: 'REQ-1',
      expectedTestLevel: 'integration',
      coveredConditions: ['FLOW-1'],
      referencedComponentConditions: ['C-1', 'C-2'],
    }]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase({
        conditionId: 'FLOW-1',
        testLevel: 'integration',
        coveredConditions: ['FLOW-1'],
        referencedComponentConditions: ['C-2', 'C-3'],
      })],
    }))).toThrow(/referencedComponentConditions.*C-1/);
  });

  it.each([
    ['coveredConditions', ['C-1', 'FOREIGN-CONDITION']],
    ['referencedComponentConditions', ['C-REF', 'FOREIGN-REFERENCE']],
  ] as const)('rejects FOREIGN IDs added to final %s', (field, values) => {
    const profile = createQualityOutputProfile([{
      id: 'TC-1',
      conditionId: 'C-1',
      requirementId: 'REQ-1',
      expectedTestLevel: 'integration',
      coveredConditions: ['C-1'],
      referencedComponentConditions: ['C-REF'],
    }]);

    expect(() => profile.parse(profile.normalize({
      finalTestCases: [makeQualityCase({
        testLevel: 'integration',
        coveredConditions: ['C-1'],
        referencedComponentConditions: ['C-REF'],
        [field]: values,
      })],
    }))).toThrow(/FOREIGN/);
  });

  it('allows an integration case to add coverage and component references from the draft unions', () => {
    const profile = createQualityOutputProfile([
      {
        id: 'TC-1',
        conditionId: 'FLOW-1',
        requirementId: 'REQ-1',
        expectedTestLevel: 'integration',
        coveredConditions: ['FLOW-1'],
        referencedComponentConditions: ['C-1'],
      },
      {
        id: 'TC-2',
        conditionId: 'FLOW-2',
        requirementId: 'REQ-1',
        expectedTestLevel: 'integration',
        coveredConditions: ['FLOW-2'],
        referencedComponentConditions: ['C-2'],
      },
    ]);

    const parsed = profile.parse(profile.normalize({
      finalTestCases: [
        makeQualityCase({
          conditionId: 'FLOW-1',
          testLevel: 'integration',
          coveredConditions: ['FLOW-1', 'FLOW-2'],
          referencedComponentConditions: ['C-1', 'C-2'],
        }),
        makeQualityCase({
          id: 'TC-2',
          conditionId: 'FLOW-2',
          testLevel: 'integration',
          coveredConditions: ['FLOW-2'],
          referencedComponentConditions: ['C-2'],
        }),
      ],
    }));

    expect(parsed.finalTestCases[0].coveredConditions).toEqual(['FLOW-1', 'FLOW-2']);
    expect(parsed.finalTestCases[0].referencedComponentConditions).toEqual(['C-1', 'C-2']);
  });

  it('rejects final cases whose testLevel contradicts the draft case', () => {
    const profile = createQualityOutputProfile([
      { id: 'TC-1', conditionId: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'component' },
    ]);

    let threw = false;
    try {
      profile.parse(profile.normalize({
        finalTestCases: [{
          id: 'TC-1',
          title: 'Verify login',
          conditionId: 'C-1',
          requirementId: 'REQ-1',
          priority: 'high',
          category: 'functional',
          testLevel: 'integration',
          techniqueApplied: 'Equivalence Partitioning',
          preconditions: [],
          testData: [],
          steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
          tags: [],
          status: 'approved',
          reviewSummary: 'ok',
          changeLog: [],
        }],
      }));
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('testLevel');
      expect(err.message).toContain('integration');
      expect(err.message).toContain('component');
      expect(err.message).toContain('TC-1');
    }
    expect(threw).toBe(true);
  });
});

describe('designerOutputProfile', () => {
  it('rejects a step whose action does not start with intent.actionType verb', () => {
    const bad = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'Enter the username',
        expected: 'Username shown',
        intent: { actionType: 'fill', data: 'admin' },
      }],
    });
    expect(() => designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [bad] })))
      .toThrow(/must start with/);
  });

  it('accepts a step whose action starts with intent.actionType verb', () => {
    const good = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'fill the username field with admin',
        expected: 'Username shown',
        intent: { data: 'admin' },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [good] }));
    expect(parsed.draftTestCases[0].steps[0].intent.data).toBe('admin');
  });

  it('accepts camelCase actionType verbs written space-separated (waitFor → "wait for")', () => {
    const ok = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'wait for the network response',
        expected: 'API returns 200',
        intent: { expectation: { kind: 'network', method: 'POST', urlPattern: '/api/x' } },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [ok] }));
    expect(parsed.draftTestCases[0].steps[0].action).toBe('wait for the network response');
  });

  it('rewrites "leave X empty" steps into a valid verify assertion (avoids Phase 2 retries)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'leave the username field empty',
        expected: 'The username field is empty',
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('verify the username field is empty');
    expect(step.intent?.expectation).toEqual({ kind: 'value', value: '' });
  });

  it('rewrites "ensure X is empty" into a valid verify assertion (the #1 real-world Phase 2 retry cause)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'ensure the username field is empty',
        expected: 'The username field is empty',
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('verify the username field is empty');
    expect(step.intent?.expectation).toEqual({ kind: 'value', value: '' });
  });

  it.each([
    ['visible', { kind: 'element-visible' }],
    ['hidden', { kind: 'element-hidden' }],
    ['not visible', { kind: 'element-hidden' }],
    ['not present', { kind: 'element-hidden' }],
    ['absent', { kind: 'element-hidden' }],
    ['checked', { kind: 'element-state', value: 'checked' }],
    ['unchecked', { kind: 'element-state', value: 'unchecked' }],
    ['enabled', { kind: 'element-state', value: 'enabled' }],
    ['disabled', { kind: 'element-state', value: 'disabled' }],
  ] as const)('rewrites "ensure the checkbox is %s" → verify + %j', (state, expected) => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: `ensure the checkbox is ${state}`,
        expected: `The checkbox is ${state}`,
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe(`verify the checkbox is ${state}`);
    expect(step.intent?.expectation).toEqual(expected);
  });

  it('rewrites "make sure X is empty" into a valid verify assertion', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'make sure the password field is empty',
        expected: 'The password field is empty',
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('verify the password field is empty');
    expect(step.intent?.expectation).toEqual({ kind: 'value', value: '' });
  });

  it('preserves an LLM-provided expectation when rewriting a non-verb action', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'ensure the username field is empty',
        expected: 'The username field is empty',
        intent: { targetHint: 'username input', expectation: { kind: 'value', value: '' } },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('verify the username field is empty');
    expect(step.intent?.targetHint).toBe('username input');
    expect(step.intent?.expectation).toEqual({ kind: 'value', value: '' });
  });

  it('does not rewrite an action that already starts with a vocabulary verb', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'verify the page URL contains /dashboard',
        expected: 'The URL contains /dashboard',
        intent: { expectation: { kind: 'url', value: '/dashboard' } },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    expect(parsed.draftTestCases[0].steps[0].action).toBe('verify the page URL contains /dashboard');
  });

  // === intent.expectation null/非法类型容错（real-world Designer Phase 1.5 retry cause） ===
  it('drops a null intent.expectation instead of failing the whole batch (real-world Phase 1.5 retry cause)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'click the button',
        expected: 'The button is clicked.',
        intent: { targetHint: 'button', expectation: null },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.intent?.targetHint).toBe('button');
    expect(step.intent?.expectation).toBeUndefined();
  });

  it('drops a non-object intent.expectation (array/string) instead of failing the whole batch', () => {
    for (const badExp of [['url'], 'url-value', 42, true]) {
      const draft = makeDesignerCase({
        steps: [{
          stepNumber: 1,
          action: 'click the button',
          expected: 'The button is clicked.',
          intent: { targetHint: 'button', expectation: badExp },
        }],
      });
      expect(() => designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] })))
        .not.toThrow(/expected object/);
    }
  });

  it('drops a null expectation on a verify step, keeping a valid synthesized expectation when rewrite applies', () => {
    // verify 步骤若 expectation 为 null 会被丢弃——rewriteNonVerbAction 若命中会补回。
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'ensure the username field is empty',
        expected: 'The username field is empty',
        intent: { expectation: null },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('verify the username field is empty');
    expect(step.intent?.expectation).toEqual({ kind: 'value', value: '' });
  });

  // === intent.data 确定性提取（处理 "fill X with 'Y'" 值在文本但未结构化的情况） ===
  // 这些是实测导致整批失败 + Phase 2 重试 + 触发 429 限流的确切模式。

  it('extracts intent.data from "fill X with <value>" when the LLM omits it (real-world Phase 2 retry cause)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: "fill the username field with 'admin'",
        expected: "The username field displays 'admin'.",
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe("fill the username field with 'admin'");
    expect(step.intent?.data).toBe('admin');
  });

  it('extracts intent.data from "fill \'value\' into X" variant', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: "fill 'admin123' into the password field",
        expected: 'The password field accepts the value.',
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    expect(parsed.draftTestCases[0].steps[0].intent?.data).toBe('admin123');
  });

  it('extracts intent.data from "navigate to <url>" when the LLM omits it', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'navigate to /login',
        expected: 'The login page is loaded.',
        intent: { expectation: { kind: 'url', value: '/login' } },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    expect(parsed.draftTestCases[0].steps[0].intent?.data).toBe('/login');
  });

  it('preserves an LLM-provided intent.data (does not overwrite)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: "fill the username field with 'admin'",
        expected: "The username field displays 'admin'.",
        intent: { data: 'superuser' },
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    expect(parsed.draftTestCases[0].steps[0].intent?.data).toBe('superuser');
  });

  it('rewrites "fill X with \'\'" to "clear X" (empty value → clear verb, no data needed)', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: "fill the username field with ''",
        expected: 'The username field is empty.',
      }],
    });
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] }));
    const step = parsed.draftTestCases[0].steps[0];
    expect(step.action).toBe('clear the username field');
    expect(step.intent?.data).toBeUndefined();
  });

  it('still rejects a fill step with no value at all (no quoted token, no "with")', () => {
    const draft = makeDesignerCase({
      steps: [{
        stepNumber: 1,
        action: 'fill the username field',
        expected: 'The field is filled.',
      }],
    });
    expect(() => designerOutputProfile.parse(designerOutputProfile.normalize({ draftTestCases: [draft] })))
      .toThrow(/requires intent\.data/);
  });

  it('wraps a top-level test case object and normalizes nullable fields', () => {
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize({
      id: 'TC-1',
      title: 'Verify login',
      conditionId: 'C-1',
      requirementId: 'REQ-1',
      priority: 'critical',
      category: 'functional',
      testLevel: 'component',
      techniqueApplied: 'Equivalence Partitioning',
      preconditions: [],
      testData: [],
      steps: [{ stepNumber: '1', action: 'fill username', expected: 'Username is shown', intent: { actionType: 'fill', data: 'admin' } }],
      postconditions: null,
      tags: null,
      selfReview: {
        score: '8',
        strengths: [],
        weaknesses: [],
        suggestions: [],
      },
    }));

    expect(parsed.draftTestCases).toHaveLength(1);
    expect(parsed.draftTestCases[0].steps[0].stepNumber).toBe(1);
    expect(parsed.draftTestCases[0].postconditions).toEqual([]);
    expect(parsed.draftTestCases[0].tags).toEqual([]);
    expect(parsed.draftTestCases[0].selfReview.score).toBe(8);
  });

  it.each(['action', 'expected'] as const)('rejects a step missing %s', (field) => {
    const step = withoutField(
      { stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click' } },
      field,
    );

    expect(() => designerOutputProfile.parse(designerOutputProfile.normalize(
      makeDesignerCase({ steps: [step] }),
    ))).toThrow(new RegExp(field));
  });

it('defaults a missing selfReview (truncation tolerance — case must not fail the whole batch)', () => {
    const parsed = designerOutputProfile.parse(designerOutputProfile.normalize(
      withoutField(makeDesignerCase(), 'selfReview'),
    ));
    expect(parsed.draftTestCases[0].selfReview).toEqual({ score: 7, strengths: [], weaknesses: [], suggestions: [] });
  });

it.each(['strengths', 'weaknesses', 'suggestions'] as const)(
    'defaults selfReview.%s when omitted (truncation tolerance)',
    (field) => {
      const selfReview = withoutField(
        { score: 8, strengths: [], weaknesses: [], suggestions: [] },
        field,
      );
      const parsed = designerOutputProfile.parse(designerOutputProfile.normalize(
        makeDesignerCase({ selfReview }),
      ));
      expect(parsed.draftTestCases[0].selfReview[field]).toEqual([]);
    },
  );

  it.each(['strengths', 'weaknesses', 'suggestions'] as const)(
    'defaults selfReview.%s when null (truncation tolerance)',
    (field) => {
      const parsed = designerOutputProfile.parse(designerOutputProfile.normalize(
        makeDesignerCase({
          selfReview: {
            score: 8,
            strengths: [],
            weaknesses: [],
            suggestions: [],
            [field]: null,
          },
        }),
      ));
expect(parsed.draftTestCases[0].selfReview[field]).toEqual([]);
    },
  );

  it.each(['preconditions', 'testData', 'steps'] as const)(
    'rejects an omitted required %s collection',
    (field) => {
      expect(() => designerOutputProfile.parse(designerOutputProfile.normalize(
        withoutField(makeDesignerCase(), field),
      ))).toThrow(new RegExp(field));
    },
  );

  it.each(['preconditions', 'testData', 'steps'] as const)(
    'rejects null for required %s',
    (field) => {
      expect(() => designerOutputProfile.parse(designerOutputProfile.normalize(
        makeDesignerCase({ [field]: null }),
      ))).toThrow(new RegExp(field));
    },
  );

  it.each([null, '', ' ', true, false])(
    'rejects invalid stepNumber input %s instead of defaulting it',
    (stepNumber) => {
      expect(() => designerOutputProfile.parse(designerOutputProfile.normalize(
        makeDesignerCase({
          steps: [{ stepNumber, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click' } }],
        }),
      ))).toThrow(/stepNumber/);
    },
  );

  it('rejects outputs that do not cover every expected condition at least once', () => {
    const profile = createDesignerOutputProfile([{ id: 'C-1', requirementId: 'REQ-1' }, { id: 'C-2', requirementId: 'REQ-2' }]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        priority: 'critical',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
        postconditions: [],
        tags: [],
        selfReview: {
          score: 8,
          strengths: [],
          weaknesses: [],
          suggestions: [],
        },
      }],
    }))).toThrow(/Missing draft test cases for conditionIds: C-2/);
  });

  it('rejects an INJECTED primary condition outside the Analyst conditions', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', conditionType: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [makeDesignerCase({
        conditionId: 'INJECTED',
        coveredConditions: ['C-1'],
      })],
    }))).toThrow(/INJECTED/);
  });

  it('rejects FOREIGN covered conditions outside the current Analyst conditions', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', conditionType: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [makeDesignerCase({
        coveredConditions: ['C-1', 'FOREIGN-CONDITION'],
      })],
    }))).toThrow(/FOREIGN-CONDITION/);
  });

  it('rejects FOREIGN component references outside the approved IDs', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', conditionType: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [makeDesignerCase({
        coveredConditions: ['C-1'],
        referencedComponentConditions: ['FOREIGN-REFERENCE'],
      })],
    }))).toThrow(/FOREIGN-REFERENCE/);
  });

  it('rejects duplicate draft case IDs', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', conditionType: 'component' },
      { id: 'C-2', requirementId: 'REQ-2', conditionType: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [
        makeDesignerCase({ coveredConditions: ['C-1'] }),
        makeDesignerCase({ conditionId: 'C-2', requirementId: 'REQ-2', coveredConditions: ['C-2'] }),
      ],
    }))).toThrow(/duplicate.*TC-1/i);
  });

  it('rejects draft cases whose testLevel contradicts the Analyst tag', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'component' },
    ]);

    let threw = false;
    try {
      profile.parse(profile.normalize({
        draftTestCases: [{
          id: 'TC-1',
          title: 'Verify login',
          conditionId: 'C-1',
          requirementId: 'REQ-1',
          priority: 'critical',
          category: 'functional',
          testLevel: 'integration',
          techniqueApplied: 'Equivalence Partitioning',
          preconditions: [],
          testData: [],
          steps: [{ stepNumber: 1, action: 'click credentials', expected: 'Dashboard shown', intent: { actionType: 'click', targetHint: 'Sign in button' } }],
          postconditions: [],
          tags: [],
          selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
        }],
      }));
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('testLevel');
      expect(err.message).toContain('integration');
      expect(err.message).toContain('component');
      expect(err.message).toContain('C-1');
    }
    expect(threw).toBe(true);
  });

  it('F11: rejects integration cases with empty referencedComponentConditions', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'integration', conditionType: 'flow' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [{
        id: 'TC-1',
        title: 'End-to-end login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        coveredConditions: ['C-1'],
        referencedComponentConditions: [], // F11 violation
        priority: 'critical',
        category: 'functional',
        testLevel: 'integration',
        techniqueApplied: 'Use Case Testing',
        preconditions: [],
        testData: [],
        steps: [
          { stepNumber: 1, action: 'click submit', expected: 'Auth API returns 200', intent: { actionType: 'click' } },
          { stepNumber: 2, action: 'waitFor redirect', expected: 'Dashboard renders', intent: { actionType: 'waitFor', expectation: { kind: 'url', value: '/dashboard' } } },
        ],
        postconditions: [],
        tags: [],
        selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
      }],
    }))).toThrow(/referencedComponentConditions is empty/);
  });

  it('F11: integration case must reference a real condition of type=component', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'integration', conditionType: 'flow' },
      { id: 'C-2', requirementId: 'REQ-1', expectedTestLevel: 'component', conditionType: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [
        {
          id: 'TC-1',
          title: 'End-to-end login',
          conditionId: 'C-1',
          requirementId: 'REQ-1',
          coveredConditions: ['C-1'],
          referencedComponentConditions: ['C-1'], // wrong: references a flow condition, not component
          priority: 'critical',
          category: 'functional',
          testLevel: 'integration',
          techniqueApplied: 'Use Case Testing',
          preconditions: [],
          testData: [],
          steps: [
            { stepNumber: 1, action: 'click submit', expected: 'Auth API returns 200', intent: { actionType: 'click' } },
          ],
          postconditions: [],
          tags: [],
          selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
        },
        // Cover C-2 with a sibling component case so validateConditionCoverage
        // doesn't bail before validateFlowCaseReferences gets to run.
        {
          id: 'TC-2',
          title: 'Validate client-side input',
          conditionId: 'C-2',
          requirementId: 'REQ-1',
          coveredConditions: ['C-2'],
          referencedComponentConditions: [],
          priority: 'high',
          category: 'validation',
          testLevel: 'component',
          techniqueApplied: 'Equivalence Partitioning',
          preconditions: [],
          testData: [],
          steps: [{ stepNumber: 1, action: 'fill empty password', expected: 'Validation error shown', intent: { actionType: 'fill', data: 'weakpass' } }],
          postconditions: [],
          tags: [],
          selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
        },
      ],
    }))).toThrow(/only component-typed conditions may be referenced/);
  });

  it('F18: rejects steps with bundled assertions (semicolons in expected)', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'component' },
    ]);

    expect(() => profile.parse(profile.normalize({
      draftTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        coveredConditions: ['C-1'],
        referencedComponentConditions: [],
        priority: 'critical',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [
          { stepNumber: 1, action: 'Click login', expected: 'API returns 200; dashboard renders', intent: { actionType: 'click' } },
        ],
        postconditions: [],
        tags: [],
        selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
      }],
    }))).toThrow(/single assertion/);
  });

  it('F18: rejects steps with over-long expected (>200 chars)', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'component' },
    ]);

    const longExpected = 'A'.repeat(201);
    expect(() => profile.parse(profile.normalize({
      draftTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        coveredConditions: ['C-1'],
        referencedComponentConditions: [],
        priority: 'critical',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [{ stepNumber: 1, action: 'Click login', expected: longExpected, intent: { actionType: 'click' } }],
        postconditions: [],
        tags: [],
        selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
      }],
    }))).toThrow(/<= 200 chars/);
  });

  it('F10: backfills coveredConditions from primary conditionId if missing', () => {
    const profile = createDesignerOutputProfile([
      { id: 'C-1', requirementId: 'REQ-1', expectedTestLevel: 'component' },
    ]);

    const parsed = profile.parse(profile.normalize({
      draftTestCases: [{
        id: 'TC-1',
        title: 'Verify login',
        conditionId: 'C-1',
        requirementId: 'REQ-1',
        // coveredConditions deliberately omitted
        referencedComponentConditions: [],
        priority: 'critical',
        category: 'functional',
        testLevel: 'component',
        techniqueApplied: 'Equivalence Partitioning',
        preconditions: [],
        testData: [],
        steps: [{ stepNumber: 1, action: 'fill credentials', expected: 'Field shows value', intent: { actionType: 'fill', data: 'admin' } }],
        postconditions: [],
        tags: [],
        selfReview: { score: 8, strengths: [], weaknesses: [], suggestions: [] },
      }],
    }));

    expect(parsed.draftTestCases[0].coveredConditions).toEqual(['C-1']);
  });
});

describe('analystOutputProfile', () => {
  const profile = createAnalystOutputProfile();

  it('rejects an omitted testConditions collection', () => {
    expect(() => profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
    }))).toThrow(/testConditions/);
  });

  it('rejects null for required testConditions', () => {
    expect(() => profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: null,
    }))).toThrow(/testConditions/);
  });

  it('normalizes nullable optional fields in test conditions', () => {
    const parsed = profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: [{
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify login with valid credentials',
        conditionType: 'component',
        flowStepRefs: [],
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Equivalence Partitioning',
        secondaryTechniques: [],
        techniqueRationale: 'Valid and invalid partitions',
        coverageDimensions: ['functional'],
        dataRequirements: null,
        dependencies: null,
        requirementLevel: null,
      }],
    }));

    expect(parsed.testConditions).toHaveLength(1);
    expect(parsed.testConditions[0].dataRequirements).toBeUndefined();
    expect(parsed.testConditions[0].dependencies).toEqual([]);
    expect(parsed.testConditions[0].requirementLevel).toBeUndefined();
  });

  it.each(['secondaryTechniques', 'coverageDimensions'] as const)(
    'rejects an omitted required %s collection',
    (field) => {
      const condition = withoutField({
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify login with valid credentials',
        conditionType: 'component',
        flowStepRefs: [],
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Equivalence Partitioning',
        secondaryTechniques: [],
        techniqueRationale: 'Valid and invalid partitions',
        coverageDimensions: ['functional'],
      }, field);

      expect(() => profile.parse(profile.normalize({
        requirementAnalysis: {
          overallApproach: 'Use risk-based analysis',
          riskAssessmentSummary: 'High authentication risk',
        },
        testConditions: [condition],
      }))).toThrow(new RegExp(field));
    },
  );

  it.each(['secondaryTechniques', 'coverageDimensions'] as const)(
    'rejects null for required %s',
    (field) => {
      const condition = {
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify login with valid credentials',
        conditionType: 'component',
        flowStepRefs: [],
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Equivalence Partitioning',
        secondaryTechniques: [],
        techniqueRationale: 'Valid and invalid partitions',
        coverageDimensions: ['functional'],
        [field]: null,
      };

      expect(() => profile.parse(profile.normalize({
        requirementAnalysis: {
          overallApproach: 'Use risk-based analysis',
          riskAssessmentSummary: 'High authentication risk',
        },
        testConditions: [condition],
      }))).toThrow(new RegExp(field));
    },
  );

  it('rejects conditions missing a conditionType', () => {
    expect(() => profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: [{
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify login with valid credentials',
        // conditionType deliberately omitted
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Equivalence Partitioning',
        secondaryTechniques: [],
        techniqueRationale: 'Valid and invalid partitions',
        coverageDimensions: ['functional'],
      }],
    }))).toThrow(/conditionType/);
  });

  it('rejects flow conditions with no flowStepRefs', () => {
    expect(() => profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: [{
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify end-to-end login propagation',
        conditionType: 'flow',
        // flowStepRefs deliberately omitted
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Use Case Testing',
        secondaryTechniques: [],
        techniqueRationale: 'Multi-step cross-component flow',
        coverageDimensions: ['authentication'],
      }],
    }))).toThrow(/flowStepRefs/);
  });

  it('rejects Use Case Testing with conditionType=component', () => {
    expect(() => profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: [{
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify login flow with Use Case technique',
        conditionType: 'component',
        flowStepRefs: [],
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Use Case Testing',
        secondaryTechniques: [],
        techniqueRationale: 'Use Case is multi-step by definition',
        coverageDimensions: ['authentication'],
      }],
    }))).toThrow(/Use Case Testing/);
  });

  it('accepts a flow condition with valid flowStepRefs', () => {
    const parsed = profile.parse(profile.normalize({
      requirementAnalysis: {
        overallApproach: 'Use risk-based analysis',
        riskAssessmentSummary: 'High authentication risk',
      },
      testConditions: [{
        id: 'C-1',
        requirementId: 'REQ-1',
        condition: 'Verify end-to-end login propagation',
        conditionType: 'flow',
        flowStepRefs: [{ flowId: 'F-login', sequence: 2, actionSummary: 'Submit credentials' }],
        category: 'functional',
        priority: 'high',
        riskLevel: 'medium',
        primaryTechnique: 'Use Case Testing',
        secondaryTechniques: [],
        techniqueRationale: 'Multi-step cross-component flow',
        coverageDimensions: ['authentication'],
      }],
    }));

    expect(parsed.testConditions).toHaveLength(1);
    expect(parsed.testConditions[0].conditionType).toBe('flow');
    expect(parsed.testConditions[0].flowStepRefs).toHaveLength(1);
  });

  it('formats field-specific hints for missing required condition fields', () => {
    const message = profile.formatValidationError({
      issues: [{
        path: ['testConditions', 0, 'category'],
        message: 'Invalid input: expected string, received undefined',
      }],
    });

    expect(message).toContain('category');
    expect(message).toContain('Set category explicitly');
  });

  it('rejects fabricated compound IDs in dependencies (mixed mode)', () => {
    // Mixed mode: same-output condition IDs are valid, fabricated ones are not.
    const mixedProfile = createAnalystOutputProfile(
      new Set(['STORY-001', 'FLOW-STORY-001']),
      [],
      new Map(),
      new Set(), // no external conditions
    );
    expect(() => mixedProfile.parse(mixedProfile.normalize({
      requirementAnalysis: {
        overallApproach: 'Mixed mode analysis',
        riskAssessmentSummary: 'Auth risk',
      },
      testConditions: [
        {
          id: 'C-001', requirementId: 'STORY-001',
          condition: 'Verify password is masked',
          conditionType: 'component', flowStepRefs: [],
          category: 'functional', priority: 'high', riskLevel: 'medium',
          primaryTechnique: 'Equivalence Partitioning',
          secondaryTechniques: [], techniqueRationale: 'Input masking',
          coverageDimensions: ['ui'], dependencies: [],
        },
        {
          id: 'C-002', requirementId: 'FLOW-STORY-001',
          condition: 'Verify auth session propagation',
          conditionType: 'flow',
          flowStepRefs: [{ flowId: 'F-login', sequence: 1, actionSummary: 'Submit' }],
          category: 'integration', priority: 'critical', riskLevel: 'high',
          primaryTechnique: 'Use Case Testing',
          secondaryTechniques: [], techniqueRationale: 'Cross-component',
          coverageDimensions: ['flow'],
          // Fabricated compound ID — should be REJECTED
          dependencies: ['component:req-aut-auth-session-happy:F-001'],
        },
      ],
    }))).toThrow(/NOT a real condition ID/);
  });

  it('accepts real same-batch condition IDs in dependencies (mixed mode)', () => {
    const mixedProfile = createAnalystOutputProfile(
      new Set(['STORY-001', 'FLOW-STORY-001']),
      [],
      new Map(),
      new Set(),
    );
    const parsed = mixedProfile.parse(mixedProfile.normalize({
      requirementAnalysis: {
        overallApproach: 'Mixed mode analysis',
        riskAssessmentSummary: 'Auth risk',
      },
      testConditions: [
        {
          id: 'C-001', requirementId: 'STORY-001',
          condition: 'Verify password is masked',
          conditionType: 'component', flowStepRefs: [],
          category: 'functional', priority: 'high', riskLevel: 'medium',
          primaryTechnique: 'Equivalence Partitioning',
          secondaryTechniques: [], techniqueRationale: 'Input masking',
          coverageDimensions: ['ui'], dependencies: [],
        },
        {
          id: 'C-002', requirementId: 'FLOW-STORY-001',
          condition: 'Verify auth session propagation',
          conditionType: 'flow',
          flowStepRefs: [{ flowId: 'F-login', sequence: 1, actionSummary: 'Submit' }],
          category: 'integration', priority: 'critical', riskLevel: 'high',
          primaryTechnique: 'Use Case Testing',
          secondaryTechniques: [], techniqueRationale: 'Cross-component',
          coverageDimensions: ['flow'],
          // Real same-batch condition ID — should be ACCEPTED
          dependencies: ['C-001'],
        },
      ],
    }));

    expect(parsed.testConditions[1].dependencies).toEqual(['C-001']);
  });

  it('rejects fabricated IDs in dependencies when external IDs are provided (flow mode)', () => {
    // Flow mode: external component condition IDs from previous batches.
    const flowProfile = createAnalystOutputProfile(
      new Set(['FLOW-STORY-001']),
      [],
      new Map(),
      new Set(['C-PREV-001', 'C-PREV-002']), // external IDs from previous batch
    );
    expect(() => flowProfile.parse(flowProfile.normalize({
      requirementAnalysis: {
        overallApproach: 'Flow mode analysis',
        riskAssessmentSummary: 'Auth risk',
      },
      testConditions: [
        {
          id: 'C-100', requirementId: 'FLOW-STORY-001',
          condition: 'Verify auth flow propagation',
          conditionType: 'flow',
          flowStepRefs: [{ flowId: 'F-login', sequence: 1, actionSummary: 'Submit' }],
          category: 'integration', priority: 'critical', riskLevel: 'high',
          primaryTechnique: 'Use Case Testing',
          secondaryTechniques: [], techniqueRationale: 'Cross-component',
          coverageDimensions: ['flow'],
          // Fabricated ID not in external set — should be REJECTED
          dependencies: ['C-FAKE-999'],
        },
      ],
    }))).toThrow(/NOT a real condition ID/);
  });

  it('accepts real external condition IDs in dependencies (flow mode)', () => {
    const flowProfile = createAnalystOutputProfile(
      new Set(['FLOW-STORY-001']),
      [],
      new Map(),
      new Set(['C-PREV-001', 'C-PREV-002']),
    );
    const parsed = flowProfile.parse(flowProfile.normalize({
      requirementAnalysis: {
        overallApproach: 'Flow mode analysis',
        riskAssessmentSummary: 'Auth risk',
      },
      testConditions: [
        {
          id: 'C-100', requirementId: 'FLOW-STORY-001',
          condition: 'Verify auth flow propagation',
          conditionType: 'flow',
          flowStepRefs: [{ flowId: 'F-login', sequence: 1, actionSummary: 'Submit' }],
          category: 'integration', priority: 'critical', riskLevel: 'high',
          primaryTechnique: 'Use Case Testing',
          secondaryTechniques: [], techniqueRationale: 'Cross-component',
          coverageDimensions: ['flow'],
          dependencies: ['C-PREV-001', 'C-PREV-002'],
        },
      ],
    }));

    expect(parsed.testConditions[0].dependencies).toEqual(['C-PREV-001', 'C-PREV-002']);
  });
});
