import { useReducer, useEffect, useCallback, useRef, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTestGenRuns, useAgentLogs } from '../hooks/useQueryHooks';
import { queryKeys } from '../hooks/queryKeys';
import { useSSEConnection } from '../sse/useSSEConnection';
import { testGenReducer, createInitialState } from './test-gen-reducer';
import { useTestGenRunDeps } from './TestGenRunProvider';
import type {
  NodeId, RunSummary, TestGenError, StartConfig,
  CheckpointAction, TestGenNode, BatchProgress,
} from './types';
import { TEST_GEN_NODE_DEFS } from './types';

export interface UseTestGenRunOptions {
  runId?: string;
  config?: {
    autoFollow?: boolean;
    autoRecover?: boolean;
    refetchLogsMs?: number;
  };
  detailPanelVisible?: boolean;
}

export interface UseTestGenRunAPI {
  runId: string | undefined;
  nodes: readonly TestGenNode[];
  isRunning: boolean;
  mode: 'auto' | 'interactive';
  batchProgress: BatchProgress | null;
  selectedNodeId: NodeId | undefined;
  selectedNode: TestGenNode | undefined;
  selectNode: (id: NodeId | null) => void;
  agentLogs: any[];
  checkpointData: any | null;
  thinkingText: import('./types').ThinkingEntry[] | null;
  runSummary: RunSummary | null;
  isPending: boolean;
  isConnected: boolean;
  error: TestGenError | null;
  dismissError: () => void;
  runs: any[];
  start: (config: StartConfig) => Promise<string>;
  resume: (action: CheckpointAction, data?: { feedback?: string; editedData?: unknown }) => Promise<void>;
  startRetry: (nodeId: NodeId) => void;
  abort: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshCheckpointData: () => Promise<void>;
  reset: () => void;
  loadRun: (runId: string) => Promise<void>;
  isStarting: boolean;
  isAborting: boolean;
  isResuming: boolean;
  autoFollowEnabled: boolean;
  setAutoFollowEnabled: (enabled: boolean) => void;
  selectedAgentLog: any | null;
  startConfig: StartConfig | null;
  modelName: string | null;
}

export function useTestGenRun(currentProjectId: string | null, options?: UseTestGenRunOptions): UseTestGenRunAPI {
  const { runId: explicitRunId, config: opts, detailPanelVisible = true } = options ?? {};
  const autoFollow = opts?.autoFollow ?? true;
  const refetchLogsMs = opts?.refetchLogsMs ?? 3000;

  const [state, dispatch] = useReducer(testGenReducer, undefined, createInitialState);
  const { api } = useTestGenRunDeps();
  const queryClient = useQueryClient();
  const autoFollowTimeoutRef = useRef<number | null>(null);
  const startRequestTokenRef = useRef(0);
  const currentProjectIdRef = useRef(currentProjectId);
  currentProjectIdRef.current = currentProjectId;

  const { data: runs = [] } = useTestGenRuns(currentProjectId ?? '');

  useEffect(() => {
    return () => {
      startRequestTokenRef.current += 1;
    };
  }, [currentProjectId]);

  const sseUrl = useMemo(() => {
    const rid = explicitRunId ?? state.runId;
    return rid && state.isRunning && detailPanelVisible ? `/api/test-gen/${rid}/stream` : null;
  }, [explicitRunId, state.runId, state.isRunning, detailPanelVisible]);

  const handleSSEEvent = useCallback((event: { type: string; data: any }) => {
    if (event.type === 'agent:thinking') {
      console.log(`[useTestGenRun] SSE agent:thinking agent=${event.data?.agentName} textLen=${(event.data?.text ?? '').length}`);
    }
    dispatch({ type: 'SSE_EVENT', event });
  }, []);

  const sse = useSSEConnection({
    url: sseUrl,
    onEvent: handleSSEEvent,
    autoConnect: state.isRunning && !!sseUrl,
  });

  useEffect(() => {
    dispatch({ type: 'SET_CONNECTED', connected: sse.isConnected });
  }, [sse.isConnected]);

  // Auto-select active node (running or waiting) when pipeline is running
  useEffect(() => {
    if (state.isRunning) {
      const active = state.nodes.find(n => n.status === 'running' || n.status === 'waiting');
      if (active && active.id !== state.selectedNodeId) {
        dispatch({ type: 'SELECT_NODE', nodeId: active.id as NodeId });
      }
    }
    else if (state.autoFollowEnabled && state.nodes.some(n => n.id === 'complete' && n.status === 'completed')) {
      if (state.selectedNodeId !== 'complete') {
        dispatch({ type: 'SELECT_NODE', nodeId: 'complete' as NodeId });
      }
    }
  }, [state.nodes, state.isRunning, state.selectedNodeId, state.autoFollowEnabled]);

  const { data: agentLogs = [] } = useAgentLogs(
    state.runId ?? '', undefined, (state.runId && state.isRunning) ? refetchLogsMs : 0,
  );

  const lastMergedLogsRef = useRef<any[]>([]);

  useEffect(() => {
    if (!state.runId || !agentLogs.length) return;
    if (state.checkpointData) return;
    if (agentLogs === lastMergedLogsRef.current) return;
    lastMergedLogsRef.current = agentLogs;
    dispatch({ type: 'MERGE_AGENT_LOGS', logs: agentLogs });
  }, [agentLogs, state.runId, state.checkpointData]);

  // Infer the actual phase for RUNNING runs from agent logs.
  // DB phase stays at 'analysis' since it's only updated at interrupt/completion.
  // For RUNNING status, checkpoint must have been passed already (otherwise status = WAITING_REVIEW),
  // so we never return review-conditions/review-draft/final-review here.
  const inferRunningPhase = useCallback((logs: any[]): string => {
    const normalize = (s: string) => (s || '').replace(/_/g, '-');
    const agentLogs = logs
      .filter((l: any) => normalize(l.agent_name) !== 'preparation')
      .sort((a: any, b: any) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0));
    if (agentLogs.length === 0) return 'analysis';
    const latest = agentLogs[0];
    const name = normalize(latest.agent_name);
    if (latest.status === 'COMPLETED') {
      if (name === 'test-analyst') return 'design';
      if (name === 'test-designer') return 'quality';
      if (name === 'quality-manager') return 'complete';
      return 'analysis';
    }
    if (name === 'test-analyst') return 'analysis';
    if (name === 'test-designer') return 'design';
    if (name === 'quality-manager') return 'quality';
    return 'analysis';
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    let logs: any[] = [];
    try {
      const runInfo = await api.get(runId);
      if (!runInfo) return;

      // For RUNNING runs, fetch logs first to infer actual phase
      // (DB phase stays at 'analysis' since it's only updated at interrupt/completion)
      if (runInfo.status === 'RUNNING') {
        logs = await api.logs(runId);
      }
      const effectivePhase = runInfo.status === 'RUNNING'
        ? inferRunningPhase(logs)
        : runInfo.phase;

      let checkpointData: any = undefined;
      if (runInfo.thread_id) {
        try {
          const cpState = await api.getCheckpointState(runId);
          checkpointData = cpState?.checkpointData ?? undefined;
        } catch {
          // checkpoint state fetch failed, continue with logs
        }
      }
      if (logs.length === 0) {
        logs = await api.logs(runId);
      }

      const completedLogs = logs.filter((l: any) => l.status === 'COMPLETED');
      const totalCases = completedLogs.reduce((sum: number, l: any) => {
        const od = l.output_data;
        if (!od) return sum;
        const finalCases = od.finalTestCases;
        const count = Array.isArray(finalCases) ? finalCases.length : 0;
        return sum + count;
      }, 0);
      const tu = runInfo.token_usage;
      const summary = {
        totalCases,
        totalTokens: tu?.total_tokens || 0,
        totalLatencyMs: logs.reduce((sum: number, l: any) => sum + (l.latency_ms ?? 0), 0),
        totalBatches: runInfo.total_batches || 0,
      };

      queryClient.setQueryData([...queryKeys.testGen.logs(runId), 'all'], logs);
      lastMergedLogsRef.current = logs;
      dispatch({
        type: 'RESTORE_RUN_COMPLETE',
        runId: runInfo.id,
        phase: effectivePhase,
        status: runInfo.status,
        mode: runInfo.mode ?? 'auto',
        totalBatches: runInfo.total_batches,
        checkpointData,
        logs,
        summary,
        modelName: runInfo.model_name,
        startConfig: runInfo.config,
      });

      // For completed/failed/waiting-review runs, load persisted thinking data
      if (runInfo.status === 'COMPLETED' || runInfo.status === 'FAILED' || runInfo.status === 'WAITING_REVIEW') {
        try {
          console.log('[useTestGenRun] Loading persisted thinking data for run', runId);
          const thinkingData = await api.getThinkingData(runId);
          console.log('[useTestGenRun] Got thinking data:', thinkingData);
          if (thinkingData) {
            // Map server nodeId keys to client nodeId keys
            const SERVER_TO_CLIENT_NODE_ID: Record<string, string> = {
              analyst: 'agent_test_analyst',
              designer: 'agent_test_designer',
              quality: 'agent_quality_manager',
              reviewer: 'agent_quality_manager',
            };
            const mapped: Record<string, any> = {};
            for (const [key, entries] of Object.entries(thinkingData)) {
              const clientKey = SERVER_TO_CLIENT_NODE_ID[key] || key;
              mapped[clientKey] = entries;
            }
            console.log('[useTestGenRun] Dispatching SET_THINKING_DATA with keys:', Object.keys(mapped));
            dispatch({ type: 'SET_THINKING_DATA', thinkingData: mapped });
          }
        } catch (err) {
          console.warn('[useTestGenRun] Failed to load thinking data:', err);
        }
      }
    } catch {
    }
  }, [api, queryClient]);

  const start = useCallback(async (config: StartConfig): Promise<string> => {
    if (!currentProjectId) throw new Error('No project selected');
    const projectId = currentProjectId;
    const requestToken = ++startRequestTokenRef.current;
    const isCurrentRequest = () => requestToken === startRequestTokenRef.current
      && currentProjectIdRef.current === projectId;
    try {
      const { runId, created } = await api.start(projectId, config);
      if (isCurrentRequest()) {
        if (created === false) {
          // Idempotent reuse: the knowledge set is already bound to an existing run,
          // so restore its persisted state instead of resetting to a fresh pipeline.
          await loadRun(runId);
        } else {
          dispatch({ type: 'RUN_STARTED', runId, config });
        }
      }
      return runId;
    } catch (err) {
      if (isCurrentRequest()) {
        dispatch({
          type: 'SET_ERROR',
          error: { code: 'START_FAILED', message: err instanceof Error ? err.message : 'Failed to start pipeline' },
        });
      }
      throw err;
    }
  }, [currentProjectId, api, loadRun]);

  const resume = useCallback(async (action: CheckpointAction, data?: { feedback?: string; editedData?: any }) => {
    if (!state.runId) throw new Error('No active run');
    await api.resume(state.runId, { action, feedback: data?.feedback, editedData: data?.editedData });
  }, [state.runId, api]);

  const abort = useCallback(async () => {
    if (!state.runId) throw new Error('No active run');
    await api.abort(state.runId);
    sse.disconnect();
    dispatch({ type: 'RUN_ABORTED' });
  }, [state.runId, api, sse]);

  const startRetry = useCallback((nodeId: NodeId) => {
    // Force SSE reconnect: previous run's pipeline:error closed the stream on the
    // server side, so the new agent:thinking events emitted during retry have no
    // listener. Reattach before dispatching so the reducer doesn't lose any events.
    sse.disconnect();
    sse.connect();
    dispatch({ type: 'RETRY_STARTED', nodeId });
  }, [sse]);

  const PHASE_TO_CP: Record<string, number> = {
    'review-conditions': 1, 'review-draft': 2, 'final-review': 3,
  };

  const refresh = useCallback(async () => {
    if (!state.runId) return;
    try {
      const runInfo = await api.get(state.runId);
      if (runInfo) {
        dispatch({
          type: 'RESTORE_RUN',
          runId: runInfo.id,
          phase: runInfo.phase,
          status: runInfo.status,
          mode: runInfo.mode ?? state.mode,
          totalBatches: runInfo.total_batches,
        });
        if (runInfo.thread_id) {
          const cpState = await api.getCheckpointState(state.runId);
          if (cpState?.checkpointData) {
            dispatch({ type: 'SET_CHECKPOINT_DATA', checkpointData: cpState.checkpointData, phase: runInfo.phase });
          }
        }
        const logs = await api.logs(state.runId);
        if (logs.length > 0) {
          dispatch({ type: 'MERGE_AGENT_LOGS', logs });
        }
        queryClient.setQueryData([...queryKeys.testGen.logs(state.runId), 'all'], logs);

        // For completed runs, set checkpoint data from fresh logs so it survives
        // the RESTORE_RUN → MERGE_AGENT_LOGS gap (race with useAgentLogs effect)
        const cpNodeId = state.selectedNodeId;
        const cpAgentName = cpNodeId ? CHECKPOINT_AGENT_MAP[cpNodeId] : undefined;
        if (!state.isRunning && cpAgentName) {
          const agentLogs = logs.filter((l: any) => l.agent_name === cpAgentName);
          if (agentLogs.length > 0) {
            const od = mergeOutputData(agentLogs);
            let cpData: Record<string, any> | null = null;
            if (cpNodeId === 'checkpoint_1') {
              cpData = { conditions: od.testConditions || [], analysis: od.analysis || od.requirementAnalysis || null };
            } else if (cpNodeId === 'checkpoint_2') {
              cpData = { cases: od.draftTestCases || [] };
            } else if (cpNodeId === 'checkpoint_3') {
              cpData = { cases: od.finalTestCases || [], matrix: od.coverageMatrix || null };
            }
            if (cpData) {
              dispatch({ type: 'SET_CHECKPOINT_DATA', checkpointData: cpData, phase: runInfo.phase });
            }
          }
        }
      }
    } catch {
    }
  }, [state.runId, state.mode, api, queryClient, state.isRunning, state.selectedNodeId]);

  const refreshCheckpointData = useCallback(async () => {
    if (!state.runId) return;
    try {
      const [logs, cpState] = await Promise.all([
        api.logs(state.runId),
        api.getCheckpointState(state.runId),
      ]);
      const logsArr = logs ?? [];
      if (logsArr.length > 0) {
        dispatch({ type: 'MERGE_AGENT_LOGS', logs: logsArr });
      }
      if (cpState?.checkpointData) {
        dispatch({ type: 'SET_CHECKPOINT_DATA', checkpointData: cpState.checkpointData, phase: '' });
        return;
      }
      // Completed run: compute checkpoint data from agent logs
      const cpNodeId = state.selectedNodeId;
      const cpAgentName = cpNodeId ? CHECKPOINT_AGENT_MAP[cpNodeId] : undefined;
      if (!state.isRunning && cpAgentName && logsArr.length > 0) {
        const agentLogs = logsArr.filter((l: any) => l.agent_name === cpAgentName);
        if (agentLogs.length > 0) {
          const od = mergeOutputData(agentLogs);
          let cpData: Record<string, any> | null = null;
          if (cpNodeId === 'checkpoint_1') {
            cpData = { conditions: od.testConditions || [], analysis: od.analysis || od.requirementAnalysis || null };
          } else if (cpNodeId === 'checkpoint_2') {
            cpData = { cases: od.draftTestCases || [] };
          } else if (cpNodeId === 'checkpoint_3') {
            cpData = { cases: od.finalTestCases || [], matrix: od.coverageMatrix || null };
          }
          if (cpData) {
            dispatch({ type: 'SET_CHECKPOINT_DATA', checkpointData: cpData, phase: '' });
          }
        }
      }
    } catch {
    }
  }, [state.runId, state.isRunning, state.selectedNodeId, api]);

  const setAutoFollowEnabled = useCallback((enabled: boolean) => {
    if (state.isRunning) {
      console.log('[AutoFollow] Cannot disable during pipeline execution');
      return;
    }
    if (autoFollowTimeoutRef.current !== null) {
      clearTimeout(autoFollowTimeoutRef.current);
      autoFollowTimeoutRef.current = null;
    }
    dispatch({ type: 'AUTO_FOLLOW_ENABLE', enabled });
  }, [state.isRunning]);

  const selectNode = useCallback((id: NodeId | null) => {
    dispatch({ type: 'SELECT_NODE', nodeId: id });
  }, []);

  const dismissError = useCallback(() => {
    dispatch({ type: 'DISMISS_ERROR' });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId ?? '') });
  }, [currentProjectId, queryClient]);

  const selectedNode = state.selectedNodeId
    ? state.nodes.find(n => n.id === state.selectedNodeId)
    : undefined;

  const CHECKPOINT_AGENT_MAP: Record<string, string> = {
    checkpoint_1: 'test-analyst',
    checkpoint_2: 'test-designer',
    checkpoint_3: 'quality-manager',
  };

  const mergeOutputData = (logs: any[]): any => {
    const result: Record<string, any> = {};
    for (const log of logs) {
      const od = log.output_data;
      if (!od) continue;
      for (const [key, value] of Object.entries(od)) {
        if (Array.isArray(value)) {
          if (!Array.isArray(result[key])) result[key] = [];
          result[key] = [...result[key], ...value];
        } else {
          result[key] = value;
        }
      }
    }
    return result;
  };

  const getMergedAgentLog = (agentName: string): any => {
    const normalize = (n: string) => n.replace(/_/g, '-');
    const target = normalize(agentName);
    const logs = state.agentLogs.filter((l: any) => normalize(l.agent_name) === target);
    if (logs.length === 0) return null;
    const latest = logs.reduce((best: any, l: any) => {
      const lBatch = l.batch || 0;
      const bBatch = best?.batch || 0;
      if (lBatch !== bBatch) return lBatch > bBatch ? l : best;
      const lTime = Date.parse(l.created_at || '') || 0;
      const bTime = Date.parse(best?.created_at || '') || 0;
      return lTime >= bTime ? l : best;
    }, logs[0]);
    const mergedOutputData = mergeOutputData(logs);
    const totalTokens = logs.reduce((sum: number, l: any) => {
      const tu = l.token_usage;
      return sum + (tu ? ((tu.input || 0) + (tu.output || 0) + (tu.reasoning || 0)) : 0);
    }, 0);
    const totalLatencyMs = logs.reduce((sum: number, l: any) => sum + (l.latency_ms ?? 0), 0);
    return {
      ...latest,
      output_data: mergedOutputData,
      token_usage: { input: 0, output: 0, reasoning: 0, total_tokens: totalTokens },
      latency_ms: totalLatencyMs,
      status: latest.status,
    };
  };

const selectedAgentLog = selectedNode?.agentName
  ? getMergedAgentLog(selectedNode.agentName) || null
  : selectedNode?.kind === 'checkpoint' && CHECKPOINT_AGENT_MAP[selectedNode.id]
  ? getMergedAgentLog(CHECKPOINT_AGENT_MAP[selectedNode.id]) || null
  : selectedNode?.kind === 'preparation'
  ? (getMergedAgentLog('preparation') || (selectedNode.meta?.initLogs
    ? { output_data: { initLogs: selectedNode.meta.initLogs, requirementCount: selectedNode.meta.requirementCount, totalBatches: selectedNode.meta.totalBatches, estimatedTokens: selectedNode.meta.estimatedTokens, flowCases: selectedNode.meta.flowCases } }
    : null))
  : null;

  const selectedCheckpointData = (() => {
    if (selectedNode?.kind !== 'checkpoint') return null;
    if (state.checkpointData) return state.checkpointData;
    if (!state.isRunning) {
      const agentName = CHECKPOINT_AGENT_MAP[selectedNode.id];
      if (!agentName) return null;
      const log = getMergedAgentLog(agentName);
      if (!log?.output_data) return null;
      const od = log.output_data;
      if (selectedNode.id === 'checkpoint_1') {
        return { conditions: od.testConditions || [], analysis: od.analysis || od.requirementAnalysis || null };
      }
      if (selectedNode.id === 'checkpoint_2') {
        return { cases: od.draftTestCases || [] };
      }
      return { cases: od.finalTestCases || [], matrix: od.coverageMatrix || null };
    }
    return null;
  })();

return {
    runId: explicitRunId ?? state.runId ?? undefined,
    nodes: state.nodes,
    isRunning: state.isRunning,
    mode: state.mode,
    batchProgress: state.batchProgress,
    selectedNodeId: state.selectedNodeId ?? undefined,
    selectedNode,
    selectNode,
    agentLogs: state.agentLogs,
    checkpointData: selectedCheckpointData,
    thinkingText: state.selectedNodeId ? (state.thinkingTextByNode[state.selectedNodeId] ?? null) : null,
    runSummary: state.runSummary,
    isPending: !state.runId && !state.isRunning && runs.length === 0,
    isConnected: state.isConnected,
    error: state.error,
    dismissError,
    runs,
    start,
    resume,
    startRetry,
    abort,
    refresh,
    refreshCheckpointData,
    reset,
    loadRun,
    isStarting: false,
    isAborting: false,
    isResuming: false,
    autoFollowEnabled: state.autoFollowEnabled,
    setAutoFollowEnabled,
    selectedAgentLog,
    startConfig: state.startConfig,
    modelName: state.modelName,
  };
}
