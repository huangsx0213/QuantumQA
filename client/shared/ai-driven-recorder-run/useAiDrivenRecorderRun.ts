/**
 * AI-Driven Recorder Run — 主 Hook
 *
 * 参考 useTestGenRun + useTestGenSSE 模式：
 *   - useReducer 管理状态
 *   - fetch-based SSE 订阅驱动状态更新（与 useTestGenSSE 一致）
 */

import { useReducer, useCallback, useRef, useEffect } from 'react';
import { recorderReducer } from './ai-driven-recorder-reducer';
import {
  createInitialState,
  type RecorderRunState,
  type RecorderStep,
  type StartConfig,
  type ReplayReport,
} from './types';
import { useAiDrivenRecorderRunDeps } from './AiDrivenRecorderRunProvider';

interface UseAiDrivenRecorderRunOptions {
  /** 预选的 NlCase ID（从 NlCasesPage 跳转时传入） */
  preselectNlCaseId?: string | null;
}

export function useAiDrivenRecorderRun(
  projectId: string | null,
  _options: UseAiDrivenRecorderRunOptions = {},
) {
  const [state, dispatch] = useReducer(recorderReducer, createInitialState());
  const { api } = useAiDrivenRecorderRunDeps();
  const sseControllerRef = useRef<AbortController | null>(null);
  const onEventRef = useRef<(event: { type: string; data: any }) => void>(() => {});

  // SSE 事件 → dispatch 映射
  const handleSSEEvent = useCallback((event: { type: string; data: any }) => {
    const { type, data } = event;
    switch (type) {
      case 'step:start':
        dispatch({ type: 'STEP_START', runId: data.runId, nlStepIndex: data.nlStepIndex, instruction: data.instruction, expected: data.expected });
        break;
      case 'step:observe':
        dispatch({ type: 'STEP_OBSERVE', runId: data.runId, nlStepIndex: data.nlStepIndex, hint: data.hint });
        break;
      case 'step:complete':
        dispatch({ type: 'STEP_COMPLETE', runId: data.runId, nlStepIndex: data.nlStepIndex, recordedStepCount: data.recordedStepCount, durationMs: data.durationMs, verificationWarning: data.verificationWarning, logs: data.logs });
        break;
      case 'step:failed':
        dispatch({ type: 'STEP_FAILED', runId: data.runId, nlStepIndex: data.nlStepIndex, error: data.error ?? data.reason, retryCount: data.retryCount, logs: data.logs });
        break;
      case 'step:takeover':
        dispatch({ type: 'STEP_TAKEOVER', runId: data.runId, nlStepIndex: data.nlStepIndex, reason: data.reason });
        break;
      case 'confirm:start':
        dispatch({ type: 'CONFIRM_START', runId: data.runId });
        break;
      case 'confirm:complete':
        dispatch({
          type: 'CONFIRM_COMPLETE',
          runId: data.runId,
          completedRuns: data.completedRuns ?? 0,
          confirmed: data.confirmedAssertionIds?.length ?? 0,
          review: data.reviewAssertionIds?.length ?? 0,
          blockedByInfraFailure: !!data.blockedByInfraFailure,
        });
        break;
      case 'run:complete':
        dispatch({ type: 'RUN_COMPLETE', runId: data.runId, suiteId: data.suiteId, caseId: data.caseId, replayReport: data.replayReport });
        break;
      case 'run:error':
        dispatch({ type: 'RUN_ERROR', runId: data.runId, error: data.error });
        break;
      case 'recorder:fallback':
        dispatch({ type: 'RECORDER_FALLBACK', runId: data.runId, reason: data.reason });
        break;
      default:
        break;
    }
  }, []);

  onEventRef.current = handleSSEEvent;

  // SSE 连接（参考 useTestGenSSE 的 fetch-based 实现）
  const connectSSE = useCallback((runId: string) => {
    if (!projectId) return;
    sseControllerRef.current?.abort();
    const controller = new AbortController();
    sseControllerRef.current = controller;

    const url = api.streamUrl(projectId, runId);
    dispatch({ type: 'SET_CONNECTED', connected: false });

    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          dispatch({ type: 'RUN_ERROR', runId, error: err.error || 'SSE connection failed' });
          return;
        }
        dispatch({ type: 'SET_CONNECTED', connected: true });

        const reader = response.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          let currentEvent = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                onEventRef.current({ type: currentEvent, data });
              } catch {
                // skip malformed JSON
              }
              currentEvent = '';
            }
          }
        }
        dispatch({ type: 'SET_CONNECTED', connected: false });
      })
      .catch((err: any) => {
        if (err.name !== 'AbortError') {
          dispatch({ type: 'RUN_ERROR', runId, error: err.message });
        }
        dispatch({ type: 'SET_CONNECTED', connected: false });
      });
  }, [projectId, api]);

  const start = useCallback(
    async (config: StartConfig, nlCaseSteps?: Array<{ sequence: number; action: string; expected?: string }>) => {
      if (!projectId) return;
      dispatch({ type: 'START_REQUEST', nlCaseId: config.nlCaseId, providerConfigId: config.providerConfigId });

      try {
        const result = await api.start(projectId, config);

        // nlStepIndex 必须与 Agent 事件一致（0-based 数组下标）。
        // 之前误用 1-based 的 sequence，导致 SSE 事件整体错位一格：
        // 第一条状态被丢弃、后续卡片指令被覆盖、最后一条永远 PENDING。
        const steps: RecorderStep[] = (nlCaseSteps ?? []).map((s, i) => ({
          nlStepIndex: i,
          instruction: s.action,
          expected: s.expected,
          status: 'pending' as const,
          retryCount: 0,
        }));

        dispatch({
          type: 'START_SUCCESS',
          runId: result.runId,
          suiteId: result.suiteId,
          caseId: result.caseId,
          steps,
        });

        connectSSE(result.runId);
      } catch (err: any) {
        dispatch({ type: 'START_ERROR', error: err?.message || 'Failed to start AI recording' });
        throw err;
      }
    },
    [projectId, api, connectSSE],
  );

  const abort = useCallback(async () => {
    if (!projectId || !state.runId) return;
    dispatch({ type: 'ABORT_REQUEST' });
    try {
      await api.delete(projectId, state.runId);
    } catch {
      // best effort
    }
    sseControllerRef.current?.abort();
    sseControllerRef.current = null;
    dispatch({ type: 'ABORT_SUCCESS' });
  }, [projectId, state.runId, api]);

  const reset = useCallback(() => {
    sseControllerRef.current?.abort();
    sseControllerRef.current = null;
    dispatch({ type: 'RESET' });
  }, []);

  const loadRun = useCallback(
    async (runId: string) => {
      if (!projectId) return;
      try {
        const run = await api.getRun(projectId, runId);
        const replayReport: ReplayReport | undefined = run.replayReport;

        // 从服务端步骤日志重建步骤列表（含每步时间线与验证警告）
        let steps: RecorderStep[] = [];
        try {
          const stepData = await api.steps(projectId, runId);
          steps = (stepData.steps ?? []).map((s: any) => ({
            nlStepIndex: s.nlStepIndex,
            instruction: s.instruction ?? '',
            expected: s.expected,
            status: (s.success ? 'completed' : 'failed') as RecorderStep['status'],
            retryCount: s.retryCount ?? 0,
            error: s.error,
            verificationWarning: s.verificationWarning,
            logs: s.logs,
            durationMs: s.durationMs,
            recordedStepCount: s.recordedStepCount,
          }));
        } catch {
          // 步骤日志拉取失败不阻断 run 元数据加载
        }

        dispatch({
          type: 'LOAD_RUN',
          runId,
          state: {
            runId,
            status: run.status,
            steps,
            suiteId: run.result?.suiteId ?? null,
            caseId: run.result?.caseId ?? null,
            replayReport: replayReport ?? null,
            nlCaseId: run.nlCaseId,
            error: run.error ? { message: run.error } : null,
          },
        });

        // 仍在进行中的 run：重新订阅 SSE 继续跟踪
        if (run.status === 'running' || run.status === 'refining' || run.status === 'replaying') {
          connectSSE(runId);
        }
      } catch {
        // best effort
      }
    },
    [projectId, api, connectSSE],
  );

  // 清理
  useEffect(() => {
    return () => {
      sseControllerRef.current?.abort();
      sseControllerRef.current = null;
    };
  }, []);

  const isRunning = state.status === 'running' || state.status === 'refining' || state.status === 'replaying';

  return {
    state,
    isRunning,
    start,
    abort,
    reset,
    loadRun,
  };
}
