import type { TestGenRunState, TestGenReducerAction, TestGenNode, NodeId } from './types';
import { createFreshNodes, buildRestoredNodes } from './types';

const CHECKPOINT_NODE_IDS: Record<number, NodeId> = { 1: 'checkpoint_1', 2: 'checkpoint_2', 3: 'checkpoint_3' };
const AGENT_NAME_TO_NODE_ID: Record<string, NodeId> = {
  test_analyst: 'agent_test_analyst',
  'test-analyst': 'agent_test_analyst',
  test_designer: 'agent_test_designer',
  'test-designer': 'agent_test_designer',
  quality_manager: 'agent_quality_manager',
  'quality-manager': 'agent_quality_manager',
};

export function createInitialState(): TestGenRunState {
  return {
    runId: null,
    mode: 'auto',
    startConfig: null,
    nodes: createFreshNodes(),
    selectedNodeId: null,
    autoFollowEnabled: true,
    batchProgress: null,
    checkpointData: null,
    thinkingTextByNode: {},
    runSummary: null,
    isConnected: false,
    error: null,
    isRunning: false,
    agentLogs: [],
    modelName: null,
  };
}

function markPrecedingDone(nodes: TestGenNode[], activeNodeId: NodeId): TestGenNode[] {
  const idx = nodes.findIndex(n => n.id === activeNodeId);
  return nodes.map((n, i) =>
    i < idx && n.status !== 'completed'
      ? { ...n, status: 'completed' as const, subSteps: n.subSteps?.map(s => ({ ...s, done: true })) }
      : n,
  );
}

export function testGenReducer(state: TestGenRunState, action: TestGenReducerAction): TestGenRunState {
  switch (action.type) {
    case 'SSE_EVENT': {
      const { type, data } = action.event;
      let nodes = state.nodes;
      let checkpointData = state.checkpointData;
      let thinkingTextByNode = state.thinkingTextByNode;
      let batchProgress = state.batchProgress;
      let runSummary = state.runSummary;

if (type === 'pipeline:context' || type === 'pipeline:budget' || type === 'phase:start' || type === 'preparation:context') {
  const prepNode = nodes.find(n => n.id === 'preparation');
  if (prepNode) {
    const initLogs = prepNode.meta?.initLogs ? [...prepNode.meta.initLogs] : [];
    initLogs.push({ type, data, timestamp: new Date().toISOString() });

    const updatedMeta: any = { ...prepNode.meta, initLogs };

    if (type === 'pipeline:context') {
      if (data.indexEntries != null) {
        updatedMeta.requirementCount = data.indexEntries;
      }
      if (data.flows != null) {
        updatedMeta.flowCases = data.flows;
      }
    }

    if (type === 'pipeline:budget') {
      if (data.estimated != null) {
        updatedMeta.estimatedTokens = data.estimated;
      }
    }

    if (type === 'phase:start' && data.phase === 'preparation') {
      const match = data.message?.match(/(\d+) batch\(es\)/);
      if (match) {
        updatedMeta.totalBatches = parseInt(match[1], 10);
      }
    }

    // L1 Epic 索引：全局观数据
    if (type === 'preparation:context') {
      if (data.globalStats) {
        updatedMeta.globalStats = data.globalStats;
      }
      if (Array.isArray(data.globalEpicIndex)) {
        updatedMeta.globalEpicIndex = data.globalEpicIndex;
      }
    }

    nodes = nodes.map(n =>
      n.id === 'preparation'
      ? { ...n, meta: updatedMeta }
      : n
    );
  }
}

      switch (type) {
        case 'agent:start': {
          const nodeId = AGENT_NAME_TO_NODE_ID[data.agentName];
          if (!nodeId) return state;
          const currentBatch = data.batch ?? batchProgress?.current ?? 1;
          const existingText = thinkingTextByNode[nodeId] ?? [];
          thinkingTextByNode = {
            ...thinkingTextByNode,
            [nodeId]: existingText.filter(t => (t.batch || 1) !== currentBatch)
          };
          nodes = markPrecedingDone(nodes, nodeId);
          nodes = nodes.map(n =>
            n.id === nodeId
              ? { ...n, status: 'running' as const, subSteps: n.subSteps?.map(s => ({ ...s, done: false, running: false })) }
              : n,
          );
          if (state.autoFollowEnabled) {
            return { ...state, nodes, thinkingTextByNode, selectedNodeId: nodeId, batchProgress, runSummary };
          }
          break;
        }
        case 'agent:complete': {
          const nodeId = AGENT_NAME_TO_NODE_ID[data.agentName];
          if (!nodeId) return state;
          nodes = nodes.map(n =>
            n.id === nodeId
              ? { ...n, status: 'completed' as const,
                meta: { ...n.meta, outputCount: data.outputCount, outputLabel: data.outputLabel || data.outputSummary,
                  tokenUsage: data.tokenUsage, latencyMs: data.latencyMs } }
              : n,
          );
          const AGENT_TO_CHECKPOINT: Record<string, NodeId> = {
            test_analyst: 'checkpoint_1',
            'test-analyst': 'checkpoint_1',
            test_designer: 'checkpoint_2',
            'test-designer': 'checkpoint_2',
            quality_manager: 'checkpoint_3',
            'quality-manager': 'checkpoint_3',
          };
          const nextCp = AGENT_TO_CHECKPOINT[data.agentName];
          const cpNode = nextCp ? nodes.find(n => n.id === nextCp && n.status === 'idle') : undefined;
          if (cpNode) {
            return { ...state, nodes, checkpointData: null, selectedNodeId: cpNode.id, thinkingTextByNode, batchProgress, runSummary };
          }
          break;
        }
        case 'agent:step': {
          const nodeId = AGENT_NAME_TO_NODE_ID[data.agentName];
          if (!nodeId) return state;
          nodes = nodes.map(n =>
            n.id === nodeId && n.subSteps
              ? { ...n, subSteps: n.subSteps.map((s, i) => ({
                  ...s, done: i < data.stepIndex, running: i === data.stepIndex,
                })) }
              : n,
          );
          break;
        }
        case 'agent:error': {
          const nodeId = AGENT_NAME_TO_NODE_ID[data.agentName];
          if (!nodeId) return state;
          nodes = nodes.map(n =>
            n.id === nodeId ? { ...n, status: 'error' as const } : n,
          );
          break;
        }
        case 'agent:thinking': {
          const nodeId = AGENT_NAME_TO_NODE_ID[data.agentName];
          if (!nodeId) return state;
          const entries = thinkingTextByNode[nodeId] ?? [];
          const lastEntry = entries[entries.length - 1];
          const batch = data.batch ?? batchProgress?.current ?? undefined;
          // Merge into last entry if same type+phase+batch, otherwise start a new entry
          if (lastEntry && lastEntry.type === (data.type ?? 'content') && lastEntry.phase === (data.phase ?? 'react') && lastEntry.batch === batch) {
            thinkingTextByNode = {
              ...thinkingTextByNode,
              [nodeId]: [...entries.slice(0, -1), { ...lastEntry, text: lastEntry.text + data.text }],
            };
          } else {
            thinkingTextByNode = {
              ...thinkingTextByNode,
              [nodeId]: [...entries, { type: data.type ?? 'content', phase: data.phase ?? 'react', text: data.text, timestamp: data.timestamp ?? Date.now(), batch }],
            };
          }
          break;
        }
        case 'checkpoint:waiting': {
          const cpId = CHECKPOINT_NODE_IDS[data.checkpointNumber];
          if (!cpId) return state;
          checkpointData = data.payload;
          nodes = nodes.map(n =>
            n.id === cpId ? { ...n, status: 'waiting' as const } : n,
          );
          return { ...state, nodes, checkpointData, selectedNodeId: cpId, thinkingTextByNode, batchProgress, runSummary };
        }
        case 'checkpoint:resolved': {
          const cpId = CHECKPOINT_NODE_IDS[data.checkpointNumber];
          if (!cpId) return state;
          checkpointData = null;
          nodes = markPrecedingDone(nodes, cpId);
          nodes = nodes.map(n =>
            n.id === cpId ? { ...n, status: 'completed' as const } : n,
          );
          break;
        }
        case 'batch:start':
          batchProgress = { current: data.batch, total: data.total, generatedCases: state.batchProgress?.generatedCases ?? 0 };
          break;
        case 'batch:complete':
          batchProgress = state.batchProgress
            ? { ...state.batchProgress, generatedCases: (state.batchProgress.generatedCases || 0) + (data.testCases || 0) }
            : null;
          break;
        case 'pipeline:retry': {
          // Map phase to the failing agent node, only reset that node
          const PHASE_TO_ERROR_NODE: Record<string, NodeId> = {
            'analysis': 'agent_test_analyst',
            'review-conditions': 'agent_test_analyst',
            'design': 'agent_test_designer',
            'review-draft': 'agent_test_designer',
            'quality': 'agent_quality_manager',
            'final-review': 'agent_quality_manager',
          };
          const retryNodeId = PHASE_TO_ERROR_NODE[data.phase];
          // Reset thinking text for all error/retrying nodes so the streaming
          // panel starts clean after a retry.
          thinkingTextByNode = Object.fromEntries(
            Object.entries(thinkingTextByNode).map(([k, v]) => [k, []]),
          );
          nodes = nodes.map(n =>
            n.id === retryNodeId && n.status === 'error'
              ? { ...n, status: 'running' as const, subSteps: n.subSteps?.map(s => ({ ...s, done: false, running: false })) }
              : n,
          );
          return { ...state, nodes, isRunning: true, error: null, thinkingTextByNode };
        }
        case 'pipeline:complete':
          runSummary = {
            totalCases: data.stats?.totalCases || 0,
            totalTokens: data.stats?.totalTokens || 0,
            totalLatencyMs: data.stats?.totalLatencyMs || 0,
            totalBatches: data.stats?.totalBatches || 0,
          };
          nodes = nodes.map(n => ({
            ...n,
            status: n.status === 'running' || n.status === 'waiting' || n.status === 'idle'
              ? 'completed' as const : n.status,
            meta: n.id === 'complete' ? { ...n.meta, ...runSummary } : n.meta,
          }));
          return { ...state, nodes, checkpointData, thinkingTextByNode, batchProgress, runSummary, isRunning: false };
        case 'pipeline:error':
          return { ...state, error: { code: 'API_ERROR', message: data.message || 'Test gen error', detail: data }, isRunning: false };
        default:
          break;
      }
      return { ...state, nodes, checkpointData, thinkingTextByNode, batchProgress, runSummary };
    }

    case 'RUN_STARTED':
      return {
        ...state,
        runId: action.runId,
        startConfig: action.config,
        mode: action.config.mode,
        modelName: action.config.modelName || action.config.model || state.modelName,
        nodes: createFreshNodes(),
        selectedNodeId: null,
        batchProgress: null,
        checkpointData: null,
        thinkingTextByNode: {},
        runSummary: null,
        error: null,
        isRunning: true,
        autoFollowEnabled: true,
      };

    case 'RUN_ABORTED':
      return {
        ...state,
        nodes: state.nodes.map(n =>
          n.status === 'running' || n.status === 'waiting'
            ? { ...n, status: 'error' as const }
            : n
        ),
        isRunning: false,
        isConnected: false,
        error: { code: 'API_ERROR', message: 'Run was aborted by user.' },
      };

    case 'RETRY_STARTED': {
      // Only reset the selected error node to running, keep preceding nodes completed
      const retryNodes = state.nodes.map(n =>
        n.id === action.nodeId && n.status === 'error'
          ? { ...n, status: 'running' as const, subSteps: n.subSteps?.map(s => ({ ...s, done: false, running: false })) }
          : n,
      );
      return {
        ...state,
        nodes: retryNodes,
        isRunning: true,
        error: null,
      };
    }

    case 'RESTORE_RUN': {
      const restoredNodes = buildRestoredNodes(
        action.phase, action.status, action.totalBatches,
      );
      const isRunning = action.status !== 'COMPLETED' && action.status !== 'FAILED';
      const waitingNode = action.status === 'WAITING_REVIEW'
        ? restoredNodes.find(n => n.status === 'waiting')
        : undefined;
      return {
        ...state,
        runId: action.runId,
        mode: action.mode ?? state.mode,
        nodes: restoredNodes,
        selectedNodeId: waitingNode?.id ?? state.selectedNodeId,
        isRunning,
        checkpointData: null,
        thinkingTextByNode: {},
        error: null,
        agentLogs: [],
      };
    }

    case 'SET_CHECKPOINT_DATA': {
      return {
        ...state,
        checkpointData: action.checkpointData,
      };
    }

    case 'MERGE_AGENT_LOGS': {
    const nodes: TestGenNode[] = state.nodes.map(n => {
      if (n.id === 'complete') {
        const logs = action.logs ?? [];
        const completedLogs = logs.filter((l: any) => l.status === 'COMPLETED');
        // Only mark complete as completed if quality_manager has finished
        const normalize = (s: string) => s.replace(/_/g, '-');
        const qualityManagerDone = completedLogs.some((l: any) => {
          const name = normalize(l.agent_name ?? '');
          return name === 'quality-manager' || name === 'quality_manager';
        });
        if (!qualityManagerDone) return n;
        let totalOutputCount = 0;
        let totalTokens = 0;
        let totalLatencyMs = 0;
        const mergedOutputData: Record<string, any> = {};
        const seenCaseIds = new Set<string>();
        
        for (const log of completedLogs) {
          const od = log.output_data;
          if (od) {
            const finalCases = od.finalTestCases;
            if (Array.isArray(finalCases)) {
              for (const tc of finalCases) {
                if (tc.id && !seenCaseIds.has(tc.id)) {
                  seenCaseIds.add(tc.id);
                  totalOutputCount++;
                }
              }
            }
            for (const [key, val] of Object.entries(od)) {
              if (!(key in mergedOutputData)) mergedOutputData[key] = val;
            }
          }
          const tu = log.token_usage;
          if (tu) totalTokens += (tu.input || 0) + (tu.output || 0) + (tu.reasoning || 0);
          totalLatencyMs += log.latency_ms ?? 0;
        }
        return {
          ...n, status: 'completed' as const,
          meta: { ...n.meta, outputCount: totalOutputCount, tokenUsage: totalTokens, latencyMs: totalLatencyMs, totalCases: totalOutputCount, totalTokens, totalLatencyMs, totalBatches: n.meta?.totalBatches ?? 0, outputData: Object.keys(mergedOutputData).length > 0 ? mergedOutputData : undefined },
        };
      }
        if (!n.agentName) return n;
        const normalize = (s: string) => s.replace(/_/g, '-');
        const target = normalize(n.agentName);
        const agentLogs = (action.logs ?? []).filter((l: any) => normalize(l.agent_name) === target);
        if (agentLogs.length === 0) return n;
        const latest = agentLogs.reduce((best: any, l: any) => {
          const lBatch = l.batch || 0;
          const bBatch = best?.batch || 0;
          if (lBatch !== bBatch) return lBatch > bBatch ? l : best;
          const lTime = Date.parse(l.created_at || '') || 0;
          const bTime = Date.parse(best?.created_at || '') || 0;
          return lTime >= bTime ? l : best;
        }, agentLogs[0]);
        let outputCount = 0;
        const mergedOutputData: Record<string, any> = {};
        let totalTokens = 0;
        let totalLatencyMs = 0;
        for (const log of agentLogs) {
          const od = log.output_data;
          if (od) {
            outputCount += (Object.values(od) as any[]).reduce((sum: number, v: any) => sum + (Array.isArray(v) ? v.length : 0), 0);
            for (const [key, val] of Object.entries(od)) {
              if (Array.isArray(val)) {
                if (!Array.isArray(mergedOutputData[key])) mergedOutputData[key] = [];
                mergedOutputData[key] = [...mergedOutputData[key], ...val];
              } else {
                mergedOutputData[key] = val;
              }
            }
          }
          const tu = log.token_usage;
          if (tu) totalTokens += (tu.input || 0) + (tu.output || 0) + (tu.reasoning || 0);
          totalLatencyMs += log.latency_ms ?? 0;
        }
        const status = latest.status === 'COMPLETED' ? 'completed' as const :
                       latest.status === 'FAILED' ? 'error' as const :
                       n.status;
        return { ...n, status, meta: { ...n.meta, tokenUsage: totalTokens, latencyMs: totalLatencyMs, outputCount, outputData: Object.keys(mergedOutputData).length > 0 ? mergedOutputData : undefined } };
      });
      return { ...state, nodes, agentLogs: action.logs ?? [] };
    }

    case 'RESTORE_RUN_COMPLETE': {
      const restoredNodes = buildRestoredNodes(
        action.phase, action.status, action.totalBatches,
      );
      const isRunning = action.status !== 'COMPLETED' && action.status !== 'FAILED';
      const waitingNode = action.status === 'WAITING_REVIEW'
        ? restoredNodes.find(n => n.status === 'waiting')
        : undefined;
      const nodes = restoredNodes.map(n => {
        if (n.id === 'complete') {
          const completedLogs = (action.logs ?? []).filter((l: any) => l.status === 'COMPLETED');
          const normalize = (s: string) => s.replace(/_/g, '-');
          const qualityManagerDone = completedLogs.some((l: any) => {
            const name = normalize(l.agent_name ?? '');
            return name === 'quality-manager' || name === 'quality_manager';
          });
          if (!qualityManagerDone) return n;
          let totalOutputCount = 0;
          let totalTokens = 0;
          let totalLatencyMs = 0;
          const mergedOutputData: Record<string, any> = {};
          const seenCaseIds = new Set<string>();
          for (const log of completedLogs) {
            const od = log.output_data;
            if (od) {
              const finalCases = od.finalTestCases;
              if (Array.isArray(finalCases)) {
                for (const tc of finalCases) {
                  if (tc.id && !seenCaseIds.has(tc.id)) {
                    seenCaseIds.add(tc.id);
                    totalOutputCount++;
                  }
                }
              }
              for (const [key, val] of Object.entries(od)) {
                if (!(key in mergedOutputData)) mergedOutputData[key] = val;
              }
            }
            const tu = log.token_usage;
            if (tu) totalTokens += (tu.input || 0) + (tu.output || 0) + (tu.reasoning || 0);
            totalLatencyMs += log.latency_ms ?? 0;
          }
          return {
            ...n, status: 'completed' as const,
            meta: { ...n.meta, outputCount: totalOutputCount, tokenUsage: totalTokens, latencyMs: totalLatencyMs, totalCases: totalOutputCount, totalTokens, totalLatencyMs, totalBatches: n.meta?.totalBatches ?? 0, outputData: Object.keys(mergedOutputData).length > 0 ? mergedOutputData : undefined },
          };
        }
        if (!n.agentName) return n;
        const normalize = (s: string) => s.replace(/_/g, '-');
        const target = normalize(n.agentName);
        const agentLogs = (action.logs ?? []).filter((l: any) => normalize(l.agent_name) === target);
        if (agentLogs.length === 0) return n;
        const latest = agentLogs.reduce((best: any, l: any) => {
          const lBatch = l.batch || 0;
          const bBatch = best?.batch || 0;
          if (lBatch !== bBatch) return lBatch > bBatch ? l : best;
          const lTime = Date.parse(l.created_at || '') || 0;
          const bTime = Date.parse(best?.created_at || '') || 0;
          return lTime >= bTime ? l : best;
        }, agentLogs[0]);
        let outputCount = 0;
        const mergedOutputData: Record<string, any> = {};
        let totalTokens = 0;
        let totalLatencyMs = 0;
        for (const log of agentLogs) {
          const od = log.output_data;
          if (od) {
            outputCount += (Object.values(od) as any[]).reduce((sum: number, v: any) => sum + (Array.isArray(v) ? v.length : 0), 0);
            for (const [key, val] of Object.entries(od)) {
              if (Array.isArray(val)) {
                if (!Array.isArray(mergedOutputData[key])) mergedOutputData[key] = [];
                mergedOutputData[key] = [...mergedOutputData[key], ...val];
              } else {
                mergedOutputData[key] = val;
              }
            }
          }
          const tu = log.token_usage;
          if (tu) totalTokens += (tu.input || 0) + (tu.output || 0) + (tu.reasoning || 0);
          totalLatencyMs += log.latency_ms ?? 0;
        }
        const status = latest.status === 'COMPLETED' ? 'completed' as const :
                       latest.status === 'FAILED' ? 'error' as const :
                       n.status;
        return { ...n, status, meta: { ...n.meta, tokenUsage: totalTokens, latencyMs: totalLatencyMs, outputCount, outputData: Object.keys(mergedOutputData).length > 0 ? mergedOutputData : undefined } };
      });
      // Fix checkpoint statuses from actual agent logs (DB phase alone is unreliable for FAILED runs)
      const nextAgentAfter: Record<string, string> = {
        checkpoint_1: 'test-designer',
        checkpoint_2: 'quality-manager',
      };
      const normalize = (s: string) => s.replace(/_/g, '-');
      const fixedNodes = nodes.map(n => {
        if (n.kind !== 'checkpoint' || n.status === 'completed') return n;
        if (n.id === 'checkpoint_1' || n.id === 'checkpoint_2') {
          const next = nextAgentAfter[n.id];
          if ((action.logs ?? []).some((l: any) => normalize(l.agent_name) === next)) {
            return { ...n, status: 'completed' as const };
          }
        }
        if (n.id === 'checkpoint_3') {
          const qmCompleted = (action.logs ?? []).some((l: any) =>
            normalize(l.agent_name) === 'quality-manager' && l.status === 'COMPLETED'
          );
          if (qmCompleted) {
            return { ...n, status: 'completed' as const };
          }
        }
        return n;
      });
      return {
        ...state,
        runId: action.runId,
        mode: action.mode ?? state.mode,
        nodes: fixedNodes,
        selectedNodeId: waitingNode?.id ?? state.selectedNodeId,
        isRunning,
        checkpointData: action.checkpointData ?? null,
        thinkingTextByNode: {},
        error: null,
        agentLogs: action.logs ?? [],
        runSummary: action.summary,
        modelName: action.modelName ?? state.modelName,
        startConfig: action.startConfig ?? state.startConfig,
      };
    }

    case 'SET_RUN_SUMMARY':
      return { ...state, runSummary: action.summary };

    case 'SELECT_NODE':
      return {
        ...state,
        selectedNodeId: action.nodeId,
      };

    case 'AUTO_FOLLOW_ENABLE':
      return { ...state, autoFollowEnabled: action.enabled };

    case 'SET_CONNECTED':
      return { ...state, isConnected: action.connected };

    case 'SET_ERROR':
      return { ...state, error: action.error };

    case 'DISMISS_ERROR':
      return { ...state, error: null };

    case 'RESET':
      return createInitialState();

    case 'SET_THINKING_DATA':
      return { ...state, thinkingTextByNode: action.thinkingData };

    default:
      return state;
  }
}
