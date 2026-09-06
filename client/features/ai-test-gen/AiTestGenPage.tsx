import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { RefreshCw, Trash2, PlayCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRequirements } from '@/shared/hooks/useQueryHooks';
import { useTestGenRun } from '@/shared/test-gen-run';
import { queryKeys } from '@/shared/hooks/queryKeys';
import { TestGenConfigPanel, type TestGenStartConfig } from './TestGenConfigPanel';
import { TestGenStepper } from './TestGenStepper';
import { TestGenDetailPanel } from './TestGenDetailPanel';
import { TestGenRunHistory } from './TestGenRunHistory';
import { AgentPromptsPanel } from './AgentPromptsPanel';
import { useHtmlKnowledgeUpload } from './useHtmlKnowledgeUpload';
import { ConfirmModal } from '@/shared/ui/ConfirmModal';

type TabId = 'new' | 'runtime' | 'history' | 'prompts';

const TABS: { id: TabId; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'history', label: 'History' },
  { id: 'prompts', label: 'Agent Prompts' },
];

interface AiTestGenPageProps {
  currentProjectId: string | null;
}

interface StartAttempt {
  token: number;
  projectId: string;
  htmlKnowledgeSetId?: string;
}

export function AiTestGenPage({ currentProjectId }: AiTestGenPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('new');
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [showRetryConfirm, setShowRetryConfirm] = useState(false);
  const [showResumeConfirm, setShowResumeConfirm] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [isStartPending, setIsStartPending] = useState(false);
  const pipeline = useTestGenRun(currentProjectId, { detailPanelVisible: activeTab !== 'history' });
  const htmlKnowledgeUpload = useHtmlKnowledgeUpload(currentProjectId);
  const queryClient = useQueryClient();
  const checkpointEditedData = useRef<any>(null);
  const previousTabRef = useRef<TabId>('new');
  const startAttemptTokenRef = useRef(0);
  const startAttemptRef = useRef<StartAttempt | null>(null);
  const currentProjectIdRef = useRef(currentProjectId);
  currentProjectIdRef.current = currentProjectId;
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewActionMsg, setReviewActionMsg] = useState<string | null>(null);

  const { data: requirements = [] } = useRequirements(currentProjectId || '');
  const flowStories = useMemo(() => requirements.filter(r => r.isFlow), [requirements]);

  useEffect(() => {
    if (previousTabRef.current === 'new' && activeTab !== 'new') {
      void htmlKnowledgeUpload.reset();
    }
    previousTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    setIsStartPending(false);
    return () => {
      startAttemptTokenRef.current += 1;
      startAttemptRef.current = null;
    };
  }, [currentProjectId]);

const handleRefresh = useCallback(async () => {
    // Always refresh the runs list (history)
    await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId || '') });
    // If there's an active run, also refresh its data
    if (pipeline.runId) {
      await pipeline.refresh();
      // Also re-fetch agent logs for the current run
      await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.logs(pipeline.runId) });
    }
  }, [pipeline, queryClient, currentProjectId]);

  const handleStart = useCallback(async (config: TestGenStartConfig) => {
    if (!currentProjectId || startAttemptRef.current) return;
    const htmlKnowledgeSetId = config.htmlKnowledgeSetId;
    const attempt: StartAttempt = {
      token: ++startAttemptTokenRef.current,
      projectId: currentProjectId,
      htmlKnowledgeSetId,
    };
    startAttemptRef.current = attempt;
    setIsStartPending(true);
    const isCurrentAttempt = () => {
      const activeAttempt = startAttemptRef.current;
      return startAttemptTokenRef.current === attempt.token
        && activeAttempt?.token === attempt.token
        && activeAttempt.projectId === attempt.projectId
        && activeAttempt.htmlKnowledgeSetId === attempt.htmlKnowledgeSetId
        && currentProjectIdRef.current === attempt.projectId;
    };
    try {
      await pipeline.start({
        requirementIds: config.requirementIds,
        providerConfigName: config.providerConfigName,
        model: config.model,
        modelName: config.modelName,
        mode: config.mode,
        flowIds: config.flowIds,
        useCache: config.useCache,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        textVerbosity: config.textVerbosity,
        referenceRunIds: config.referenceRunIds,
        htmlKnowledgeSetId,
      });
      if (!isCurrentAttempt()) return;
      if (htmlKnowledgeSetId) {
        htmlKnowledgeUpload.releaseAfterStart(htmlKnowledgeSetId);
      }
      startAttemptRef.current = null;
      setIsStartPending(false);
      setActiveTab('runtime');
    } catch {
      if (isCurrentAttempt()) {
        startAttemptRef.current = null;
        setIsStartPending(false);
      }
      // error dispatched to reducer via SET_ERROR
    }
  }, [currentProjectId, pipeline, htmlKnowledgeUpload]);

  const handleDeleteRun = useCallback(async (runId: string) => {
    try {
      const { api } = await import('@/shared/services/api');
      await api.testGen.delete(runId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId || '') });
    } catch { /* best effort */ }
  }, [currentProjectId, queryClient]);

  const handleClear = useCallback(() => {
    if (startAttemptRef.current) return;
    void htmlKnowledgeUpload.reset();
    pipeline.reset();
  }, [pipeline, htmlKnowledgeUpload]);

  const handleTabChange = (tabId: TabId) => {
    if (startAttemptRef.current) return;
    setActiveTab(tabId);
  };

  const handleAbort = useCallback(async () => {
    setShowAbortConfirm(false);
    await pipeline.abort();
  }, [pipeline]);

  const handleNodeClick = useCallback((nodeId: string) => {
    pipeline.selectNode(nodeId as any);
    pipeline.setAutoFollowEnabled(false);
  }, [pipeline]);

  const handleCloseDetail = useCallback(() => {
    pipeline.selectNode(null);
    pipeline.setAutoFollowEnabled(true);
  }, [pipeline]);

  const handleToggleAutoFollow = useCallback(() => {
    pipeline.setAutoFollowEnabled(!pipeline.autoFollowEnabled);
  }, [pipeline]);

  const handleApprove = useCallback(() => {
    if (!pipeline.runId) return;
    pipeline.resume('approve', { editedData: checkpointEditedData.current ?? undefined });
    setReviewMode(false);
  }, [pipeline]);

  const handleRetry = useCallback(async () => {
    if (!pipeline.runId) return;
    // If the pipeline has an error node, use the retry-from-checkpoint API
    const errorNode = pipeline.nodes.find((n: any) => n.status === 'error');
    if (errorNode) {
      setRetrying(true);
      pipeline.startRetry(errorNode.id); // Only reset the selected error node, keep preceding nodes completed
      try {
        const { api } = await import('@/shared/services/api');
        await api.testGen.retry(pipeline.runId);
        await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId || '') });
      } catch {
        // error surfaced via SSE
      } finally {
        setRetrying(false);
        setReviewMode(false);
      }
    } else {
      setRetrying(true);
      checkpointEditedData.current = null;
      try {
        await pipeline.resume('retry');
      } catch {
        // error surfaced via SSE pipeline:error
      } finally {
        setRetrying(false);
        setReviewMode(false);
      }
    }
  }, [pipeline, queryClient, currentProjectId]);

  const handleResumeAbortedRun = useCallback(async () => {
    if (isStartPending || !pipeline.runId) return;
    setResuming(true);
    try {
      // Find the first error or incomplete agent node to mark as retrying
      const errorNode = pipeline.nodes.find((n: any) => n.status === 'error');
      if (errorNode) pipeline.startRetry(errorNode.id);
      const { api } = await import('@/shared/services/api');
      await api.testGen.retry(pipeline.runId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId || '') });
      setActiveTab('runtime');
    } catch {
      // error surfaced via SSE
    } finally {
      setResuming(false);
    }
  }, [pipeline, queryClient, currentProjectId, isStartPending]);

  const handleRetryFailedRun = useCallback(async (runId: string) => {
    try {
      const errorNode = pipeline.nodes.find((n: any) => n.status === 'error');
      if (errorNode) pipeline.startRetry(errorNode.id);
      const { api } = await import('@/shared/services/api');
      await api.testGen.retry(runId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.testGen.runs(currentProjectId || '') });
    } catch {
      // best effort
    }
  }, [pipeline, queryClient, currentProjectId]);

  const handleToggleReview = useCallback(() => {
    setReviewActionMsg(null);
    setReviewMode(prev => !prev);
  }, []);

  const handleDoneReviewing = useCallback(async () => {
    const node = pipeline.selectedNode;
    const cpMap: Record<string, number> = {
      checkpoint_1: 1, checkpoint_2: 2, checkpoint_3: 3,
    };
    const cpNum = node?.kind === 'checkpoint' ? cpMap[node.id] : undefined;
    // 只有 checkpoint 正处于人工审核停等（run.status === WAITING_REVIEW）时才允许保存编辑；
    // auto-passed / completed 等非审核态没有可保存的审核会话，服务端会拒绝。
    const isAwaitingReview = node?.status === 'waiting';
    try {
      if (node?.kind === 'checkpoint' && cpNum && isAwaitingReview && checkpointEditedData.current && pipeline.runId) {
        const { api } = await import('@/shared/services/api');
        await api.testGen.saveCheckpointEdits(pipeline.runId, checkpointEditedData.current, cpNum);
        await pipeline.refreshCheckpointData();
        setReviewActionMsg('Edits saved');
      } else if (node?.kind === 'checkpoint' && cpNum && !isAwaitingReview) {
        setReviewActionMsg('This checkpoint is already passed/resolved — edits can only be saved while it waits for review.');
      }
    } catch (err: any) {
      setReviewActionMsg(`Failed to save edits: ${err?.message || 'unknown error'}`);
    } finally {
      // 无论如何退出 review 模式，避免按钮无响应
      setReviewMode(false);
    }
  }, [pipeline]);

  const handleCheckpointDataChange = useCallback((data: any) => {
    checkpointEditedData.current = data;
  }, []);

  const handleSelectRun = useCallback(async (runId: string) => {
    await pipeline.loadRun(runId);
    setActiveTab('runtime');
  }, [pipeline]);

  // Debug: log pipeline state on node selection
  useEffect(() => {
    if (pipeline.selectedNode) {
      console.log(`[TestGen] node=${pipeline.selectedNode.id} kind=${pipeline.selectedNode.kind} checkpoint=${pipeline.checkpointData ? 'yes' : 'no'} agentLog=${pipeline.selectedAgentLog ? 'yes' : 'no'} logs=${pipeline.agentLogs.length}`);
    }
  }, [pipeline.selectedNode, pipeline.checkpointData, pipeline.selectedAgentLog, pipeline.agentLogs]);

  const selectedAgentLog = pipeline.selectedAgentLog;

  // Detect if current run is resumable (FAILED/aborted with progress)
  const isResumable = useMemo(() => {
    if (pipeline.isRunning || !pipeline.runId) return false;
    // Has at least one node that was attempted (so we can resume it)
    const hasAttempted = pipeline.nodes.some(
      (n: any) => (n.kind === 'agent' || n.kind === 'preparation') && n.status !== 'idle'
    );
    // Not fully completed
    const isComplete = pipeline.nodes.find((n: any) => n.id === 'complete')?.status === 'completed';
    return hasAttempted && !isComplete;
  }, [pipeline.isRunning, pipeline.runId, pipeline.nodes]);

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-400">Select a project to continue</div>;
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider">AI Test Gen</h2>
          {pipeline.error && (
            <span role="alert" className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200 max-w-md truncate">
              {pipeline.error.message}
            </span>
          )}
          {pipeline.isRunning && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
              pipeline.isConnected ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200'
            }`}>
              {pipeline.isConnected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            disabled={isStartPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            title="Clear current pipeline to start fresh"
          >
            <Trash2 size={14} />
            Clear
          </button>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            title="Refresh pipeline runs list and node status"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {pipeline.isRunning && (
            <button
              onClick={() => setShowAbortConfirm(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
            >
              Abort
            </button>
          )}
          {isResumable && !pipeline.isRunning && (
            <button
              onClick={() => setShowResumeConfirm(true)}
              disabled={resuming || isStartPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors disabled:opacity-50"
            >
              <PlayCircle size={14} className={resuming ? 'animate-spin' : ''} />
              {resuming ? 'Resuming...' : 'Resume from Checkpoint'}
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white px-4 shrink-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            disabled={isStartPending}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
                : 'text-slate-500 hover:text-slate-700'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'new' && (
          <TestGenConfigPanel
            key={currentProjectId}
            projectId={currentProjectId}
            requirements={requirements}
            flowStories={flowStories}
            htmlKnowledgeUpload={htmlKnowledgeUpload}
            onStart={handleStart}
            disabled={pipeline.isRunning}
            startPending={isStartPending}
          />
        )}
        {activeTab === 'runtime' && (
          <div className="h-full flex overflow-hidden">
            <div className="w-80 shrink-0 h-full overflow-hidden border-r border-slate-200 bg-slate-50/60">
              <TestGenStepper
                nodes={pipeline.nodes as any}
                selectedNodeId={pipeline.selectedNodeId ?? null}
                onNodeClick={handleNodeClick}
                autoFollowEnabled={pipeline.autoFollowEnabled}
                onToggleAutoFollow={handleToggleAutoFollow}
                isRunning={pipeline.isRunning}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <TestGenDetailPanel
                runId={pipeline.runId}
                projectId={currentProjectId}
                node={pipeline.selectedNode as any ?? null}
                agentLog={selectedAgentLog}
                checkpointData={pipeline.checkpointData}
                thinkingText={pipeline.thinkingText}
                runSummary={pipeline.runSummary}
                agentLogs={pipeline.agentLogs}
                startConfig={pipeline.startConfig}
                requirements={requirements}
                flowStories={flowStories}
                modelName={pipeline.modelName}
                onClose={handleCloseDetail}
                onApprove={handleApprove}
                onRetry={() => setShowRetryConfirm(true)}
                onToggleReview={handleToggleReview}
                onDoneReviewing={handleDoneReviewing}
                onCheckpointDataChange={handleCheckpointDataChange}
                reviewMessage={reviewActionMsg}
                isEditing={reviewMode}
                retrying={retrying}
              />
            </div>
          </div>
        )}
        {activeTab === 'history' && (
          <TestGenRunHistory
            runs={pipeline.runs}
            onSelect={handleSelectRun}
            onBack={() => setActiveTab('new')}
            onDeleteRun={handleDeleteRun}
            onRetryRun={handleRetryFailedRun}
          />
        )}
        {activeTab === 'prompts' && (
          <AgentPromptsPanel projectId={currentProjectId} />
        )}
      </div>

      <ConfirmModal
        isOpen={showAbortConfirm}
        onClose={() => setShowAbortConfirm(false)}
        onConfirm={handleAbort}
        title="Abort Test Gen?"
        message="This will stop the current test generation run. Generated test cases from completed batches will be preserved. This action cannot be undone."
        confirmLabel="Abort Test Gen"
        type="warning"
      />

      <ConfirmModal
        isOpen={showRetryConfirm}
        onClose={() => setShowRetryConfirm(false)}
        onConfirm={() => { setShowRetryConfirm(false); handleRetry(); }}
        title="Retry from last checkpoint?"
        message="The agent will re-run from the previous checkpoint with the same inputs. Any edits made during review will be lost."
        confirmLabel="Retry from last checkpoint"
        type="warning"
      />

      <ConfirmModal
        isOpen={showResumeConfirm}
        onClose={() => setShowResumeConfirm(false)}
        onConfirm={() => { setShowResumeConfirm(false); handleResumeAbortedRun(); }}
        title="Resume from Checkpoint?"
        message="The pipeline will resume from the last successful checkpoint. Previously completed batches and their test cases are preserved. The failed or interrupted agent will be re-executed."
        confirmLabel="Resume Pipeline"
        type="warning"
      />
    </div>
  );
}
