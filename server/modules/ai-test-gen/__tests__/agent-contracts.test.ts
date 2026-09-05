import { describe, expect, it } from 'vitest';
import {
  testConditionContractSchema,
  draftTestCaseContractSchema,
  finalTestCaseContractSchema,
  coverageMatrixContractSchema,
} from 'shared/recording/agent-contracts.ts';
import { createAnalystOutputProfile } from '../graph/structured-output/analyst.ts';
import { createDesignerOutputProfile } from '../graph/structured-output/designer.ts';
import { createQualityOutputProfile } from '../graph/structured-output/quality.ts';
import { buildDesignerUserMessage } from '../graph/prompts.ts';

/**
 * Agent 交接口契约测试（数据级锁，docs/08 一致性铁律的 agent 层投影）。
 *
 * 业界最佳：SSOT 契约 schema + 数据级锁。这里断言：
 * 1. 三个 agent 的合法输出样例，其关键交接口字段都能被契约 schema 解析
 *    （即 Analyst 输出 = Designer 输入、Designer 输出 = Quality 输入的结构同源）。
 * 2. buildDesignerUserMessage 能从 Analyst 合法输出中取出 Designer 消费的全部字段。
 * 3. 契约 schema 本身拒绝缺关键字段的漂移（改一侧，测试立刻炸）。
 */

describe('agent inter-hop contract — Analyst output → Designer input', () => {
  const analystProfile = createAnalystOutputProfile(
    new Set(['req-aut-auth']),
    [{ id: 'F-1', steps: [{ sequence: 1, actionSummary: 'login' }] }],
    new Map(),
    new Set(),
  );

  const analystOutput = {
    requirementAnalysis: {
      overallApproach: 'Risk-based',
      riskAssessmentSummary: 'Auth risk high',
    },
    testConditions: [{
      id: 'C-001',
      requirementId: 'req-aut-auth',
      condition: 'Verify login form displays username, password and sign-in button',
      conditionType: 'component' as const,
      category: 'functional',
      priority: 'medium',
      riskLevel: 'medium',
      primaryTechnique: 'Equivalence Partitioning',
      secondaryTechniques: [],
      techniqueRationale: 'Valid and invalid partitions',
      coverageDimensions: ['ui'],
      dependencies: [],
    }, {
      id: 'C-002',
      requirementId: 'req-aut-auth',
      condition: 'Verify auth session happy path',
      conditionType: 'flow' as const,
      flowStepRefs: [{ flowId: 'F-1', sequence: 1, actionSummary: 'login' }],
      category: 'integration',
      priority: 'critical',
      riskLevel: 'high',
      primaryTechnique: 'Use Case Testing',
      secondaryTechniques: [],
      techniqueRationale: 'Cross-component journey',
      coverageDimensions: ['flow'],
      dependencies: [],
    }],
  };

  it('Analyst legal output passes the TestCondition contract (SSOT shape)', () => {
    const parsed = analystProfile.parse(analystProfile.normalize(analystOutput));
    for (const cond of parsed.testConditions) {
      expect(testConditionContractSchema.safeParse(cond).success).toBe(true);
    }
  });

  it('buildDesignerUserMessage consumes every Designer-required field from Analyst output', () => {
    const parsed = analystProfile.parse(analystProfile.normalize(analystOutput));
    // feed through the real Designer input builder, using the contract type
    const state = {
      approvedConditions: parsed.testConditions,
      relevantFlowBlueprints: [{ id: 'F-1', name: 'Login', steps: [{ sequence: 1, actionSummary: 'login', requirementIds: [], requirementId: 'req-aut-auth', requirementTitle: 'Auth', requirementLevel: 'story', acceptanceCriteria: [] }] }],
      businessFlowBlueprints: [],
      projectContext: { name: 'Demo', pages: [], endpoints: [] },
    } as any;
    const message = JSON.parse(buildDesignerUserMessage(state));
    expect(Array.isArray(message.conditions)).toBe(true);
    const c = message.conditions[0];
    // Designer's prompt maps these exact fields
    for (const field of ['id', 'condition', 'conditionType', 'priority', 'category', 'primaryTechnique', 'secondaryTechniques', 'riskLevel', 'requirementId', 'coverageDimensions']) {
      expect(c, `missing Designer-required field ${field}`).toHaveProperty(field);
    }
    // flow conditions carry flowStepRefs
    const flowCond = message.conditions.find((x: any) => x.conditionType === 'flow');
    expect(flowCond.flowStepRefs).toHaveLength(1);
    expect(flowCond.flowStepRefs[0].flowId).toBe('F-1');
  });
});

describe('agent inter-hop contract — Designer output → Quality input', () => {
  const conditions = [
    { id: 'C-001', requirementId: 'req-aut-auth', conditionType: 'component' as const },
    { id: 'C-002', requirementId: 'req-aut-auth', conditionType: 'flow' as const },
  ];
  const designerProfile = createDesignerOutputProfile(conditions);

  const designerOutput = {
    draftTestCases: [{
      id: 'TC-001',
      title: 'Login happy path',
      conditionId: 'C-002',
      requirementId: 'req-aut-auth',
      coveredConditions: ['C-002'],
      referencedComponentConditions: ['C-001'],
      priority: 'critical',
      category: 'functional',
      testLevel: 'integration',
      techniqueApplied: 'Use Case Testing',
      preconditions: ['User is on login page'],
      testData: ['username = admin'],
      steps: [
        { stepNumber: 1, action: "fill the username field with 'admin'", expected: "Field shows 'admin'", intent: { targetHint: 'username input field', data: 'admin', expectation: { kind: 'value', value: 'admin' } } },
        { stepNumber: 2, action: 'click the Sign in button', expected: 'Login request sent', intent: { targetHint: 'Sign in button', expectation: { kind: 'network', method: 'POST', urlPattern: '/login', value: '200' } } },
      ],
      postconditions: [],
      tags: [],
      selfReview: { score: 9, strengths: ['atomic'], weaknesses: [], suggestions: [] },
    }, {
      id: 'TC-002',
      title: 'Login form displays fields',
      conditionId: 'C-001',
      requirementId: 'req-aut-auth',
      coveredConditions: ['C-001'],
      referencedComponentConditions: [],
      priority: 'medium',
      category: 'functional',
      testLevel: 'component',
      techniqueApplied: 'Equivalence Partitioning',
      preconditions: ['User is on login page'],
      testData: [],
      steps: [
        { stepNumber: 1, action: 'verify the username input field is visible', expected: 'Username field visible', intent: { targetHint: 'username input field', expectation: { kind: 'element-visible' } } },
        { stepNumber: 2, action: 'verify the Sign in button is visible', expected: 'Sign in button visible', intent: { targetHint: 'Sign in button', expectation: { kind: 'element-visible' } } },
      ],
      postconditions: [],
      tags: [],
      selfReview: { score: 8, strengths: ['atomic'], weaknesses: [], suggestions: [] },
    }],
  };

  it('Designer legal output passes the DraftTestCase contract (SSOT shape)', () => {
    const parsed = designerProfile.parse(designerProfile.normalize(designerOutput));
    for (const tc of parsed.draftTestCases) {
      expect(draftTestCaseContractSchema.safeParse(tc).success).toBe(true);
    }
  });

  it('Draft case steps carry vocabulary verbs in action first word', () => {
    const parsed = designerProfile.parse(designerProfile.normalize(designerOutput));
    for (const tc of parsed.draftTestCases) {
      for (const s of tc.steps) {
        const head = s.action.split(/\s+/)[0].toLowerCase();
        expect(['fill', 'click', 'verify', 'waitfor', 'navigate', 'select', 'clear', 'check', 'uncheck', 'press', 'hover', 'scroll', 'upload', 'toggle', 'drag', 'switchto', 'dialog', 'doubleclick', 'rightclick', 'extract']).toContain(head);
      }
    }
  });
});

describe('agent inter-hop contract — Quality output', () => {
  const qualityProfile = createQualityOutputProfile([{
    id: 'TC-001', conditionId: 'C-001', requirementId: 'req-aut-auth', expectedTestLevel: 'component', coveredConditions: ['C-001'], referencedComponentConditions: [],
  }]);

  const qualityOutput = {
    finalTestCases: [{
      id: 'TC-001',
      title: 'Login happy path',
      conditionId: 'C-001',
      requirementId: 'req-aut-auth',
      coveredConditions: ['C-001'],
      referencedComponentConditions: [],
      priority: 'high',
      category: 'functional',
      testLevel: 'component',
      techniqueApplied: 'Equivalence Partitioning',
      preconditions: ['On login page'],
      testData: ['username = admin'],
      steps: [{ stepNumber: 1, action: "fill the username field with 'admin'", expected: "Field shows 'admin'" }],
      tags: [],
      status: 'approved',
      reviewSummary: 'ok',
      changeLog: [],
    }],
    coverageMatrix: {
      rows: [{
        conditionId: 'C-001',
        conditionSummary: 'Login form',
        requirementId: 'req-aut-auth',
        testLevel: 'component',
        primaryTechnique: 'Equivalence Partitioning',
        category: 'functional',
        conditionType: 'component',
        coveredByCaseIds: ['TC-001'],
        coverageStatus: 'covered',
        notes: '',
      }],
      summary: {
        totalConditions: 1,
        coveredConditions: 1,
        missingConditions: 0,
        byTestLevel: { component: 1 },
        byTechnique: { 'Equivalence Partitioning': 1 },
        byCategory: { functional: 1 },
        byConditionType: { component: 1 },
      },
    },
  };

  it('Quality legal output passes FinalTestCase + CoverageMatrix contracts', () => {
    const parsed = qualityProfile.parse(qualityProfile.normalize(qualityOutput));
    for (const tc of parsed.finalTestCases) {
      expect(finalTestCaseContractSchema.safeParse(tc).success).toBe(true);
    }
    if (parsed.coverageMatrix) {
      expect(coverageMatrixContractSchema.safeParse(parsed.coverageMatrix).success).toBe(true);
    }
  });

  it('contract schema rejects a missing required field (drift lock)', () => {
    const broken = { id: 'TC-001', conditionId: 'C-001', requirementId: 'req-aut-auth' }; // no steps/title/testLevel
    expect(finalTestCaseContractSchema.safeParse(broken).success).toBe(false);
    const brokenCond = { id: 'C-001', requirementId: 'req-aut-auth', condition: 'x' }; // no conditionType
    expect(testConditionContractSchema.safeParse(brokenCond).success).toBe(false);
  });
});