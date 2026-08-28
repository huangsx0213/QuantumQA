/**
 * Confirmation Service — 编译期确认运行（转化管线阶段 D，docs/07 §4-D）
 *
 * 录制会话结束（浏览器已关闭）后，由 Server 用**生产执行引擎**
 * （execution/runner 的完整 case 管线）对 Draft Suite 无头回放 ≤2 次：
 *   - 每次全新浏览器上下文，无录制残留状态（cookie/Stagehand 连接）
 *   - 报告照常落库 → 用户可在 Runs/Reports 界面看到确认运行过程
 *   - 断言以 soft 临时策略执行，逐条收割结构化结果（ui-executor metadata）
 *   - 判定矩阵：两次 PASS → ai-confirmed；否则 needs-review
 *
 * 判定完成后调用 emitAssertions 三态落库并广播 confirm:complete。
 * 管线模式下 run:complete 由本服务在确认结束后透传发出——
 * 终态事件会关闭 SSE 流，必须保证 confirm:complete 先行到达前端。
 */

import { Log } from '../../shared/services/logger';
import type { SSEGateway } from '../ai-test-gen/sse-gateway.ts';
import { startExecutionAndWait } from '../execution/runner.ts';
import { defaultDataLoader } from '../execution/default-data-loader.ts';
import { saveSuite } from '../suites/repository.ts';
import { listEnvironments } from '../environments/repository.ts';
import type { TestStep, TestSuite, ExecutionRequest } from '../../../shared/contracts/index.ts';
import {
  emitAssertions,
  harvestAssertionResults,
  decideConfirmationVerdict,
  type ConfirmationReportLike,
  type HarvestedAssertionRun,
  type ReviewAssertionRecord,
} from '../../../agent/recorder/refiner.ts';

const CONFIRM_RUNS = 2;
const MAX_ENGINE_RUNS = CONFIRM_RUNS + 1; // 预留一次基础设施重试

export interface ConfirmationDeps {
  sseGateway: SSEGateway;
  /** 测试注入用：默认 defaultDataLoader */
  loader?: { getSuite(id: string): TestSuite | undefined };
  /** 测试注入用：默认 saveSuite */
  saveSuiteFn?: (suite: TestSuite) => void;
  /** 测试注入用：默认取环境列表首个 */
  listEnvs?: () => string[];
}

/** 引擎注入点（测试用）；生产默认走完整生产管线 */
export type ConfirmEngine = (
  request: ExecutionRequest,
) => Promise<{
  result: { status: string };
  logs: Array<{ status?: string; level?: string; message?: string; metadata?: Record<string, unknown> }>;
}>;

/**
 * 确认运行触发条件：存在任何断言（rule 或 ai）即触发。
 * 目的不只是验证断言——而是预演"该用例在全新回放环境能否跑通"
 * （选择器可解析、步骤可重演），rule 断言的选择器可靠性也被真机验证。
 * 纯无断言的 suite（只有 goto）才跳过。
 */
function hasAnyAssertions(steps: TestStep[]): boolean {
  return steps.some((s) => (s.assertions?.length ?? 0) > 0);
}

/** 临时 soft 化：确认回放中断言失败不得中止用例（收割全部证据后再恢复） */
function withSoftAssertions(suite: TestSuite): TestSuite {
  return {
    ...suite,
    cases: suite.cases.map((c) => ({
      ...c,
      steps: (c.steps ?? []).map((s) =>
        s.assertions?.length ? { ...s, failureStrategy: 'soft' as const } : s,
      ),
    })),
  };
}

function summarize(
  report: ConfirmationReportLike,
): { confirmedAssertionIds: string[]; reviewAssertionIds: string[]; blockedByInfraFailure: boolean; completedRuns: number } {
  const confirmedAssertionIds: string[] = [];
  const reviewAssertionIds: string[] = [];
  for (const entry of report.entries) {
    if (!report.infraFailureRuns && decideConfirmationVerdict(entry.runs) === 'ai-confirmed') {
      confirmedAssertionIds.push(entry.assertionId);
    } else {
      reviewAssertionIds.push(entry.assertionId);
    }
  }
  return { confirmedAssertionIds, reviewAssertionIds, blockedByInfraFailure: report.infraFailureRuns > 0, completedRuns: 0 };
}

export async function confirmDraftSuite(
  deps: ConfirmationDeps,
  params: {
    runId: string;
    projectId: string;
    suiteId: string;
    caseId: string;
    environment?: string;
    runs?: number;
    engine?: ConfirmEngine;
    /**
     * 终态透传：管线模式下 run:complete 由本服务在确认结束后发出
     * （保证 confirm:complete → run:complete 顺序，SSE 流存活期间前端都能收到）。
     */
    runComplete?: Record<string, unknown>;
  },
): Promise<void> {
  const { sseGateway } = deps;
  const loader = deps.loader ?? defaultDataLoader;
  const persistSuite = deps.saveSuiteFn ?? saveSuite;
  const envs = deps.listEnvs ?? listEnvironments;
  const finishUp = () => {
    if (params.runComplete) {
      sseGateway.emit(params.runId, 'run:complete', params.runComplete);
    }
  };
  const engine = params.engine ?? (startExecutionAndWait as unknown as ConfirmEngine);

  try {
    const suite = loader.getSuite(params.suiteId);
    if (!suite) {
      Log.for('confirm').warn(`Draft suite not found for confirmation: ${params.suiteId}`);
      finishUp();
      return;
    }
    const allSteps = suite.cases.flatMap((c) => c.steps ?? []);
    if (!hasAnyAssertions(allSteps)) {
      // 纯无断言 suite（只有 goto）：跳过回放，仍须发出终态（管线模式下 run:complete 由本服务负责）
      const stamped = { ...suite, cases: suite.cases.map((c) => ({ ...c, steps: emitAssertions(c.steps ?? [], null) })) };
      persistSuite(stamped);
      finishUp();
      return;
    }

    const environment = params.environment || envs()[0] || 'DEFAULT';
    sseGateway.emit(params.runId, 'confirm:start', { runId: params.runId });
    Log.for('confirm').info(`confirmation started: suite=${params.suiteId} env=${environment}`);

    // 以 soft 版本落库供引擎执行；最终三态写回时用原始步骤恢复策略
    persistSuite(withSoftAssertions(suite));

    const targetRuns = Math.max(1, Math.min(params.runs ?? CONFIRM_RUNS, 3));
    const perAssertion = new Map<string, HarvestedAssertionRun[]>();
    let completedRuns = 0;
    let infraFailureRuns = 0;

    for (let attempt = 1; attempt <= MAX_ENGINE_RUNS && completedRuns < targetRuns; attempt++) {
      try {
        const { result, logs } = await engine({
          type: 'case',
          projectId: params.projectId,
          environment,
          suiteId: params.suiteId,
          caseId: params.caseId,
        });
        // 动作失败会导致 FAILED（soft 下断言不抛）——该轮视为无效运行
        if (result.status !== 'COMPLETED') {
          infraFailureRuns++;
          Log.for('confirm').warn(`run ${attempt} invalid: status=${result.status}`);
          continue;
        }
        for (const [id, runs] of harvestAssertionResults(logs)) {
          if (!perAssertion.has(id)) perAssertion.set(id, []);
          perAssertion.get(id)!.push(...runs);
        }
        completedRuns++;
      } catch (err: any) {
        infraFailureRuns++;
        Log.for('confirm').warn(`run ${attempt} threw: ${err?.message?.slice(0, 160)}`);
      }
    }

    const report: ConfirmationReportLike = {
      entries: [...perAssertion].map(([assertionId, runs]) => ({ assertionId, runs })),
      infraFailureRuns,
    };
    const summary = summarize(report);
    summary.completedRuns = completedRuns;

    // 三态写回：原始步骤（保留用户可见的 failureStrategy）+ 确认结论
    const finalSuite = loader.getSuite(params.suiteId);
    if (finalSuite) {
      persistSuite({
        ...finalSuite,
        cases: finalSuite.cases.map((c) => ({
          ...c,
          steps: c.id === params.caseId ? emitAssertions(c.steps ?? [], report) : c.steps ?? [],
        })),
      });
    }

    sseGateway.emit(params.runId, 'confirm:complete', { runId: params.runId, ...summary });
    Log.for('confirm').info(
      `confirmation done: runs=${completedRuns} confirmed=${summary.confirmedAssertionIds.length} review=${summary.reviewAssertionIds.length}${summary.blockedByInfraFailure ? ' (infra-failure)' : ''}`,
    );
    finishUp();
  } catch (err: any) {
    Log.for('confirm').error(`confirmation crashed: ${err?.message}`);
    // 兜底：关闭前端横幅并把全部 AI 提议送审（不误杀、不悬挂）
    try {
      const suite = loader.getSuite(params.suiteId);
      if (suite) {
        persistSuite({
          ...suite,
          cases: suite.cases.map((c) =>
            c.id === params.caseId ? { ...c, steps: emitAssertions(c.steps ?? [], { entries: [], infraFailureRuns: 1 }) } : c,
          ),
        });
      }
    } catch { /* 尽力而为 */ }
    sseGateway.emit(params.runId, 'confirm:complete', {
      runId: params.runId,
      confirmedAssertionIds: [],
      reviewAssertionIds: [],
      blockedByInfraFailure: true,
      completedRuns: 0,
    });
    finishUp();
  }
}

/** 供测试/工具检查某个步骤的审核队列记录数 */
export function countReviewAssertions(steps: TestStep[]): number {
  return steps.reduce((n, s) => n + (((s.metadata as any)?.reviewAssertions ?? []) as ReviewAssertionRecord[]).length, 0);
}
