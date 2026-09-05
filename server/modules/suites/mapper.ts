import type { SuiteVariable, TestCase, TestSuite } from '../../shared/contracts/index.ts';
import { asArray, asId, asOptionalText, asText, normalizeStringRecord } from '../../shared/utils/index.ts';
import { normalizeStep } from '../common/mapper.ts';
import { normalizeAssertSteps } from '../../../shared/execution-core/assert-normalizer.ts';

function normalizeSuiteVariable(input: Partial<SuiteVariable>): SuiteVariable {
  return {
    id: asId(input.id, 'var'),
    key: asText(input.key, 'VAR_1'),
    value: asText(input.value),
  };
}

function normalizeStepList(input: unknown): TestCase['steps'] {
  return normalizeAssertSteps(asArray(input).map((step) => normalizeStep(step)));
}

function normalizeCase(input: Partial<TestCase>): TestCase {
  return {
    id: asId(input.id, 'case'),
    name: asText(input.name, 'New Test Case'),
    description: asText(input.description),
    steps: normalizeStepList(input.steps),
    setupSteps: normalizeStepList(input.setupSteps),
    teardownSteps: normalizeStepList(input.teardownSteps),
  };
}

export function normalizeSuite(input: Partial<TestSuite>): TestSuite {
  return {
    id: asId(input.id, 'suite'),
    projectId: asOptionalText(input.projectId),
    name: asText(input.name, 'New Test Suite'),
    description: asText(input.description),
    position: input.position ?? 0,
    cases: asArray<TestCase>(input.cases).map((testCase) => normalizeCase(testCase)),
    variables: asArray<SuiteVariable>(input.variables).map((variable) => normalizeSuiteVariable(variable)),
    dataRows: asArray<Record<string, unknown>>(input.dataRows).map((row) => normalizeStringRecord(row)),
    setupSteps: normalizeStepList(input.setupSteps),
    teardownSteps: normalizeStepList(input.teardownSteps),
  };
}
