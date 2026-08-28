/**
 * AI-Driven Recorder Run — 类型定义
 *
 * 参考 docs/05-AIDrivenRecordingEngine.md §8.4.3
 * 复用 ai-test-gen 的 useReducer + SSE 模式，但状态机为单线性 step 序列。
 */

export type RunStatus = 'idle' | 'running' | 'refining' | 'replaying' | 'completed' | 'failed';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'takeover';

export interface RecorderStep {
  nlStepIndex: number;
  instruction: string;
  expected?: string;
  status: StepStatus;
  retryCount: number;
  observeHint?: string;
  error?: string;
  recordedStepCount?: number;
  durationMs?: number;
  /** act 已成功但 expected 验证未通过时的非致命警告（录制语义：操作已捕获） */
  verificationWarning?: string;
  /** 每步执行时间线（act/observe/extract/verify 各阶段日志） */
  logs?: Array<{ t: number; level: string; message: string }>;
}

export interface ReplayReport {
  verdict: 'pass' | 'flaky' | 'fail';
  runs: number;
  passCount: number;
  failCount: number;
  results?: Array<{
    runIndex: number;
    passed: boolean;
    stepResults?: Array<{ stepIndex: number; passed: boolean; error?: string }>;
  }>;
}

/** 确认运行阶段（编译管线开启时，录制完成后无头回放验证 AI 断言） */
export type ConfirmPhase =
  | { phase: 'running' }
  | { phase: 'done'; completedRuns: number; confirmed: number; review: number; blockedByInfraFailure: boolean };

export interface RecorderRunState {
  runId: string | null;
  status: RunStatus;
  steps: RecorderStep[];
  suiteId: string | null;
  caseId: string | null;
  replayReport: ReplayReport | null;
  error: { message: string; stepIndex?: number } | null;
  isStarting: boolean;
  isConnected: boolean;
  nlCaseId: string | null;
  providerConfigId: string | null;
  confirmPhase?: ConfirmPhase | null;
}

export type RecorderAction =
  | { type: 'START_REQUEST'; nlCaseId: string; providerConfigId: string }
  | { type: 'START_SUCCESS'; runId: string; suiteId: string; caseId: string; steps: RecorderStep[] }
  | { type: 'START_ERROR'; error: string }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'STEP_START'; runId: string; nlStepIndex: number; instruction: string; expected?: string }
  | { type: 'STEP_OBSERVE'; runId: string; nlStepIndex: number; hint: string }
  | { type: 'STEP_COMPLETE'; runId: string; nlStepIndex: number; recordedStepCount?: number; durationMs?: number; verificationWarning?: string; logs?: Array<{ t: number; level: string; message: string }> }
  | { type: 'STEP_FAILED'; runId: string; nlStepIndex: number; error: string; retryCount?: number; logs?: Array<{ t: number; level: string; message: string }> }
  | { type: 'STEP_TAKEOVER'; runId: string; nlStepIndex: number; reason?: string }
  | { type: 'CONFIRM_START'; runId: string }
  | { type: 'CONFIRM_COMPLETE'; runId: string; completedRuns: number; confirmed: number; review: number; blockedByInfraFailure: boolean }
  | { type: 'RUN_COMPLETE'; runId: string; suiteId: string; caseId: string; replayReport?: ReplayReport }
  | { type: 'RUN_ERROR'; runId: string; error: string }
  | { type: 'RECORDER_FALLBACK'; runId: string; reason: string }
  | { type: 'ABORT_REQUEST' }
  | { type: 'ABORT_SUCCESS' }
  | { type: 'LOAD_RUN'; runId: string; state: Partial<RecorderRunState> }
  | { type: 'RESET' };

export interface StartConfig {
  nlCaseId: string;
  providerConfigId: string;
  model?: string;
  /** 执行位置：Agent 进程（默认）或服务端本机。仅显式选择，无自动回退 */
  executionMode?: 'agent' | 'local';
  /** 显式起始 URL 覆盖；缺省时由后端从用例 preconditions/testData 解析 */
  startUrl?: string;
  options?: {
    headless?: boolean;
    maxRetriesPerStep?: number;
    timeoutPerStep?: number;
    /** 编译管线（docs/07）：规则+AI 编译断言；确认回放由 Server 端在会话结束后执行 */
    enableCompilePipeline?: boolean;
  };
}

export interface AiRecorderApiAdapter {
  runs: (projectId: string) => Promise<any[]>;
  getRun: (projectId: string, runId: string) => Promise<any>;
  steps: (projectId: string, runId: string) => Promise<{ runId: string; runStatus: string; steps: any[] }>;
  start: (projectId: string, config: StartConfig) => Promise<{ runId: string; suiteId: string; caseId: string; status: string }>;
  delete: (projectId: string, runId: string) => Promise<any>;
  streamUrl: (projectId: string, runId: string) => string;
}

export function createInitialState(): RecorderRunState {
  return {
    runId: null,
    status: 'idle',
    steps: [],
    suiteId: null,
    caseId: null,
    replayReport: null,
    error: null,
    isStarting: false,
    isConnected: false,
    nlCaseId: null,
    providerConfigId: null,
  };
}
