/**
 * AI-Driven Recorder Module
 *
 * 独立模块，basePath: /api/ai-driven-recorder
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §8
 */

import { Router } from 'express';
import { withErrorHandling } from '../../shared/http/async-handler.ts';
import { AiDrivenRecorderController } from './controller.ts';
import { AiDrivenRecorderRepository } from './repository.ts';
import { createAiRecorderSseGateway, registerAiRecorderWsRelay } from './ws-relay.ts';
import { recoverInterruptedRuns } from './recover.ts';

const router = Router();

// 模块单例：SSEGateway + Repository + Controller
const sseGateway = createAiRecorderSseGateway();
const repository = new AiDrivenRecorderRepository();
const controller = new AiDrivenRecorderController(sseGateway, repository);

// 注册 WS Relay（监听 globalEventBus 的 RECORDING_EVENT）
registerAiRecorderWsRelay({ sseGateway, repository });

/**
 * 启动时恢复被 WS 断线中断的 AI 录制 run（COMPLETE 事件丢失时 finalize 未执行）。
 * 复用模块单例；幂等，可安全重复调用。
 */
export function recoverInterruptedAiRecorderRuns(): ReturnType<typeof recoverInterruptedRuns> {
  return recoverInterruptedRuns({ repository, sseGateway });
}

function p(param: string | string[]): string {
  return typeof param === 'string' ? param : param[0];
}

// ============================================================
// 查询接口
// ============================================================

// 列出项目的所有 AI 录制 run
router.get('/:projectId/runs', withErrorHandling((req, res) => {
  res.json(controller.listRuns(p(req.params.projectId)));
}));

// 查询 run 状态
router.get('/:projectId/runs/:runId', withErrorHandling((req, res) => {
  const status = controller.getRun(p(req.params.projectId), p(req.params.runId));
  res.json(status);
}));

// 查询 run 的步骤日志（历史加载 / 展开详情）
router.get('/:projectId/runs/:runId/steps', withErrorHandling((req, res) => {
  const projectId = p(req.params.projectId);
  const runId = p(req.params.runId);
  const run = controller.getRun(projectId, runId); // 归属校验：不属于该项目时抛 404
  const steps = repository.getStepLogs(runId).map((row) => ({
    nlStepIndex: row.nl_step_index,
    instruction: row.instruction,
    expected: row.expected ?? undefined,
    success: row.success === 1,
    error: row.error ?? undefined,
    verificationWarning:
      row.log_details
        ? (() => { try { return (JSON.parse(row.log_details) as any).verificationWarning; } catch { return undefined; } })()
        : undefined,
    logs:
      row.log_details
        ? (() => { try { return (JSON.parse(row.log_details) as any).logs; } catch { return undefined; } })()
        : undefined,
    retryCount: row.retry_count,
    durationMs: row.duration_ms ?? undefined,
    recordedStepCount: row.recorded_step_count,
  }));
  res.json({ runId, runStatus: run.status, steps });
}));

// SSE 流
router.get('/:projectId/runs/:runId/stream', (req, res) => {
  sseGateway.attachStream(p(req.params.runId), res);
});

// ============================================================
// 操作接口
// ============================================================

// 启动 AI 录制 run
router.post('/:projectId/runs', withErrorHandling((req, res) => {
  const result = controller.startRun(p(req.params.projectId), req.body);
  res.status(201).json(result);
}));

// 中止并删除 run
router.delete('/:projectId/runs/:runId', withErrorHandling((req, res) => {
  const result = controller.deleteRun(p(req.params.projectId), p(req.params.runId));
  res.json(result);
}));

export const aiDrivenRecorderModule = { basePath: '/api/ai-driven-recorder', router };

export default router;
