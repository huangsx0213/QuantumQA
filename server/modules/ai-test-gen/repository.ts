import { db } from '../../shared/db/client.ts';
import { randomId } from '../../shared/utils/index.ts';
import { decryptApiKey } from '../../shared/crypto.ts';
import { ConflictError, NotFoundError } from '../../shared/http/errors.ts';
import type Database from 'better-sqlite3';
import {
  MAX_HTML_PAGES,
  type HtmlKnowledgeReference,
} from './html-knowledge/types.ts';

export interface TestGenRunRow {
  id: string;
  project_id: string;
  status: string;
  phase: string;
  current_batch: number;
  total_batches: number;
  mode: string;
  config: string | null;
  token_usage: string | null;
  provider_type: string | null;
  model_name: string | null;
  prompt_version: string | null;
  provider_config_name: string | null;
  token_limit: number | null;
  thread_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  state: string | null;
}

export interface ProviderConfigRow {
  id: string;
  name: string;
  type: string;
  endpoint: string | null;
  encrypted_api_key: string;
  deployment: string | null;
  api_version: string | null;
  model: string | null;
  models: string | null;
  is_active: number;
  monthly_token_limit: number | null;
  fallback_config_ids: string | null;
  reasoning_effort: string | null;
  reasoning_summary: string | null;
  text_verbosity: string | null;
}

export type TestGenFailureState =
  {
    readonly type: 'CONTEXT_SETUP_FAILED';
    readonly phase: 'context';
    readonly recoverable: true;
  }
  | {
    readonly type: 'HTML_KNOWLEDGE_UNAVAILABLE';
    readonly phase: 'html-knowledge';
    readonly recoverable: true;
  };

export class TestGenRepository {
  constructor(private readonly database: Database.Database = db) {}

  getActiveProviderConfig(): ProviderConfigRow | undefined {
    return this.database.prepare('SELECT * FROM provider_configs WHERE is_active = 1 LIMIT 1').get() as any;
  }

  getProviderConfigByName(name: string): ProviderConfigRow | undefined {
    return this.database.prepare('SELECT * FROM provider_configs WHERE name = ? LIMIT 1').get(name) as any;
  }

  createRun(runId: string, projectId: string, mode: string, config: unknown, createdBy = 'anonymous'): void {
    const result = this.database.prepare(`
      INSERT INTO test_gen_runs (id, project_id, status, phase, current_batch, total_batches, mode, created_by, config)
      SELECT ?, p.id, 'RUNNING', 'analysis', 0, 0, ?, ?, ?
      FROM projects p
      WHERE p.id = ?
    `).run(runId, mode, createdBy, JSON.stringify(config), projectId);
    if (result.changes !== 1) throw new NotFoundError('Project not found');
  }

  updateModelInfo(runId: string, modelName: string, providerConfigName: string | null): void {
    this.database.prepare(
      'UPDATE test_gen_runs SET model_name = ?, provider_config_name = ? WHERE id = ?'
    ).run(modelName, providerConfigName, runId);
  }

  listRunsByProject(projectId: string): any[] {
    const rows = this.database.prepare(
      'SELECT id, project_id, status, phase, current_batch, total_batches, mode, config, created_by, token_usage, model_name, provider_config_name, created_at, updated_at FROM test_gen_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(projectId);
    return this.mapSafeRuns(rows as any[], (row) => ({
      token_usage: row.token_usage ? JSON.parse(row.token_usage) : {},
    }));
  }

  listRunIdsByProject(projectId: string): string[] {
    const rows = this.database.prepare(`
      SELECT id
      FROM test_gen_runs
      WHERE project_id = ?
      ORDER BY created_at, rowid
    `).all(projectId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getActiveRun(projectId: string): any {
    const row = this.database.prepare(
      "SELECT id, status, phase, current_batch, total_batches, mode, config, created_at, updated_at FROM test_gen_runs WHERE project_id = ? AND status IN ('RUNNING', 'WAITING_REVIEW') ORDER BY created_at DESC LIMIT 1"
    ).get(projectId) as any;
    if (!row) return null;
    return this.mapSafeRun(row);
  }

  getRun(runId: string): TestGenRunRow | undefined {
    return this.database.prepare('SELECT id, project_id, status, phase, current_batch, total_batches, mode FROM test_gen_runs WHERE id = ?').get(runId) as any;
  }

  getRunInfo(runId: string): any {
    const row = this.database.prepare('SELECT * FROM test_gen_runs WHERE id = ?').get(runId) as any;
    if (!row) return null;
    return this.mapSafeRun({
      id: row.id,
      status: row.status,
      phase: row.phase,
      current_batch: row.current_batch,
      total_batches: row.total_batches,
      token_usage: row.token_usage ? JSON.parse(row.token_usage) : null,
      created_by: row.created_by,
      thread_id: row.thread_id,
      mode: row.mode,
      config: row.config,
      provider_type: row.provider_type,
      model_name: row.model_name,
      prompt_version: row.prompt_version,
    });
  }

  updateBatchCount(runId: string, totalBatches: number): void {
    this.database.prepare('UPDATE test_gen_runs SET total_batches = ?, current_batch = 1 WHERE id = ?').run(totalBatches, runId);
  }

  updateCurrentBatch(runId: string, batch: number): void {
    this.database.prepare('UPDATE test_gen_runs SET current_batch = ? WHERE id = ?').run(batch, runId);
  }

  updateProviderInfo(runId: string, info: {
    providerType: string;
    modelName: string;
    promptVersion: string;
    providerConfigName: string | null;
    tokenLimit: number | null;
  }): void {
    this.database.prepare(`UPDATE test_gen_runs SET
      provider_type = ?, model_name = ?, prompt_version = ?, provider_config_name = ?, token_limit = ?
      WHERE id = ?`).run(
      info.providerType, info.modelName, info.promptVersion,
      info.providerConfigName, info.tokenLimit, runId,
    );
  }

  markRunFailed(runId: string, failure?: TestGenFailureState): void {
    this.database.prepare(`
      UPDATE test_gen_runs
      SET status = 'FAILED',
          phase = COALESCE(?, phase),
          state = COALESCE(?, state),
          updated_at = datetime('now') || 'Z'
      WHERE id = ?
    `).run(
      failure?.phase ?? null,
      failure ? JSON.stringify(failure) : null,
      runId,
    );
  }

  updateRunState(runId: string, state: string): void {
    this.database.prepare("UPDATE test_gen_runs SET state = ?, updated_at = datetime('now') || 'Z' WHERE id = ?").run(state, runId);
  }

  getRunState(runId: string): string | null {
    const row = this.database.prepare('SELECT state FROM test_gen_runs WHERE id = ?').get(runId) as any;
    return row?.state ?? null;
  }

  updatePhase(runId: string, phase: string): void {
    this.database.prepare("UPDATE test_gen_runs SET phase = ?, updated_at = datetime('now') || 'Z' WHERE id = ?").run(phase, runId);
  }

  getFailedRun(runId: string): TestGenRunRow | undefined {
    const row = this.database.prepare(
      "SELECT * FROM test_gen_runs WHERE id = ? AND status = 'FAILED'"
    ).get(runId) as TestGenRunRow | undefined;
    return row;
  }

  markRunCompleted(runId: string, phase: string, usage: unknown): void {
    this.database.prepare(`UPDATE test_gen_runs SET status = 'COMPLETED', phase = ?, token_usage = ?, updated_at = datetime('now') || 'Z' WHERE id = ?`)
      .run(phase, JSON.stringify(usage), runId);
  }

  setRunRunning(runId: string): void {
    this.database.prepare("UPDATE test_gen_runs SET status = 'RUNNING', updated_at = datetime('now') || 'Z' WHERE id = ?").run(runId);
  }

  setRunWaiting(runId: string, phase: string): void {
    this.database.prepare("UPDATE test_gen_runs SET status = 'WAITING_REVIEW', phase = ?, updated_at = datetime('now') || 'Z' WHERE id = ?")
      .run(phase, runId);
  }

  touchRun(runId: string): void {
    this.database.prepare("UPDATE test_gen_runs SET updated_at = datetime('now') || 'Z' WHERE id = ?").run(runId);
  }

  updateThreadId(runId: string, threadId: string): void {
    this.database.prepare("UPDATE test_gen_runs SET thread_id = ?, updated_at = datetime('now') || 'Z' WHERE id = ?")
      .run(threadId, runId);
  }

  getWaitingRuns(): any[] {
    const rows = this.database.prepare(
      "SELECT id, project_id, status, phase, thread_id, mode, config, updated_at FROM test_gen_runs WHERE status = 'WAITING_REVIEW' AND thread_id IS NOT NULL"
    ).all();
    return (rows as any[]).map(r => ({
      ...r,
      config: r.config ? JSON.parse(r.config) : null,
    }));
  }

  getRunWithThreadId(runId: string): any {
    const row = this.database.prepare(
      'SELECT id, project_id, status, phase, thread_id, mode, config, current_batch, total_batches FROM test_gen_runs WHERE id = ?'
    ).get(runId) as any;
    if (!row) return null;
    return {
      ...row,
      config: row.config ? JSON.parse(row.config) : null,
    };
  }

  getMonthlyTokenUsage(projectId: string): number {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const result = this.database.prepare(`
      SELECT SUM(CAST(COALESCE(json_extract(token_usage, '$.total_tokens'), '0') AS INTEGER)) as total
      FROM test_gen_runs
      WHERE project_id = ? AND created_at >= ? AND status IN ('COMPLETED', 'RUNNING')
    `).get(projectId, monthStart.toISOString()) as any;
    return result?.total ?? 0;
  }

  deleteRun(runId: string): void {
    const remove = this.database.transaction(() => {
      this.deleteCheckpointThreads([runId]);
      this.database.prepare('DELETE FROM test_gen_agent_logs WHERE run_id = ?').run(runId);
      this.database.prepare('DELETE FROM test_gen_audit_log WHERE run_id = ?').run(runId);
      this.database.prepare('DELETE FROM test_gen_runs WHERE id = ?').run(runId);
    });
    remove.immediate();
  }

  deleteProjectData(projectId: string, quiescedRunIds: readonly string[]): string[] {
    const remove = this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM test_gen_runs WHERE project_id = ? ORDER BY created_at, rowid
      `).all(projectId) as Array<{ id: string }>;
      const quiesced = new Set(quiescedRunIds);
      if (rows.some((row) => !quiesced.has(row.id))) {
        throw new ConflictError('A Test Gen run started during project deletion');
      }

      this.deleteCheckpointThreads(rows.map((row) => row.id));

      this.database.prepare(`
        DELETE FROM test_gen_agent_logs
        WHERE run_id IN (SELECT id FROM test_gen_runs WHERE project_id = ?)
      `).run(projectId);
      this.database.prepare(`
        DELETE FROM test_gen_audit_log
        WHERE run_id IN (SELECT id FROM test_gen_runs WHERE project_id = ?)
      `).run(projectId);
      this.database.prepare('DELETE FROM test_gen_runs WHERE project_id = ?').run(projectId);
      this.database.prepare(`
        DELETE FROM test_gen_html_knowledge_sets
        WHERE project_id = ? AND status IN ('UPLOADING', 'READY') AND run_id IS NULL
      `).run(projectId);
      this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      return rows.map((row) => row.id);
    });
    return remove.immediate();
  }

  saveThinkingData(runId: string, thinkingJson: string): void {
    this.database.prepare('UPDATE test_gen_runs SET thinking_data = ? WHERE id = ?').run(thinkingJson, runId);
  }

  getThinkingData(runId: string): Record<string, Array<{ type: string; phase: string; text: string; timestamp: number }>> | null {
    const row = this.database.prepare('SELECT thinking_data FROM test_gen_runs WHERE id = ?').get(runId) as any;
    if (!row?.thinking_data) return null;
    try {
      return JSON.parse(row.thinking_data);
    } catch {
      return null;
    }
  }

  getAgentLogs(runId: string, agent?: string): any[] {
    let rows: any[];
    if (agent) {
      rows = this.database.prepare(
        'SELECT * FROM test_gen_agent_logs WHERE run_id = ? AND agent_name = ? ORDER BY created_at, rowid'
      ).all(runId, agent);
    } else {
      rows = this.database.prepare(
        'SELECT * FROM test_gen_agent_logs WHERE run_id = ? ORDER BY created_at, rowid'
      ).all(runId);
    }
    return (rows as any[]).map(r => ({
      ...r,
      input_prompt: r.input_prompt ? JSON.parse(r.input_prompt) : null,
      output_data: r.output_data ? JSON.parse(r.output_data) : null,
      token_usage: r.token_usage ? JSON.parse(r.token_usage) : null,
      raw_trace: r.raw_trace ? JSON.parse(r.raw_trace) : [],
      tool_history: r.tool_history ? JSON.parse(r.tool_history) : null,
      error_message: r.error_message ?? null,
      error_raw_response: r.error_raw_response ?? null,
    }));
  }

  /** Get accumulated token usage and latency from completed agent logs for a run (used when resuming). */
getAccumulatedTokenUsage(runId: string): { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; cached_tokens: number; latency_ms: number } {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(CAST(COALESCE(json_extract(token_usage, '$.input'), '0') AS INTEGER)), 0) as prompt_tokens,
              COALESCE(SUM(CAST(COALESCE(json_extract(token_usage, '$.output'), '0') AS INTEGER)), 0) as completion_tokens,
              COALESCE(SUM(CAST(COALESCE(json_extract(token_usage, '$.reasoning'), '0') AS INTEGER)), 0) as reasoning_tokens,
              COALESCE(SUM(CAST(COALESCE(json_extract(token_usage, '$.cached'), '0') AS INTEGER)), 0) as cached_tokens,
              COALESCE(SUM(COALESCE(latency_ms, 0)), 0) as latency_ms
       FROM test_gen_agent_logs WHERE run_id = ? AND status = 'COMPLETED'`
    ).get(runId) as any;
    return {
      prompt_tokens: row?.prompt_tokens ?? 0,
      completion_tokens: row?.completion_tokens ?? 0,
      reasoning_tokens: row?.reasoning_tokens ?? 0,
      cached_tokens: row?.cached_tokens ?? 0,
      latency_ms: row?.latency_ms ?? 0,
    };
  }

  updateAgentLogOutput(runId: string, agentName: string, outputData: Record<string, unknown>): void {
    const log = this.database.prepare(
      'SELECT id, output_data FROM test_gen_agent_logs WHERE run_id = ? AND agent_name = ? AND status = \'COMPLETED\' ORDER BY batch DESC LIMIT 1'
    ).get(runId, agentName) as any;
    if (log) {
      const existing = log.output_data ? JSON.parse(log.output_data) : {};
      const merged = { ...existing, ...outputData };
      this.database.prepare('UPDATE test_gen_agent_logs SET output_data = ? WHERE id = ?').run(JSON.stringify(merged), log.id);
    }
  }

  saveAgentLog(snapshot: {
    logId: string;
    batch: number;
    agentName: string;
    phase?: string;
    inputPrompt?: unknown;
    outputData?: unknown;
    tokenUsage?: { input: number; output: number; reasoning?: number; cached?: number };
    latencyMs?: number | null;
    rawTrace?: unknown[];
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    errorMessage?: string;
    errorRawResponse?: string;
    toolHistory?: unknown;
  }, runId: string): void {
    const json = (v: unknown) => v !== null && v !== undefined ? JSON.stringify(v) : null;
    this.database.prepare(`
      INSERT INTO test_gen_agent_logs (id, run_id, batch, agent_name, phase, input_prompt, output_data, token_usage, latency_ms, raw_trace, status, error_message, error_raw_response, tool_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_prompt = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.input_prompt
          ELSE COALESCE(excluded.input_prompt, test_gen_agent_logs.input_prompt)
        END,
        output_data = CASE
          WHEN excluded.status IN ('COMPLETED', 'FAILED')
            THEN excluded.output_data
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.output_data
          ELSE COALESCE(excluded.output_data, test_gen_agent_logs.output_data)
        END,
        token_usage = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.token_usage
          ELSE COALESCE(excluded.token_usage, test_gen_agent_logs.token_usage)
        END,
        latency_ms = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.latency_ms
          ELSE COALESCE(excluded.latency_ms, test_gen_agent_logs.latency_ms)
        END,
        raw_trace = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.raw_trace
          ELSE COALESCE(excluded.raw_trace, test_gen_agent_logs.raw_trace)
        END,
        error_message = CASE
          WHEN excluded.status IN ('RUNNING', 'COMPLETED') THEN NULL
          ELSE excluded.error_message
        END,
        error_raw_response = CASE
          WHEN excluded.status IN ('RUNNING', 'COMPLETED') THEN NULL
          ELSE excluded.error_raw_response
        END,
        tool_history = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN excluded.tool_history
          ELSE COALESCE(excluded.tool_history, test_gen_agent_logs.tool_history)
        END,
        thinking_text = CASE
          WHEN excluded.status = 'RUNNING' AND test_gen_agent_logs.status <> 'RUNNING'
            THEN NULL
          ELSE test_gen_agent_logs.thinking_text
        END,
        status = excluded.status
    `).run(
      snapshot.logId, runId, snapshot.batch, snapshot.agentName,
      snapshot.phase ?? '',
      json(snapshot.inputPrompt), json(snapshot.outputData),
      json(snapshot.tokenUsage), snapshot.latencyMs ?? null,
      snapshot.rawTrace && (snapshot.rawTrace as any[]).length > 0 ? json(snapshot.rawTrace) : null,
      snapshot.status,
      snapshot.errorMessage ?? null,
      snapshot.errorRawResponse ?? null,
      json(snapshot.toolHistory),
    );
  }

  insertAuditLog(runId: string, checkpointId: string, action: string, snapshot: unknown, userId = 'anonymous'): void {
    const logId = randomId('audit');
    const json = (v: unknown) => v !== null && v !== undefined ? JSON.stringify(v) : null;
    this.database.prepare(`
      INSERT INTO test_gen_audit_log (id, run_id, checkpoint_id, action, user_id, snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now') || 'Z')
    `).run(logId, runId, checkpointId, action, userId, json(snapshot));
  }

  getAuditLogs(runId: string, checkpointId?: string): any[] {
    const sql = checkpointId
      ? 'SELECT * FROM test_gen_audit_log WHERE run_id = ? AND checkpoint_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM test_gen_audit_log WHERE run_id = ? ORDER BY created_at DESC';
    const rows = checkpointId
      ? this.database.prepare(sql).all(runId, checkpointId)
      : this.database.prepare(sql).all(runId);
    return (rows as any[]).map(r => ({
      ...r,
      snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
      created_at: r.created_at ? new Date(r.created_at.replace(/Z$/, '') + 'Z').toISOString() : r.created_at,
    }));
  }

  // ---- Prompt Overrides ----

  getPromptOverrides(projectId: string): any[] {
    return this.database.prepare(
      'SELECT * FROM test_gen_prompt_overrides WHERE project_id = ?'
    ).all(projectId);
  }

  getPromptOverride(projectId: string, agentName: string): any | undefined {
    return this.database.prepare(
      'SELECT * FROM test_gen_prompt_overrides WHERE project_id = ? AND agent_name = ?'
    ).get(projectId, agentName);
  }

  upsertPromptOverride(projectId: string, agentName: string, customPrompt: string | null, modelOverride: string | null): void {
    const id = `${projectId}_${agentName}`;
    this.database.prepare(`
      INSERT INTO test_gen_prompt_overrides (id, project_id, agent_name, custom_prompt, model_override, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(project_id, agent_name) DO UPDATE SET
        custom_prompt = excluded.custom_prompt,
        model_override = excluded.model_override,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, projectId, agentName, customPrompt, modelOverride);
  }

  deletePromptOverride(projectId: string, agentName: string): void {
    this.database.prepare(
      'DELETE FROM test_gen_prompt_overrides WHERE project_id = ? AND agent_name = ?'
    ).run(projectId, agentName);
  }

  private mapSafeRun(row: any, overrides: Record<string, unknown> = {}): any {
    return this.mapSafeRuns([row], () => overrides)[0];
  }

  private deleteCheckpointThreads(runIds: readonly string[]): void {
    if (runIds.length === 0) return;
    const checkpointTables = [
      'writes',
      'checkpoint_writes',
      'checkpoint_blobs',
      'checkpoints',
    ] as const;
    for (const table of checkpointTables) {
      const exists = this.database.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(table);
      if (!exists) continue;
      const hasThreadId = this.database.prepare(`
        SELECT 1 FROM pragma_table_info(?) WHERE name = 'thread_id'
      `).get(table);
      if (!hasThreadId) continue;
      const remove = this.database.prepare(`
        DELETE FROM ${table}
        WHERE substr(thread_id, 1, ?) = ?
      `);
      for (const runId of runIds) {
        const prefix = `${runId}-batch-`;
        remove.run(prefix.length, prefix);
      }
    }
  }

  private mapSafeRuns(
    rows: any[],
    overridesForRow: (row: any) => Record<string, unknown> = () => ({}),
  ): any[] {
    const configs = new Map<string, Record<string, any> | null>();
    const expectedSets = new Map<string, string>();
    for (const row of rows) {
      const config = parseSafeRunConfig(row.config);
      configs.set(row.id, config);
      if (config?.htmlKnowledgeSetId) expectedSets.set(row.id, config.htmlKnowledgeSetId);
    }
    const metadata = this.getSafeHtmlKnowledgeMetadata(expectedSets);
    return rows.map((row) => ({
      ...row,
      ...overridesForRow(row),
      config: configs.get(row.id) ?? null,
      ...(metadata.has(row.id) ? { htmlKnowledge: metadata.get(row.id) } : {}),
    }));
  }

  private getSafeHtmlKnowledgeMetadata(
    expectedSets: ReadonlyMap<string, string>,
  ): Map<string, HtmlKnowledgeReference> {
    const metadata = new Map<string, HtmlKnowledgeReference>();
    if (expectedSets.size === 0) return metadata;
    const runIds = [...expectedSets.keys()];
    const placeholders = runIds.map(() => '?').join(', ');
    const sets = this.database.prepare(`
      SELECT id, run_id, page_count, total_bytes, requirement_snapshot_hash
      FROM test_gen_html_knowledge_sets
      WHERE run_id IN (${placeholders}) AND status = 'BOUND'
        AND requirement_snapshot_hash IS NOT NULL
    `).all(...runIds) as Array<{
      id: string;
      run_id: string;
      page_count: number;
      total_bytes: number;
      requirement_snapshot_hash: string;
    }>;
    const matchingSets = sets.filter((set) => expectedSets.get(set.run_id) === set.id);
    if (matchingSets.length === 0) return metadata;
    const setIds = matchingSets.map((set) => set.id);
    const setPlaceholders = setIds.map(() => '?').join(', ');
    const pages = this.database.prepare(`
      SELECT knowledge_set_id, page_title, information_level
      FROM test_gen_html_knowledge_pages
      WHERE knowledge_set_id IN (${setPlaceholders})
      ORDER BY knowledge_set_id, file_name_key, id
    `).all(...setIds) as Array<{
      knowledge_set_id: string;
      page_title: string | null;
      information_level: string | null;
    }>;
    const pageMetadata = new Map<string, { titles: string[]; hasLowInformationPages: boolean }>();
    for (const page of pages) {
      const entry = pageMetadata.get(page.knowledge_set_id) ?? {
        titles: [],
        hasLowInformationPages: false,
      };
      if (typeof page.page_title === 'string' && entry.titles.length < MAX_HTML_PAGES) {
        entry.titles.push(page.page_title);
      }
      if (page.information_level === 'LOW_INFORMATION') entry.hasLowInformationPages = true;
      pageMetadata.set(page.knowledge_set_id, entry);
    }
    for (const set of matchingSets) {
      const pageData = pageMetadata.get(set.id);
      metadata.set(set.run_id, {
        knowledgeSetId: set.id,
        pageCount: set.page_count,
        totalBytes: set.total_bytes,
        pageTitles: pageData?.titles ?? [],
        hasLowInformationPages: pageData?.hasLowInformationPages ?? false,
        requirementSnapshotHash: set.requirement_snapshot_hash,
      });
    }
    return metadata;
  }
}

function parseSafeRunConfig(serialized: unknown): Record<string, any> | null {
  if (typeof serialized !== 'string' || serialized.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const config: Record<string, any> = {};
  copyStringArray(input, config, 'requirementIds');
  copyString(input, config, 'providerConfigName');
  copyString(input, config, 'model');
  if (input.mode === 'auto' || input.mode === 'interactive') config.mode = input.mode;
  copyStringArray(input, config, 'flowIds');
  copyString(input, config, 'name');
  if (typeof input.useCache === 'boolean') config.useCache = input.useCache;
  if (input.reasoningEffort === 'low' || input.reasoningEffort === 'medium' || input.reasoningEffort === 'high') {
    config.reasoningEffort = input.reasoningEffort;
  }
  if (input.reasoningSummary === 'auto' || input.reasoningSummary === 'detailed' || input.reasoningSummary === 'concise') {
    config.reasoningSummary = input.reasoningSummary;
  }
  if (input.textVerbosity === 'low' || input.textVerbosity === 'medium' || input.textVerbosity === 'high') {
    config.textVerbosity = input.textVerbosity;
  }
  copyStringArray(input, config, 'referenceRunIds');
  copyString(input, config, 'htmlKnowledgeSetId');
  return config;
}

function copyString(
  input: Record<string, unknown>,
  output: Record<string, any>,
  key: string,
): void {
  if (typeof input[key] === 'string' && input[key].length > 0) output[key] = input[key];
}

function copyStringArray(
  input: Record<string, unknown>,
  output: Record<string, any>,
  key: string,
): void {
  if (Array.isArray(input[key]) && input[key].every((item) => typeof item === 'string')) {
    output[key] = [...input[key]];
  }
}

export const pipelineRepo = new TestGenRepository();
export { decryptApiKey };
