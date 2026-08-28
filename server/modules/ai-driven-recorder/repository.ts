/**
 * AI-Driven Recorder Repository
 *
 * 数据访问层，封装 ai_driven_recording_runs 和 ai_driven_recording_step_logs 表的 CRUD。
 * 不包含业务逻辑，只做数据持久化。
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §7
 */

import { db } from '../../shared/db/client.ts';
import { randomId } from '../../shared/utils/index.ts';
import { decryptApiKey } from '../../shared/crypto.ts';
import type { DecryptedProviderConfig } from '../../../shared/recording/protocol.ts';

// === Run 状态类型 ===
export type RunStatus = 'running' | 'refining' | 'replaying' | 'completed' | 'failed';

// === Row 类型（对应 DB 列）===

export interface AiDrivenRecordingRunRow {
  id: string;
  project_id: string;
  nl_case_id: string;
  provider_config_id: string | null;
  status: string;
  execution_mode: string;
  started_at: string;
  completed_at: string | null;
  total_steps: number;
  completed_steps: number;
  failed_steps: number;
  result_suite_id: string | null;
  result_case_id: string | null;
  replay_report: string | null;
  error: string | null;
  options: string | null;
  token_usage: string | null;
}

export interface AiDrivenRecordingStepLogRow {
  id: string;
  run_id: string;
  nl_step_index: number;
  instruction: string;
  expected: string | null;
  success: number;
  assertions: string | null;
  recorded_step_count: number;
  retry_count: number;
  duration_ms: number | null;
  error: string | null;
  provenance: string | null;
  log_details: string | null;
  created_at: string;
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
}

// === Repository ===

export class AiDrivenRecorderRepository {
  // === Run CRUD ===

  createRun(params: {
    id?: string;
    projectId: string;
    nlCaseId: string;
    providerConfigId?: string;
    options?: Record<string, unknown>;
    executionMode?: 'agent' | 'local';
  }): string {
    const id = params.id ?? randomId('ai-rec-run');
    db.prepare(`
      INSERT INTO ai_driven_recording_runs
        (id, project_id, nl_case_id, provider_config_id, status, execution_mode, options)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      params.projectId,
      params.nlCaseId,
      params.providerConfigId ?? null,
      params.executionMode ?? 'agent',
      params.options ? JSON.stringify(params.options) : null,
    );
    return id;
  }

  getRun(id: string): AiDrivenRecordingRunRow | undefined {
    return db.prepare('SELECT * FROM ai_driven_recording_runs WHERE id = ?').get(id) as
      | AiDrivenRecordingRunRow
      | undefined;
  }

  /**
   * 列出"疑似中断"的活跃 run：仍在 running/refining/replaying 但已超过阈值时间未完成。
   * 用于 server 重启后的 finalize 恢复（COMPLETE 事件在 WS 断线时丢失，见 recover.ts）。
   */
  listStaleActiveRuns(staleAfterMinutes: number): AiDrivenRecordingRunRow[] {
    const rows = db
      .prepare(
        `SELECT * FROM ai_driven_recording_runs
         WHERE status IN ('running', 'refining', 'replaying')
           AND julianday('now') - julianday(started_at) > ?`,
      )
      .all(staleAfterMinutes / (24 * 60)) as AiDrivenRecordingRunRow[];
    return rows;
  }

  getRunsByProject(projectId: string): AiDrivenRecordingRunRow[] {
    return db
      .prepare('SELECT * FROM ai_driven_recording_runs WHERE project_id = ? ORDER BY started_at DESC')
      .all(projectId) as AiDrivenRecordingRunRow[];
  }

  updateRunStatus(id: string, status: RunStatus, error?: string): void {
    if (error) {
      db.prepare(`
        UPDATE ai_driven_recording_runs
        SET status = ?, error = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(status, error, id);
    } else if (status === 'completed' || status === 'failed') {
      db.prepare(`
        UPDATE ai_driven_recording_runs
        SET status = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(status, id);
    } else {
      db.prepare('UPDATE ai_driven_recording_runs SET status = ? WHERE id = ?').run(status, id);
    }
  }

  updateRunProgress(
    id: string,
    progress: { totalSteps?: number; completedSteps?: number; failedSteps?: number },
  ): void {
    const sets: string[] = [];
    const values: any[] = [];
    if (progress.totalSteps !== undefined) {
      sets.push('total_steps = ?');
      values.push(progress.totalSteps);
    }
    if (progress.completedSteps !== undefined) {
      sets.push('completed_steps = ?');
      values.push(progress.completedSteps);
    }
    if (progress.failedSteps !== undefined) {
      sets.push('failed_steps = ?');
      values.push(progress.failedSteps);
    }
    if (sets.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE ai_driven_recording_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  updateRunResult(
    id: string,
    result: { suiteId?: string; caseId?: string; replayReport?: unknown },
  ): void {
    const sets: string[] = [];
    const values: any[] = [];
    if (result.suiteId !== undefined) {
      sets.push('result_suite_id = ?');
      values.push(result.suiteId);
    }
    if (result.caseId !== undefined) {
      sets.push('result_case_id = ?');
      values.push(result.caseId);
    }
    if (result.replayReport !== undefined) {
      sets.push('replay_report = ?');
      values.push(JSON.stringify(result.replayReport));
    }
    if (sets.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE ai_driven_recording_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // === Step Log CRUD ===

  insertStepLog(params: {
    runId: string;
    nlStepIndex: number;
    instruction: string;
    expected?: string;
    success?: boolean;
    assertions?: unknown;
    recordedStepCount?: number;
    retryCount?: number;
    durationMs?: number;
    error?: string;
    provenance?: unknown;
    logDetails?: unknown;
  }): string {
    const id = randomId('ai-rec-step');
    db.prepare(`
      INSERT INTO ai_driven_recording_step_logs
        (id, run_id, nl_step_index, instruction, expected, success, assertions,
         recorded_step_count, retry_count, duration_ms, error, provenance, log_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.runId,
      params.nlStepIndex,
      params.instruction,
      params.expected ?? null,
      params.success ? 1 : 0,
      params.assertions ? JSON.stringify(params.assertions) : null,
      params.recordedStepCount ?? 0,
      params.retryCount ?? 0,
      params.durationMs ?? null,
      params.error ?? null,
      params.provenance ? JSON.stringify(params.provenance) : null,
      params.logDetails !== undefined ? JSON.stringify(params.logDetails) : null,
    );
    return id;
  }

  getStepLogs(runId: string): AiDrivenRecordingStepLogRow[] {
    return db
      .prepare('SELECT * FROM ai_driven_recording_step_logs WHERE run_id = ? ORDER BY nl_step_index')
      .all(runId) as AiDrivenRecordingStepLogRow[];
  }

  deleteRun(id: string): void {
    // 先删除关联的 step logs（避免外键约束失败）
    db.prepare('DELETE FROM ai_driven_recording_step_logs WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM ai_driven_recording_runs WHERE id = ?').run(id);
  }

  // === Provider Config ===

  getProviderConfig(id: string): ProviderConfigRow | undefined {
    return db.prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as
      | ProviderConfigRow
      | undefined;
  }

  /**
   * 获取解密后的 providerConfig。
   * API key 在 DB 中加密存储，此处解密后返回明文（仅在 WS RESPONSE 中传输，不落盘到 Agent）。
   */
  getDecryptedProviderConfig(id: string): DecryptedProviderConfig | undefined {
    const row = this.getProviderConfig(id);
    if (!row) return undefined;
    const apiKey = decryptApiKey(row.encrypted_api_key);
    const models = row.models ? (JSON.parse(row.models) as string[]) : undefined;
    return {
      id: row.id,
      name: row.name,
      type: row.type as DecryptedProviderConfig['type'],
      endpoint: row.endpoint ?? undefined,
      apiKey,
      deployment: row.deployment ?? undefined,
      apiVersion: row.api_version ?? undefined,
      model: row.model ?? '',
      models,
    };
  }
}
