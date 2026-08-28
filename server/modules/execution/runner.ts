import { Log } from '../../shared/services/logger';
import type {
  TestSuite,
  ExecutionRequest,
  DynamicVariable,
  RunResult,
} from '../../shared/contracts/index.ts';
import { ExecutionContext } from './context.ts';
import { interpolate } from '../../shared/utils/interpolate.ts';
import { executeApiStep } from './api-executor.ts';
import { ExecutionLogger } from './logger.ts';
import { db } from '../../shared/db/client.ts';
import { randomId } from '../../shared/utils/index.ts';
import { UIExecutor } from './ui-executor.ts';
import { executeSingleCase, executeSuite, executeScenario, executePlan, type ExecutorDeps } from '../../shared/core/executor.ts';
import type { TaskPayload, IVariableContext } from '../../shared/contracts/index.ts';
import { getActiveRunLogger, setActiveRunLogger, removeActiveRunLogger, isRunActive, registerRun, unregisterRun } from './run-registry.ts';
import type { ExecutionDataLoader } from './data-loader.ts';
import { defaultDataLoader } from './default-data-loader.ts';

// ─── Main Entry Point ───

export async function startExecution(request: ExecutionRequest): Promise<{ reportId: string; runId: string }> {
  const isLocal = !request.agentId;
  if (isLocal && isRunActive()) {
    throw new Error('A local execution is already running. Please wait for it to finish or abort it.');
  }

  const runId = randomId('ai-pl');
  const reportId = randomId('report');
  const abortController = new AbortController();

  // Create execution_run record
  db.prepare(`
    INSERT INTO execution_runs (id, report_id, type, project_id, environment, suite_id, case_id, scenario_id, plan_id, status, started_at, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)
  `).run(
    runId,
    reportId,
    request.type,
    request.projectId,
    request.environment,
    request.suiteId || null,
    request.caseId || null,
    request.scenarioId || null,
    request.planId || null,
    Date.now(),
    request.agentId || null
  );

  const logger = new ExecutionLogger(reportId);
  setActiveRunLogger(reportId, logger);
  registerRun(runId, { id: runId, abortController, isLocal });

  // Run asynchronously — don't block the HTTP response
  executeRunAsync(request, runId, reportId, logger, abortController.signal).catch(() => {
    // Errors are handled inside executeRunAsync
  });

  return { reportId, runId };
}

/**
 * 同步等待版用例执行（编译期确认运行专用，docs/07 阶段 D）。
 *
 * 与 startExecution 相同的完整生产管线（buildPayload → executeSingleCase →
 * finalizeRun 落报告），但阻塞至运行结束并返回结构化日志——
 * 确认服务据此收割逐断言结果。每次调用创建全新 UIExecutor（独立浏览器，
 * 无录制会话残留状态）。本地并发互斥沿用 isRunActive 守卫。
 */
export async function startExecutionAndWait(
  request: ExecutionRequest,
): Promise<{ result: RunResult; logs: Array<{ stepId: string; status: string; level?: string; message: string; metadata?: Record<string, unknown> }> }> {
  const runId = randomId('ai-pl');
  const reportId = randomId('report');
  const abortController = new AbortController();

  db.prepare(`
    INSERT INTO execution_runs (id, report_id, type, project_id, environment, suite_id, case_id, scenario_id, plan_id, status, started_at, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)
  `).run(
    runId,
    reportId,
    request.type,
    request.projectId,
    request.environment,
    request.suiteId || null,
    request.caseId || null,
    request.scenarioId || null,
    request.planId || null,
    Date.now(),
    request.agentId || null,
  );

  const logger = new ExecutionLogger(reportId);
  setActiveRunLogger(reportId, logger);
  registerRun(runId, { id: runId, abortController, isLocal: true });

  const uiExecutor = new UIExecutor();
  const startTime = Date.now();
  let result: RunResult;
  let displayName = `Execution: ${request.type}`;
  try {
    const built = await buildPayload(request, runId, reportId);
    displayName = built.displayName;
    result = await dispatchExecution(request, built.payload, logger, abortController.signal, uiExecutor, runId, built.displayName);
    result.reportId = reportId;
    result.durationMs = Date.now() - startTime;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    Log.for('exec').error(`Confirmation execution failed: ${message}`);
    logger.log({ stepId: 'error', status: 'FAIL', message: `❌ Execution failed: ${message}` });
    result = { reportId, status: 'FAILED', passRate: 0, totalCases: 0, passedCases: 0, failedCases: 0, durationMs: Date.now() - startTime };
  }
  await uiExecutor.cleanup().catch(() => {});
  await finalizeRun(request, runId, reportId, logger, result, displayName, startTime, Date.now());
  return { result, logs: logger.getLogs() as any };
}

// ─── Async Execution ───

async function executeRunAsync(
  request: ExecutionRequest,
  runId: string,
  reportId: string,
  logger: ExecutionLogger,
  signal: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  let result: RunResult;
  let displayName = `Execution: ${request.type}`;
  const uiExecutor = new UIExecutor();

  try {
    const built = await buildPayload(request, runId, reportId);
    displayName = built.displayName;

    logger.log({
      stepId: 'init',
      status: 'INFO',
      message: `🚀 Starting execution: ${displayName} in environment: ${request.environment}`,
    });

    result = await dispatchExecution(request, built.payload, logger, signal, uiExecutor, runId, displayName);

    result.reportId = reportId;
    result.durationMs = Date.now() - startTime;

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isAborted = signal.aborted;
    Log.for('exec').error(`Execution failed: ${message}`);

    logger.log({
      stepId: 'error',
      status: 'FAIL',
      message: isAborted ? '⛔ Execution aborted by user' : `❌ Execution failed: ${message}`,
    });

    result = {
      reportId,
      status: isAborted ? 'ABORTED' : 'FAILED',
      passRate: 0,
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const endTime = Date.now();
  await uiExecutor.cleanup();
  await finalizeRun(request, runId, reportId, logger, result, displayName, startTime, endTime);
}

async function buildPayload(
  request: ExecutionRequest,
  runId: string,
  reportId: string,
  loader: ExecutionDataLoader = defaultDataLoader,
): Promise<{ payload: TaskPayload; displayName: string }> {
  const project = loader.getProject(request.projectId);
  if (!project) throw new Error(`Project ${request.projectId} not found`);

  const assets = {
    headers: loader.listHeaders().filter(h => h.projectId === request.projectId),
    bodies: loader.listBodies().filter(b => b.projectId === request.projectId),
    endpoints: loader.listEndpoints().filter(e => e.projectId === request.projectId),
  };

  const environmentVariables = loader.getEnvironmentVariables(request.environment);

  const dynamicVarsList = loader.findDynamicVariables(request.projectId);
  const dynamicVariables: Record<string, string> = {};
  const dynamicVariableConfigs: Record<string, DynamicVariable> = {};
  for (const v of dynamicVarsList) {
    dynamicVariableConfigs[v.name] = v;
    if (v.evaluationStrategy === 'ONCE_PER_RUN') {
      dynamicVariables[v.name] = interpolate(v.expression, dynamicVariables);
    } else {
      dynamicVariables[v.name] = v.expression;
    }
  }

  const settingsList = loader.listSettings();
  const settings = settingsList.find(s => s.currentProjectId === project.id) || settingsList[0];

  let suites: TestSuite[] = [];
  if (request.type === 'plan') {
    const plan = project.plans?.find(p => p.id === request.planId);
    const requiredSuiteIds = new Set<string>();
    plan?.scenarios?.forEach(ps => {
      const scenario = project.scenarios?.find(s => s.id === ps.scenarioId);
      scenario?.suites?.forEach(ss => requiredSuiteIds.add(ss.suiteId));
    });
    suites = loader.listSuites().filter(s => requiredSuiteIds.has(s.id));
  } else if (request.type === 'scenario') {
    const scenario = project.scenarios?.find(s => s.id === request.scenarioId);
    const requiredSuiteIds = new Set((scenario?.suites || []).map(ss => ss.suiteId));
    suites = loader.listSuites().filter(s => requiredSuiteIds.has(s.id));
  }

  let displayName = `Execution: ${request.type}`;
  if (request.type === 'case') {
    const suite = loader.getSuite(request.suiteId!);
    const testCase = suite?.cases.find(c => c.id === request.caseId);
    displayName = testCase ? testCase.name : `Case: ${request.caseId}`;
  } else if (request.type === 'suite') {
    const suite = loader.getSuite(request.suiteId!);
    displayName = suite ? suite.name : `Suite: ${request.suiteId}`;
  } else if (request.type === 'scenario') {
    const scenario = project.scenarios?.find(s => s.id === request.scenarioId);
    displayName = scenario ? scenario.name : `Scenario: ${request.scenarioId}`;
  } else if (request.type === 'plan') {
    const plan = project.plans?.find(p => p.id === request.planId);
    displayName = plan ? plan.name : `Plan: ${request.planId}`;
  }

  const targetSuite = request.suiteId ? loader.getSuite(request.suiteId) : undefined;

  const payload: TaskPayload = {
    runId,
    reportId,
    request,
    project,
    suite: targetSuite || undefined,
    suites,
    assets,
    environmentVariables,
    dynamicVariables,
    dynamicVariableConfigs,
    settings: settings as any
  };

  return { payload, displayName };
}

async function dispatchExecution(
  request: ExecutionRequest,
  payload: TaskPayload,
  logger: ExecutionLogger,
  signal: AbortSignal,
  uiExecutor: UIExecutor,
  runId: string,
  displayName: string,
  loader: ExecutionDataLoader = defaultDataLoader,
): Promise<RunResult> {
  const deps: ExecutorDeps = {
    createContext: (options) => ExecutionContext.create(options) as IVariableContext,
    executeApiStep: (step, context, assets, environment, logger, indent, onEnvVarExtracted) =>
      executeApiStep(step, context as ExecutionContext, assets, environment, logger, indent, onEnvVarExtracted),
  };

  if (request.agentId) {
    Log.for('exec').info(`Dispatching task to agent ${request.agentId}: ${displayName} (${runId})`);
    const { dispatchToAgent } = await import('../agent/dispatcher.ts');
    return await dispatchToAgent(request.agentId, payload) as any;
  }

  const onEnvVarExtracted = (name: string, value: string) => {
    const currentVars = loader.getEnvironmentVariables(request.environment);
    currentVars[name] = value;
    loader.updateEnvironmentVariables(request.environment, currentVars);
  };

  if (request.type === 'case') {
    Log.for('exec').info(`Starting case execution for: ${displayName}`);
    return executeSingleCase(payload, logger, signal, uiExecutor, deps, onEnvVarExtracted);
  }
  if (request.type === 'suite') {
    Log.for('exec').info(`Starting suite execution for: ${displayName}`);
    return executeSuite(payload, logger, signal, uiExecutor, deps, onEnvVarExtracted);
  }
  if (request.type === 'scenario') {
    Log.for('exec').info(`Starting scenario execution for: ${displayName}`);
    return executeScenario(payload, logger, signal, uiExecutor, deps, onEnvVarExtracted);
  }
  Log.for('exec').info(`Starting plan execution for: ${displayName}`);
  return executePlan(payload, logger, signal, uiExecutor, deps, onEnvVarExtracted);
}

async function finalizeRun(
  request: ExecutionRequest,
  runId: string,
  reportId: string,
  logger: ExecutionLogger,
  result: RunResult,
  displayName: string,
  startTime: number,
  endTime: number,
  loader: ExecutionDataLoader = defaultDataLoader,
): Promise<void> {

  loader.saveReport({
    id: reportId,
    suiteId: request.suiteId || request.scenarioId || request.planId || request.projectId,
    suiteName: displayName,
    environment: request.environment,
    startTime,
    endTime,
    status: result.status,
    passRate: result.passRate,
    totalCases: result.totalCases,
    passedCases: result.passedCases,
    failedCases: result.failedCases,
    logs: logger.getLogs().map(l => ({
      stepId: l.stepId,
      timestamp: l.timestamp,
      status: l.status,
      level: l.level,
      message: l.message,
      screenshot: l.screenshot,
      metadata: l.metadata,
    })),
  });
  Log.for('exec').info(`Report saved successfully: ${reportId}`);

  db.prepare(`
    UPDATE execution_runs SET status = ?, finished_at = ?, error_message = ?
    WHERE id = ?
  `).run(result.status, endTime, result.status === 'FAILED' ? 'See report logs' : null, runId);

  logger.complete(result);
  Log.for('exec').info(`Task Finished: ${displayName} (${runId}) - Status: ${result.status} | Pass Rate: ${result.passRate}% | Cases: ${result.passedCases}/${result.totalCases}`);

  removeActiveRunLogger(reportId);
  unregisterRun(runId);
}
