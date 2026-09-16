import { describe, expect, it, beforeEach } from 'vitest';
import {
  recordFailure,
  recordFailureFromZod,
  resetFailureTelemetry,
  failureDistribution,
  structuredModeFor,
} from '../infra/failure-telemetry.ts';

describe('failure telemetry', () => {
  beforeEach(() => resetFailureTelemetry());

  it('aggregates counts per agent × provider × structuredMode × failureType', () => {
    recordFailure({ agent: 'test_designer', providerKind: 'openai-compatible', structuredMode: 'json_object', failureType: 'TRUNCATED', attempt: 1 });
    recordFailure({ agent: 'test_designer', providerKind: 'openai-compatible', structuredMode: 'json_object', failureType: 'TRUNCATED', attempt: 2 });
    recordFailure({ agent: 'test_designer', providerKind: 'azure-openai', structuredMode: 'json_schema', failureType: 'SCHEMA', attempt: 1 });

    const dist = failureDistribution();
    expect(dist['test_designer | openai-compatible | json_object | TRUNCATED']).toBe(2);
    expect(dist['test_designer | azure-openai | json_schema | SCHEMA']).toBe(1);
  });

  it('extracts bounded deduplicated error paths from a Zod-like error', () => {
    recordFailureFromZod(
      { agent: 'test_designer', providerKind: 'azure-openai', structuredMode: 'json_schema', failureType: 'SCHEMA', attempt: 1 },
      { issues: [
        { path: ['draftTestCases', 0, 'testLevel'], message: 'invalid literal' },
        { path: ['draftTestCases', 0, 'testLevel'], message: 'duplicate path' },
        { path: [], message: 'root issue' },
      ] },
    );

    const dist = failureDistribution();
    expect(Object.keys(dist)).toHaveLength(1);
  });

  it('derives the structured mode from provider kind and jsonSchema presence', () => {
    expect(structuredModeFor('openai-compatible', true)).toBe('json_object');
    expect(structuredModeFor('azure-openai', true)).toBe('json_schema');
    expect(structuredModeFor('openai-responses', true)).toBe('json_schema');
    expect(structuredModeFor('azure-openai', false)).toBe('none');
    expect(structuredModeFor(undefined, true)).toBe('json_schema');
  });

  it('returns an empty distribution after reset', () => {
    recordFailure({ agent: 'a', providerKind: 'k', structuredMode: 'none', failureType: 'SCHEMA', attempt: 0 });
    resetFailureTelemetry();
    expect(failureDistribution()).toEqual({});
  });
});
