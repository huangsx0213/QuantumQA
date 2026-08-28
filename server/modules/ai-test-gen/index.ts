import { Router } from 'express';
import { withErrorHandling } from '../../shared/http/async-handler.ts';
import type { TestGenController } from './controller.ts';
import { createHtmlKnowledgeRouter } from './html-knowledge/router.ts';
import { HtmlKnowledgeService } from './html-knowledge/service.ts';
import { testGenController } from './runtime.ts';
import { startPipelineSchema, resumePipelineSchema, checkpointUpdateSchema } from './schema.ts';

const router = Router();
const controller = testGenController;
const htmlKnowledgeService = new HtmlKnowledgeService();

function p(param: string | string[]): string {
  return typeof param === 'string' ? param : param[0];
}

export function createResumeRunHandler(
  resumeController: Pick<TestGenController, 'resumeRun'>,
) {
  return withErrorHandling((req, res) => {
    const result = resumeController.resumeRun(p(req.params.runId), req.body);
    res.json(result);
  });
}

export function createStartPipelineHandler(
  startController: Pick<TestGenController, 'startPipeline'>,
) {
  return withErrorHandling(async (req, res) => {
    const result = await startController.startPipeline(p(req.params.projectId), req.body);
    res.status(result.created ? 201 : 200).json(result);
  });
}

// ============================================================
// 查询接口
// ============================================================

// 运行历史列表
router.get('/runs/:projectId', withErrorHandling((req, res) => {
  res.json(controller.listRuns(p(req.params.projectId)));
}));

// 检查活跃运行
router.get('/active/:projectId', withErrorHandling((req, res) => {
  res.json(controller.getActiveRun(p(req.params.projectId)));
}));

router.use(
  '/:projectId/html-knowledge-sets',
  createHtmlKnowledgeRouter(htmlKnowledgeService),
);

// 运行详情
router.get('/:runId', withErrorHandling((req, res) => {
  const run = controller.getRun(p(req.params.runId));
  if (!run) { res.status(404).json({ error: 'Test gen run not found' }); return; }
  res.json(run);
}));

// 运行信息
router.get('/:runId/info', withErrorHandling((req, res) => {
  const info = controller.getRunInfo(p(req.params.runId));
  if (!info) { res.status(404).json({ error: 'Test gen run not found' }); return; }
  res.json(info);
}));

// agent 日志
router.get('/:runId/logs', withErrorHandling((req, res) => {
  const { agent } = req.query;
  res.json(controller.getLogs(p(req.params.runId), agent as string | undefined));
}));

// 思考数据（持久化）
router.get('/:runId/thinking', withErrorHandling((req, res) => {
  const data = controller.getThinkingData(p(req.params.runId));
  res.json(data ?? null);
}));

// 审核日志
router.get('/:runId/audit', withErrorHandling((req, res) => {
  const checkpointId = req.query.checkpointId as string | undefined;
  res.json(controller.getAuditLogs(p(req.params.runId), checkpointId));
}));

// checkpoint 数据
router.get('/:runId/checkpoint', withErrorHandling(async (req, res) => {
  const state = await controller.getCheckpointState(p(req.params.runId));
  res.json(state ?? null);
}));

// checkpoint 状态
router.get('/:runId/checkpoint-state', withErrorHandling(async (req, res) => {
  const state = await controller.getCheckpointState(p(req.params.runId));
  res.json(state ?? null);
}));

// SSE 流
router.get('/:runId/stream', (req, res) => {
  controller.sseGateway.attachStream(p(req.params.runId), res);
});

// ============================================================
// 操作接口
// ============================================================

// 启动流水线
router.post('/:projectId/start', createStartPipelineHandler(controller));

// 审核通过/重试
router.post('/:runId/resume', createResumeRunHandler(controller));

// 从失败的 agent 重试
router.post('/:runId/retry', withErrorHandling(async (req, res) => {
  const result = await controller.retryRun(p(req.params.runId));
  res.json(result);
}));

// 中止
router.post('/:runId/abort', withErrorHandling((req, res) => {
  const result = controller.abortRun(p(req.params.runId));
  res.json(result);
}));

// 保存 checkpoint 编辑
router.post('/:runId/checkpoint-update', withErrorHandling(async (req, res) => {
  const result = await controller.saveCheckpointEdits(p(req.params.runId), req.body);
  res.json(result);
}));

// 保存用例到项目
router.post('/:runId/save-cases', withErrorHandling((req, res) => {
  const result = controller.saveCases(p(req.params.runId));
  res.json(result);
}));

// 删除
router.delete('/:runId', withErrorHandling(async (req, res) => {
  const result = await controller.deleteRun(p(req.params.runId));
  res.json(result);
}));

// ============================================================
// Prompt Overrides
// ============================================================

// 获取项目的所有 prompt overrides
router.get('/prompts/:projectId', withErrorHandling((req, res) => {
  res.json(controller.getPromptOverrides(p(req.params.projectId)));
}));

// 保存 prompt override
router.put('/prompts/:projectId/:agentName', withErrorHandling((req, res) => {
  const { customPrompt, modelOverride } = req.body;
  res.json(controller.upsertPromptOverride(p(req.params.projectId), p(req.params.agentName), customPrompt ?? null, modelOverride ?? null));
}));

// 删除 prompt override
router.delete('/prompts/:projectId/:agentName', withErrorHandling((req, res) => {
  res.json(controller.deletePromptOverride(p(req.params.projectId), p(req.params.agentName)));
}));

// ============================================================
// Default Prompts (read-only reference)
// ============================================================

// 获取指定 agent 的默认 prompt
router.get('/prompts/:projectId/default/:agentName', withErrorHandling((req, res) => {
  const agentName = p(req.params.agentName);
  const validAgents = ['test_analyst', 'test_designer', 'quality_manager'];
  if (!validAgents.includes(agentName)) {
    res.status(400).json({ error: 'Invalid agent name' });
    return;
  }
  const prompt = controller.getDefaultPrompt(agentName);
  res.json({ agentName, prompt });
}));

// 获取最近一次成功运行的 agent prompts
router.get('/prompts/:projectId/latest', withErrorHandling((req, res) => {
  const logs = controller.getLatestRunLogs(p(req.params.projectId));
  res.json(logs ?? []);
}));

export const recoverInterruptedTestGenRuns = () => controller.recoverInterruptedRuns();

export const aiTestGenModule = { basePath: '/api/test-gen', router };

export default router;
