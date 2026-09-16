import { Log } from '../../../shared/services/logger.ts';

/**
 * Structured failure telemetry for the ai-test-gen pipeline (F4).
 *
 * Every structured-output failure branch in callLLMWithStructuredOutput
 * records one entry so failures can be counted per
 * agent × provider × structuredMode × failureType instead of appearing as a
 * mixed-average failure rate. In-memory per process; the orchestrator resets
 * at run start and logs the distribution at run end.
 */

export type StructuredMode = 'json_schema' | 'json_object' | 'none';

export type FailureType =
  | 'SCHEMA'
  | 'UNPARSEABLE'
  | 'TRUNCATED'
  | 'EMIT_REPAIR_NOT_CONVERGED'
  | 'NO_CONTENT';

export interface FailureRecord {
  agent: string;
  providerKind: string;
  structuredMode: StructuredMode;
  failureType: FailureType;
  attempt: number;
  errorPaths?: string[];
}

const records: FailureRecord[] = [];
const log = Log.for('failure-telemetry');

/**
 * The structured-output mode a provider actually applies to a jsonSchema
 * request: openai-compatible deliberately downgrades to json_object (agnes
 * returns empty content under json_schema+strict); azure / openai-responses
 * use json_schema.
 */
export function structuredModeFor(providerKind: string | undefined, hasJsonSchema: boolean): StructuredMode {
  if (!hasJsonSchema) return 'none';
  return providerKind === 'openai-compatible' ? 'json_object' : 'json_schema';
}

export function recordFailure(record: FailureRecord): void {
  records.push(record);
  log.kv('failure', JSON.stringify(record));
}

/** Record a failure, extracting bounded error paths from a Zod-like error. */
export function recordFailureFromZod(
  base: Omit<FailureRecord, 'errorPaths'>,
  err: unknown,
): void {
  const issues = (err as { issues?: Array<{ path?: Array<string | number> }> } | null | undefined)?.issues ?? [];
  const errorPaths = issues
    .map((i) => (i.path ?? []).join('.') || '(root)')
    .filter((p, idx, all) => all.indexOf(p) === idx)
    .slice(0, 8);
  recordFailure({ ...base, errorPaths: errorPaths.length > 0 ? errorPaths : undefined });
}

export function resetFailureTelemetry(): void {
  records.length = 0;
}

export function failureDistribution(): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of records) {
    const key = `${r.agent} | ${r.providerKind} | ${r.structuredMode} | ${r.failureType}`;
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

export function logFailureSummary(): void {
  const dist = failureDistribution();
  const total = records.length;
  if (total === 0) return;
  log.info(`Failure distribution ── ${total} record(s):`);
  for (const [key, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    log.kv(key, count);
  }
}
