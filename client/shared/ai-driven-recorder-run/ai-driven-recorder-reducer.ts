/**
 * AI-Driven Recorder Run — Reducer
 *
 * 纯函数状态机，处理 SSE 事件和 API 调用结果。
 */

import {
  type RecorderRunState,
  type RecorderAction,
  type RecorderStep,
  createInitialState,
} from './types';

function updateStep(
  steps: RecorderStep[],
  nlStepIndex: number,
  patch: Partial<RecorderStep>,
): RecorderStep[] {
  return steps.map((s) =>
    s.nlStepIndex === nlStepIndex ? patchDefined(s, patch) : s,
  );
}

/** 仅合并已定义字段，避免事件缺字段时把已播种的值清成 undefined */
function patchDefined<T extends object>(target: T, patch: Partial<T>): T {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  return { ...target, ...defined };
}

export function recorderReducer(
  state: RecorderRunState,
  action: RecorderAction,
): RecorderRunState {
  switch (action.type) {
    case 'START_REQUEST':
      return {
        ...createInitialState(),
        isStarting: true,
        nlCaseId: action.nlCaseId,
        providerConfigId: action.providerConfigId,
      };

    case 'START_SUCCESS':
      return {
        ...state,
        isStarting: false,
        runId: action.runId,
        suiteId: action.suiteId,
        caseId: action.caseId,
        status: 'running',
        steps: action.steps,
        error: null,
      };

    case 'START_ERROR':
      return {
        ...state,
        isStarting: false,
        status: 'failed',
        error: { message: action.error },
      };

    case 'SET_CONNECTED':
      return { ...state, isConnected: action.connected };

    case 'STEP_START':
      return {
        ...state,
        steps: updateStep(state.steps, action.nlStepIndex, {
          status: 'running',
          instruction: action.instruction,
          expected: action.expected,
        }),
      };

    case 'STEP_OBSERVE':
      return {
        ...state,
        steps: updateStep(state.steps, action.nlStepIndex, {
          observeHint: action.hint,
        }),
      };

    case 'STEP_COMPLETE':
      return {
        ...state,
        steps: updateStep(state.steps, action.nlStepIndex, {
          status: 'completed',
          recordedStepCount: action.recordedStepCount,
          durationMs: action.durationMs,
          verificationWarning: action.verificationWarning,
          logs: action.logs,
        }),
      };

    case 'STEP_FAILED':
      return {
        ...state,
        steps: updateStep(state.steps, action.nlStepIndex, {
          status: 'failed',
          error: action.error,
          retryCount: action.retryCount ?? 0,
          logs: action.logs,
        }),
      };

    case 'STEP_TAKEOVER':
      return {
        ...state,
        steps: updateStep(state.steps, action.nlStepIndex, {
          status: 'takeover',
        }),
      };

    case 'CONFIRM_START':
      return {
        ...state,
        confirmPhase: { phase: 'running' },
      };

    case 'CONFIRM_COMPLETE':
      return {
        ...state,
        confirmPhase: {
          phase: 'done',
          completedRuns: action.completedRuns,
          confirmed: action.confirmed,
          review: action.review,
          blockedByInfraFailure: action.blockedByInfraFailure,
        },
      };

    case 'RUN_COMPLETE':
      return {
        ...state,
        status: 'completed',
        suiteId: action.suiteId,
        caseId: action.caseId,
        replayReport: action.replayReport ?? null,
        isConnected: false,
      };

    case 'RUN_ERROR':
      return {
        ...state,
        status: 'failed',
        error: { message: action.error },
        isConnected: false,
      };

    case 'RECORDER_FALLBACK':
      // 降级为人工录制，不改变 step 状态但记录原因
      return {
        ...state,
        error: { message: `Recorder fallback: ${action.reason}` },
      };

    case 'ABORT_REQUEST':
      return { ...state, status: 'idle' };

    case 'ABORT_SUCCESS':
      return {
        ...createInitialState(),
        nlCaseId: state.nlCaseId,
        providerConfigId: state.providerConfigId,
      };

    case 'LOAD_RUN':
      return { ...state, ...action.state };

    case 'RESET':
      return createInitialState();

    default:
      return state;
  }
}
