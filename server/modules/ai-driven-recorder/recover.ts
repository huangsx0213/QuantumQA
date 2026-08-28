/**
 * Recover — AI 录制中断恢复
 *
 * COMPLETE 事件经 WS 从 Agent 传给 Server 触发 finalizeRunCompletion。
 * 若 WS 在录制完成后、COMPLETE 发出前断线（server 重启 / 网络抖动），
 * 最终产物（带编译断言的 refined steps）丢失，run 卡在 running/refining。
 *
 * 本模块在 Server 启动时扫描这类"疑似中断"的 run：
 *   - 若其预分配 draft suite/case 已录到 live steps（录制中实时插入 case_steps），
 *     用 live steps 重建 suite 触发 finalize 收尾——用户拿到一个可运行的草稿，
 *     而非什么都没留下。
 *   - 无 draft suite/case 或 case_steps 为空的 run 直接标记 failed。
 *
 * 与 test-gen 的 "No interrupted test gen runs to recover" 对齐的恢复语义。
 */

import { Log } from '../../shared/services/logger';
import { db } from '../../shared/db/client.ts';
import type { SSEGateway } from '../ai-test-gen/sse-gateway.ts';
import type { AiDrivenRecorderRepository } from './repository.ts';
import { finalizeRunCompletion } from './finalize-run.ts';
import type { TestStep, StepAssertion } from '../../../shared/contracts/index.ts';

const STALE_AFTER_MINUTES = 10;

export interface RecoverDeps {
  repository: AiDrivenRecorderRepository;
  sseGateway: SSEGateway;
  /** 测试注入：读取 case_steps live 步骤；默认查 db */
  listLiveSteps?: (caseId: string) => CaseStepRow[];
  /** 测试注入：finalize 收尾；默认 finalizeRunCompletion */
  finalize?: (
    deps: { repository: AiDrivenRecorderRepository; sseGateway: SSEGateway },
    params: { runId: string; suiteId: string; caseId: string; refinedSteps: TestStep[] },
  ) => unknown;
}

interface CaseStepRow {
  id: string;
  action: string;
  target: string | null;
  data: string | null;
  description: string | null;
  enabled: number | null;
  metadata: string | null;
  wait_for_network: string | null;
  assertions: string | null;
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return undefined; }
}

/** 把 case_steps 行还原为 TestStep（与 recording/service.ts 的落库格式保持一致） */
function rowToTestStep(row: CaseStepRow): TestStep {
  const meta = row.metadata ? safeParse(row.metadata) : {};
  const waitForNetwork = row.wait_for_network ? safeParse(row.wait_for_network) : undefined;
  const assertions = row.assertions ? safeParse(row.assertions) : undefined;
  return {
    id: row.id,
    action: row.action,
    target: row.target || undefined,
    data: row.data || undefined,
    description: row.description || undefined,
    enabled: row.enabled === 0 ? false : true,
    metadata: { ...(meta && typeof meta === 'object' ? meta as Record<string, unknown> : {}) },
    ...(waitForNetwork ? { waitForNetwork: waitForNetwork as TestStep['waitForNetwork'] } : {}),
    ...(assertions ? { assertions: assertions as StepAssertion[] } : {}),
  };
}

function defaultListLiveSteps(caseId: string): CaseStepRow[] {
  return db
    .prepare(
      `SELECT id, action, target, data, description, enabled, metadata, wait_for_network, assertions
       FROM case_steps WHERE case_id = ? ORDER BY position`,
    )
    .all(caseId) as CaseStepRow[];
}

/**
 * Server 启动时调用：扫描中断 run 并尝试恢复。
 * 返回恢复的 run 数；幂等（completed/failed 的不会被选中）。
 */
export function recoverInterruptedRuns(deps: RecoverDeps): number {
  const { repository, sseGateway } = deps;
  const listSteps = deps.listLiveSteps ?? defaultListLiveSteps;
  const finalize = deps.finalize ?? finalizeRunCompletion;
  const stale = repository.listStaleActiveRuns(STALE_AFTER_MINUTES);
  let recovered = 0;

  for (const run of stale) {
    // 只有预分配了 suite/case 的 run 才可能已有 live steps 可恢复
    if (!run.result_suite_id || !run.result_case_id) {
      Log.for('recover').warn(`run ${run.id} stale but no draft suite/case allocated — marking failed`);
      repository.updateRunStatus(run.id, 'failed', 'Recording interrupted (connection lost, no steps to recover)');
      continue;
    }

    // 从 case_steps 读取 live steps（录制中的实时产物）
    const rows = listSteps(run.result_case_id);
    if (rows.length === 0) {
      Log.for('recover').warn(`run ${run.id} stale with empty case_steps — marking failed`);
      repository.updateRunStatus(run.id, 'failed', 'Recording interrupted (connection lost, no steps recorded)');
      continue;
    }

    const steps = rows.map(rowToTestStep);
    Log.for('recover').info(`recovering run ${run.id}: ${steps.length} live steps from ${run.result_case_id}`);

    try {
      finalize(
        { repository, sseGateway },
        {
          runId: run.id,
          suiteId: run.result_suite_id,
          caseId: run.result_case_id,
          refinedSteps: steps,
        },
      );
      recovered++;
    } catch (err: any) {
      Log.for('recover').error(`finalize failed for run ${run.id}: ${err?.message}`);
    }
  }

  if (stale.length > 0) {
    Log.for('recover').info(`recovery finished: ${recovered}/${stale.length} interrupted runs finalized`);
  }
  return recovered;
}