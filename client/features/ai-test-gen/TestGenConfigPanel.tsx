import React, { useState, useEffect, useId, useMemo, useRef } from 'react';
import { ChevronRight, ChevronDown, ChevronsUpDown, Play, FileText, GitBranch, Settings2, Zap, CheckCircle, History, Search } from 'lucide-react';
import type { Requirement } from '../../../shared/contracts/index';
import { useProviderConfigs, useTestGenRuns, usePrdDocuments } from '../../shared/hooks/useQueryHooks';
import { parseStoryMarkdown } from '../../shared/requirements/format-parser';
import { parseACMarkdown } from '../../shared/requirements/format-parser';
import { FormatSegmentBlock } from '../requirements/FormatSegmentBlock';
import { HtmlKnowledgeSection } from './HtmlKnowledgeSection';
import type { HtmlKnowledgeUploadController } from './useHtmlKnowledgeUpload';

interface TestGenConfigPanelProps {
  projectId: string;
  requirements: Requirement[];
  flowStories: Requirement[];
  htmlKnowledgeUpload: HtmlKnowledgeUploadController;
  onStart: (config: TestGenStartConfig) => void;
  disabled?: boolean;
  startPending?: boolean;
}

export interface TestGenStartConfig {
  name: string;
  requirementIds: string[];
  flowIds: string[];
  mode: 'auto' | 'interactive';
  providerConfigName: string;
  model?: string;
  modelName?: string;
  useCache?: boolean;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  referenceRunIds?: string[];
  htmlKnowledgeSetId?: string;
}

interface TreeNode {
  req: Requirement;
  children: TreeNode[];
  depth: number;
}

function buildTree(requirements: Requirement[]): TreeNode[] {
  // Only include epic and story levels (skip AC)
  const filtered = requirements.filter((r) => r.level === 'epic' || r.level === 'story');
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const req of filtered) {
    map.set(req.id, { req, children: [], depth: 0 });
  }
  for (const req of filtered) {
    const node = map.get(req.id)!;
    if (req.parentId && map.has(req.parentId)) {
      map.get(req.parentId)!.children.push(node);
    } else if (!req.parentId) {
      roots.push(node);
    }
  }
  function setDepth(nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      node.depth = depth;
      setDepth(node.children, depth + 1);
    }
  }
  setDepth(roots, 0);
  return roots;
}

function collectLeafIds(node: TreeNode): string[] {
  if (node.children.length === 0) return [node.req.id];
  return node.children.flatMap(collectLeafIds);
}

function collectExpandableIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      ids.push(node.req.id);
      ids.push(...collectExpandableIds(node.children));
    }
  }
  return ids;
}

const levelDotColors: Record<string, string> = {
  epic: 'bg-purple-500',
  story: 'bg-emerald-500',
};

function RequirementTreeNode({
  node,
  selectedIds,
  selectedFlowIds,
  onToggle,
  onToggleFlow,
  expandedIds,
  onToggleExpand,
  selectedStoryId,
  onSelectStory,
  prdDocMap,
}: {
  node: TreeNode;
  selectedIds: Set<string>;
  selectedFlowIds: Set<string>;
  onToggle: (ids: string[]) => void;
  onToggleFlow: (flowStoryId: string, referencedComponentStoryIds: string[]) => void;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  selectedStoryId: string | null;
  onSelectStory: (id: string | null) => void;
  prdDocMap?: Map<string, any>;
}) {
  const expanded = expandedIds.has(node.req.id);
  const hasChildren = node.children.length > 0;
  const allDescendantIds = hasChildren ? collectLeafIds(node) : [node.req.id];
  const isFlowStory = node.req.level === 'story' && node.req.isFlow;
  const isFlowSelected = isFlowStory && selectedFlowIds.has(node.req.id);

  // Aggregate selection state: flow stories check selectedFlowIds, others check selectedIds
  const allSelected = isFlowStory
    ? isFlowSelected
    : hasChildren
    ? node.children.every(child =>
        child.req.isFlow ? selectedFlowIds.has(child.req.id) : selectedIds.has(child.req.id)
      )
    : selectedIds.has(node.req.id);
  const someSelected = isFlowStory
    ? isFlowSelected
    : hasChildren
    ? node.children.some(child =>
        child.req.isFlow ? selectedFlowIds.has(child.req.id) : selectedIds.has(child.req.id)
      )
    : selectedIds.has(node.req.id);

  const labelRef = useRef<HTMLSpanElement>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const isSelected = node.req.id === selectedStoryId;

  const handleTitleMouseEnter = () => {
    if (labelRef.current && labelRef.current.scrollWidth > labelRef.current.clientWidth) {
      setShowTooltip(true);
    }
  };

  // For flow stories, the checkbox reflects flow selection state.
  // For epics and component stories, it reflects requirement selection.
  const checkboxChecked = allSelected;
  const checkboxIndeterminate = !allSelected && someSelected;

  return (
    <div className="space-y-px">
      <div
        className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-all duration-150 ${
          isSelected
            ? 'bg-blue-50 text-slate-900 border border-blue-200 shadow-sm'
            : isFlowSelected
            ? 'bg-purple-50/60 border border-purple-200'
            : someSelected
            ? 'bg-blue-50/50 border border-transparent'
            : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 border border-transparent'
        }`}
        style={{ paddingLeft: `${node.depth * 4 + 4}px` }}
        onClick={() => { onSelectStory(isSelected ? null : node.req.id); }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.req.id);
            }}
            className="shrink-0 -ml-1 p-1 hover:bg-slate-200/70 rounded-md transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-400" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <input
          type="checkbox"
          checked={checkboxChecked}
          ref={el => { if (el) el.indeterminate = checkboxIndeterminate; }}
          onChange={(e) => {
            e.stopPropagation();
            if (isFlowStory) {
              onToggleFlow(node.req.id, allDescendantIds.filter(id => id !== node.req.id));
            } else if (hasChildren) {
              // Epic: toggle each child by type (flow vs component)
              const componentChildIds = node.children
                .filter(c => !c.req.isFlow)
                .flatMap(c => collectLeafIds(c));
              const flowChildren = node.children.filter(c => c.req.isFlow);
              if (allSelected) {
                onToggle(componentChildIds);
                flowChildren.forEach(c => onToggleFlow(c.req.id, []));
              } else {
                onToggle(componentChildIds);
                flowChildren.forEach(c => {
                  if (!selectedFlowIds.has(c.req.id)) onToggleFlow(c.req.id, []);
                });
              }
            } else {
              onToggle(allDescendantIds);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className={`rounded focus:ring-2 shrink-0 ${
            isFlowStory
              ? 'border-purple-300 text-purple-600 focus:ring-purple-500/20'
              : 'border-slate-300 text-blue-600 focus:ring-blue-500/20'
          }`}
        />
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${levelDotColors[node.req.level] || 'bg-slate-400'}`}
        />
        {node.req.isFlow && (
          <>
            <GitBranch size={11} className="text-purple-500 shrink-0" />
            <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200 uppercase tracking-wider shrink-0">
              Flow
            </span>
          </>
        )}
        {node.req.documentId && (
          (() => {
            const doc = prdDocMap?.get(node.req.documentId);
            const tooltip = doc
              ? `PRD: ${doc.title}${doc.currentVersionTag ? ` (${doc.currentVersionTag})` : ''}${node.req.sourceAnchor ? ` · ${node.req.sourceAnchor}` : ''}`
              : (node.req.sourceAnchor ? `PRD: ${node.req.sourceAnchor}` : 'Linked to PRD document');
            return (
              <span title={tooltip} className="inline-flex items-center">
                <FileText size={11} className="text-blue-500/80 shrink-0" />
              </span>
            );
          })()
        )}
        <span
          ref={labelRef}
          className={`flex-1 min-w-0 truncate ${
            isSelected ? 'font-semibold text-[13px]' : 'font-medium text-sm'
          }`}
          title={showTooltip ? node.req.title : undefined}
          onMouseEnter={handleTitleMouseEnter}
        >
          {node.req.title}
        </span>
      </div>
      {expanded && hasChildren && (
        <div className="ml-2 pl-1 border-l border-slate-200">
          {node.children.map(child => (
            <RequirementTreeNode
              key={child.req.id}
              node={child}
              selectedIds={selectedIds}
              selectedFlowIds={selectedFlowIds}
              onToggle={onToggle}
              onToggleFlow={onToggleFlow}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              selectedStoryId={selectedStoryId}
              onSelectStory={onSelectStory}
              prdDocMap={prdDocMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const CONFIG_KEY = 'ai-test-gen-config';

interface SavedConfig {
  mode: 'auto' | 'interactive';
  showApprovedOnly: boolean;
  selectedModel: string;
  modelName: string;
  useCache: boolean;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
}

function loadConfig(): SavedConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveConfig(config: SavedConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

const defaultConfig: SavedConfig = {
  mode: 'auto',
  showApprovedOnly: true,
  selectedModel: '',
  modelName: '',
  useCache: false,
};

export function TestGenConfigPanel({
  projectId,
  requirements,
  flowStories,
  htmlKnowledgeUpload,
  onStart,
  disabled,
  startPending = false,
}: TestGenConfigPanelProps) {
  const startFeedbackId = useId();
  const { data: providerConfigs = [] } = useProviderConfigs();
  const { data: pastRuns = [] } = useTestGenRuns(projectId);
  const { data: prdDocs = [] } = usePrdDocuments(projectId);
  const prdDocMap = useMemo(() => {
    return new Map((prdDocs || []).map((doc: any) => [doc.id, doc]));
  }, [prdDocs]);
  const savedConfig = useMemo(() => loadConfig(), []);

  const [selectedReqs, setSelectedReqs] = useState<Set<string>>(new Set());
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [selectedDocIdFilter, setSelectedDocIdFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [referenceRunIds, setReferenceRunIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'auto' | 'interactive'>(savedConfig?.mode ?? defaultConfig.mode);
  const [showApprovedOnly, setShowApprovedOnly] = useState(savedConfig?.showApprovedOnly ?? defaultConfig.showApprovedOnly);

  // Note: requirement/flow selections are intentionally NOT restored from localStorage
  // to avoid silently carrying over selections across sessions (which caused
  // unexpected batch splitting when a previous run had a different epic selection).

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState(savedConfig?.selectedModel ?? defaultConfig.selectedModel);
  const [modelName, setModelName] = useState(savedConfig?.modelName ?? defaultConfig.modelName);
  const [modelOpen, setModelOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);
  // Build model options grouped by provider name, sorted alphabetically
  const modelGroups = useMemo(() => {
    const groups: { providerName: string; models: { model: string; providerName: string; providerType: string }[] }[] = [];
    for (const p of providerConfigs) {
      const models: string[] = p.models || [];
      if (models.length === 0) continue;
      groups.push({
        providerName: p.name,
        models: models.map(m => ({ model: m, providerName: p.name, providerType: p.type })),
      });
    }
    return groups.sort((a, b) => a.providerName.localeCompare(b.providerName));
  }, [providerConfigs]);
  const modelOptions = useMemo(() => modelGroups.flatMap(g => g.models), [modelGroups]);
  // Selected provider derived from selected model
  const selectedProvider = useMemo(() => {
    const opt = modelOptions.find(o => o.model === selectedModel);
    return opt?.providerName || '';
  }, [modelOptions, selectedModel]);
  const selectedProviderType = useMemo(() => {
    const opt = modelOptions.find(o => o.model === selectedModel);
    return opt?.providerType || '';
  }, [modelOptions, selectedModel]);
  // Auto-select first model from active provider
  useEffect(() => {
    if (!selectedModel && modelOptions.length > 0) {
      const active = providerConfigs.find((p: any) => p.isActive);
      if (active) {
        const firstModel = modelOptions.find(o => o.providerName === active.name);
        if (firstModel) {
          setSelectedModel(firstModel.model);
          setModelName(`${firstModel.model} (${firstModel.providerName})`);
        }
      } else if (modelOptions[0]) {
        setSelectedModel(modelOptions[0].model);
        setModelName(`${modelOptions[0].model} (${modelOptions[0].providerName})`);
      }
    }
  }, [modelOptions, selectedModel, providerConfigs]);
  const [useCache, setUseCache] = useState(savedConfig?.useCache ?? defaultConfig.useCache);
  const [reasoningEffort, setReasoningEffort] = useState(savedConfig?.reasoningEffort ?? '');
  const [reasoningSummary, setReasoningSummary] = useState(savedConfig?.reasoningSummary ?? '');
  const [textVerbosity, setTextVerbosity] = useState(savedConfig?.textVerbosity ?? '');

  useEffect(() => {
    saveConfig({
      mode, showApprovedOnly, selectedModel, modelName, useCache,
      reasoningEffort, reasoningSummary, textVerbosity,
    });
  }, [mode, showApprovedOnly, selectedModel, modelName, useCache, reasoningEffort, reasoningSummary, textVerbosity]);

  const filteredRequirements = useMemo(() => {
    let base = requirements;
    if (selectedDocIdFilter !== 'all') {
      const matchedIds = new Set<string>();
      if (selectedDocIdFilter.startsWith('doc:')) {
        const docId = selectedDocIdFilter.slice(4);
        requirements.filter((r) => r.documentId === docId).forEach((r) => matchedIds.add(r.id));
      } else if (selectedDocIdFilter.startsWith('ver:')) {
        const verId = selectedDocIdFilter.slice(4);
        requirements
          .filter((r) => r.documentVersionId === verId || (r.versionIds && r.versionIds.includes(verId)))
          .forEach((r) => matchedIds.add(r.id));
      } else {
        requirements.filter((r) => r.documentId === selectedDocIdFilter).forEach((r) => matchedIds.add(r.id));
      }

      // Trace ancestors up to root so hierarchy remains intact even if parent was from previous version
      const itemMap = new Map(requirements.map((i) => [i.id, i]));
      const matchedWithAncestors = new Set<string>(matchedIds);
      for (const id of matchedIds) {
        let curr = itemMap.get(id);
        while (curr && curr.parentId) {
          matchedWithAncestors.add(curr.parentId);
          curr = itemMap.get(curr.parentId);
        }
      }
      base = requirements.filter((r) => matchedWithAncestors.has(r.id));
    }

    const term = searchTerm.trim().toLowerCase();
    if (!term) return base;

    // Find direct matching IDs
    const directMatches = new Set<string>();
    for (const r of base) {
      if (
        r.title.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term) ||
        r.id.toLowerCase().includes(term)
      ) {
        directMatches.add(r.id);
      }
    }

    // Trace ancestors up to root so hierarchy remains intact
    const itemMap = new Map(requirements.map((i) => [i.id, i]));
    const matchedWithAncestors = new Set<string>(directMatches);
    for (const id of directMatches) {
      let curr = itemMap.get(id);
      while (curr && curr.parentId) {
        matchedWithAncestors.add(curr.parentId);
        curr = itemMap.get(curr.parentId);
      }
    }
    return base.filter((r) => matchedWithAncestors.has(r.id));
  }, [requirements, selectedDocIdFilter, searchTerm]);

  const isFiltering = Boolean(searchTerm.trim() || selectedDocIdFilter !== 'all');
  const tree = useMemo(() => buildTree(filteredRequirements), [filteredRequirements]);
  const expandableIds = useMemo(() => collectExpandableIds(tree), [tree]);
  const allExpanded = expandableIds.length > 0 && expandableIds.every(id => expandedIds.has(id));

  const handleToggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleExpandAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(expandableIds));
    }
  };

  // Auto-expand tree when filtering by PRD document or searching
  useEffect(() => {
    if (isFiltering && expandableIds.length > 0) {
      setExpandedIds(new Set(expandableIds));
    }
  }, [selectedDocIdFilter, searchTerm]);

  const completedRuns = useMemo(() => {
    return pastRuns.filter((r: any) => r.status === 'COMPLETED');
  }, [pastRuns]);

  const handleReqToggle = (ids: string[]) => {
    setSelectedReqs(prev => {
      const next = new Set(prev);
      const allSelected = ids.every(id => next.has(id));
      if (allSelected) {
        ids.forEach(id => next.delete(id));
      } else {
        ids.forEach(id => next.add(id));
      }
      return next;
    });
  };

  // Toggle a flow story: only add/remove it from selectedFlows.
  // Referenced component stories are resolved on the backend at orchestration
  // time so they don't spawn extra epic batches.
  const handleFlowToggle = (flowStoryId: string, _descendantIds: string[]) => {
    setSelectedFlows(prev => {
      const next = new Set(prev);
      if (next.has(flowStoryId)) {
        next.delete(flowStoryId);
      } else {
        next.add(flowStoryId);
      }
      return next;
    });
  };

  const handleReset = () => {
    void htmlKnowledgeUpload.reset();
    setMode(defaultConfig.mode);
    setShowApprovedOnly(defaultConfig.showApprovedOnly);
    setSelectedModel(defaultConfig.selectedModel);
    setModelName(defaultConfig.modelName);
    setUseCache(defaultConfig.useCache);
    setReasoningEffort('');
    setReasoningSummary('');
    setTextVerbosity('');
    setSelectedReqs(new Set());
    setSelectedFlows(new Set());
    setReferenceRunIds(new Set());
    setSelectedDocIdFilter('all');
    setSearchTerm('');
    setExpandedIds(new Set());
  };

  const handleStart = () => {
    const now = new Date();
    const defaultName = `TestGen_${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 5).replace(':', '-')}`;
    onStart({
      name: defaultName,
      requirementIds: Array.from(selectedReqs),
      flowIds: Array.from(selectedFlows),
      mode,
      providerConfigName: selectedProvider,
      model: selectedModel || undefined,
      modelName: modelName || undefined,
      useCache,
      reasoningEffort: reasoningEffort || undefined,
      reasoningSummary: reasoningSummary || undefined,
      textVerbosity: textVerbosity || undefined,
      referenceRunIds: Array.from(referenceRunIds),
      htmlKnowledgeSetId: htmlKnowledgeUpload.readySetId,
    });
  };

  const hasSelection = selectedReqs.size > 0 || selectedFlows.size > 0;
  const controlsDisabled = Boolean(disabled || startPending);
  const canStart = hasSelection
    && selectedProvider !== ''
    && !htmlKnowledgeUpload.isBlockingStart
    && !controlsDisabled;
  const startDisabledReason = startPending
    ? 'Test Gen start is in progress'
    : !hasSelection
    ? 'Select at least one requirement or flow'
    : selectedProvider === ''
    ? 'Select a model to continue'
    : htmlKnowledgeUpload.phase === 'invalid' || htmlKnowledgeUpload.phase === 'failed'
    ? 'Resolve HTML knowledge errors before starting'
    : htmlKnowledgeUpload.isBlockingStart
    ? 'Wait for HTML knowledge preparation to finish'
    : disabled
    ? 'A Test Gen run is already active'
    : null;

  return (
    <div className="h-full flex overflow-hidden bg-white">
      {/* Column 1: Requirements */}
      <div className="w-80 shrink-0 flex flex-col overflow-hidden border-r border-slate-100">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-50">
            <FileText size={14} className="text-blue-600" />
          </div>
          <h3 className="text-[13px] font-semibold text-slate-700">Requirements</h3>
          {selectedReqs.size > 0 && (
            <span className="text-[11px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
              {selectedReqs.size}
            </span>
          )}
          {selectedFlows.size > 0 && (
            <span className="text-[11px] font-semibold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
              {selectedFlows.size}
            </span>
          )}
        </div>
        <div className="flex-1 flex flex-col px-4 pt-3 pb-4 overflow-hidden">
          {/* Search and PRD Filter Dropdown */}
          <div className="space-y-1.5 mb-3">
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                size={14}
              />
              <input
                type="text"
                placeholder="Filter requirements..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-700"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Document & Version filter dropdown - only displayed when documents exist */}
            {prdDocs.length > 0 && (
              <div className="relative">
                <select
                  value={selectedDocIdFilter}
                  onChange={(e) => setSelectedDocIdFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 truncate cursor-pointer"
                  title="Filter requirements tree by PRD Document or Version"
                >
                  <option value="all">
                    All Documents &amp; Versions ({requirements.length} items)
                  </option>
                  {prdDocs.map((doc: any) => {
                    const docCount = requirements.filter((r) => r.documentId === doc.id).length;
                    const versions = doc.versions || [];
                    return (
                      <optgroup
                        key={doc.id}
                        label={`${doc.title} (${doc.currentVersionTag || 'v1.0'})`}
                      >
                        <option value={`doc:${doc.id}`}>
                          All Versions of &quot;{doc.title}&quot; ({docCount} items)
                        </option>
                        {versions.map((v: any) => {
                          const vCount = requirements.filter(
                            (r) => r.documentVersionId === v.id || (r.versionIds && r.versionIds.includes(v.id))
                          ).length;
                          return (
                            <option key={v.id} value={`ver:${v.id}`}>
                              └ {v.versionTag || `v${v.versionNumber}`} · {v.fileName} ({vCount} items)
                            </option>
                          );
                        })}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={(() => {
                  const componentStories = filteredRequirements.filter(r => r.level === 'story' && !r.isFlow);
                  const flowStoriesList = filteredRequirements.filter(r => r.level === 'story' && r.isFlow);
                  return componentStories.length + flowStoriesList.length > 0
                    && componentStories.every(r => selectedReqs.has(r.id))
                    && flowStoriesList.every(r => selectedFlows.has(r.id));
                })()}
                ref={el => {
                  if (el) {
                    const componentStories = filteredRequirements.filter(r => r.level === 'story' && !r.isFlow);
                    const flowStoriesList = filteredRequirements.filter(r => r.level === 'story' && r.isFlow);
                    const total = componentStories.length + flowStoriesList.length;
                    const selectedCount = componentStories.filter(r => selectedReqs.has(r.id)).length + flowStoriesList.filter(r => selectedFlows.has(r.id)).length;
                    el.indeterminate = selectedCount > 0 && selectedCount < total;
                  }
                }}
                onChange={() => {
                  const componentStories = filteredRequirements.filter(r => r.level === 'story' && !r.isFlow);
                  const flowStoriesList = filteredRequirements.filter(r => r.level === 'story' && r.isFlow);
                  const allComponentSelected = componentStories.every(r => selectedReqs.has(r.id));
                  const allFlowSelected = flowStoriesList.every(r => selectedFlows.has(r.id));
                  if (allComponentSelected && allFlowSelected) {
                    setSelectedReqs(prev => {
                      const next = new Set(prev);
                      componentStories.forEach(r => next.delete(r.id));
                      return next;
                    });
                    setSelectedFlows(prev => {
                      const next = new Set(prev);
                      flowStoriesList.forEach(r => next.delete(r.id));
                      return next;
                    });
                  } else {
                    setSelectedReqs(prev => {
                      const next = new Set(prev);
                      componentStories.forEach(r => next.add(r.id));
                      return next;
                    });
                    setSelectedFlows(prev => {
                      const next = new Set(prev);
                      flowStoriesList.forEach(r => next.add(r.id));
                      return next;
                    });
                  }
                }}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500/20"
              />
              <span>Select all</span>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleToggleExpandAll}
                className="flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-blue-600 px-2 py-1 rounded-md hover:bg-blue-50 transition-colors"
                title={allExpanded ? 'Collapse all' : 'Expand all'}
              >
                <ChevronsUpDown size={12} />
                <span>{allExpanded ? 'Collapse' : 'Expand'}</span>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto -mx-1 px-1">
            {tree.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                <FileText size={28} className="mb-2 opacity-40" />
                <p className="text-xs">
                  {isFiltering ? 'No matching requirements found' : 'No requirements found'}
                </p>
                {isFiltering && (
                  <button
                    onClick={() => {
                      setSearchTerm('');
                      setSelectedDocIdFilter('all');
                    }}
                    className="mt-2 text-[11px] text-blue-600 hover:text-blue-700 underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              tree.map(node => (
                <RequirementTreeNode
                  key={node.req.id}
                  node={node}
                  selectedIds={selectedReqs}
                  selectedFlowIds={selectedFlows}
                  onToggle={handleReqToggle}
                  onToggleFlow={handleFlowToggle}
                  expandedIds={expandedIds}
                  onToggleExpand={handleToggleExpand}
                  selectedStoryId={selectedStoryId}
                  onSelectStory={setSelectedStoryId}
                  prdDocMap={prdDocMap}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Column 2: Story / AC Detail */}
      {(() => {
        const selectedStory = selectedStoryId ? requirements.find(r => r.id === selectedStoryId) : null;
        const isEpic = selectedStory?.level === 'epic';
        const childStories = selectedStory ? requirements.filter(r => r.parentId === selectedStory.id && r.level === 'story').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : [];
        const storyAcs = selectedStory && !isEpic ? requirements.filter(r => r.parentId === selectedStory.id && r.level === 'ac').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : [];
        const parsedStory = selectedStory && !isEpic ? parseStoryMarkdown(selectedStory.description || '') : null;
        return (
          <div className="flex-1 flex flex-col overflow-hidden border-r border-slate-100">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
              <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-50">
                <FileText size={14} className="text-blue-600" />
              </div>
              <h3 className="text-[13px] font-semibold text-slate-700">
                {selectedStory ? selectedStory.title : 'Detail'}
              </h3>
              {selectedStory?.isFlow && (
                <span className="text-[9px] font-semibold text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">Flow</span>
              )}
              {selectedStory?.id && (
                <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{selectedStory.id}</span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
              {selectedStory ? (
                <div className="space-y-4">
                  {/* Metadata */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span>Level: <span className="font-medium text-slate-700">{selectedStory.level}</span></span>
                    <span>Status: <span className="font-medium text-slate-700">{selectedStory.status}</span></span>
                    {selectedStory.sourceAnchor && (
                      <span>Source: <span className="font-mono text-slate-700">{selectedStory.sourceAnchor}</span></span>
                    )}
                    {selectedStory.documentId && (
                      (() => {
                        const doc = prdDocMap.get(selectedStory.documentId);
                        return (
                          <span>
                            PRD Document: <span className="font-medium text-blue-600">{doc ? `${doc.title} (${doc.currentVersionTag || 'v1.0'})` : selectedStory.documentId}</span>
                          </span>
                        );
                      })()
                    )}
                  </div>
                  {/* Description */}
                  {selectedStory.description && (
                    <div>
                      <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Description</label>
                      {isEpic ? (
                        <div className="rounded-lg border border-slate-200 bg-slate-50/30 px-4 py-3 text-sm text-slate-700 leading-relaxed">
                          {selectedStory.description}
                        </div>
                      ) : (
                        <FormatSegmentBlock
                          variant="story"
                          segments={[
                            { label: 'As a', content: parsedStory?.role },
                            { label: 'I want', content: parsedStory?.action },
                            { label: 'So that', content: parsedStory?.value },
                          ]}
                          remainder={parsedStory?.remainder}
                        />
                      )}
                    </div>
                  )}
                  {/* Epic: child stories list */}
                  {isEpic && childStories.length > 0 && (
                    <div>
                      <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
                        Stories ({childStories.length})
                      </label>
                      <div className="space-y-1.5">
                        {childStories.map(s => (
                          <div key={s.id} className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm">
                            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${s.isFlow ? 'bg-purple-500' : 'bg-emerald-500'}`} />
                            <span className="font-medium text-slate-700 truncate flex-1 min-w-0">{s.title}</span>
                            {s.isFlow && (
                              <span className="text-[9px] font-semibold text-violet-600 bg-violet-50 border border-violet-200 px-1 py-0 rounded shrink-0">Flow</span>
                            )}
                            {s.id && (
                              <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{s.id}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Story: AC list */}
                  {!isEpic && (
                    <div>
                      <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
                        Acceptance Criteria ({storyAcs.length})
                      </label>
                      {storyAcs.length === 0 ? (
                        <div className="text-xs text-slate-400 italic">No ACs defined</div>
                      ) : (
                        <div className="space-y-2">
                          {storyAcs.map(ac => {
                            const parsedAc = parseACMarkdown(ac.description || '');
                            return (
                              <div key={ac.id} className="border border-slate-200 rounded-lg px-3 py-2.5 bg-white">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{ac.id || `AC-${(ac.position ?? 0) + 1}`}</span>
                                  <span className="text-xs font-medium text-slate-700 truncate">{ac.title}</span>
                                  {ac.flowType === 'flow' && (
                                    <span className="text-[9px] font-semibold text-violet-600 bg-violet-50 border border-violet-200 px-1 py-0 rounded shrink-0">Flow</span>
                                  )}
                                </div>
                                <FormatSegmentBlock
                                  variant="ac"
                                  segments={[
                                    { label: 'Given', content: parsedAc.given },
                                    { label: 'When', content: parsedAc.when },
                                    { label: 'Then', content: parsedAc.then },
                                  ]}
                                  remainder={parsedAc.remainder}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <FileText size={28} className="mb-2 opacity-40" />
                  <p className="text-xs">Select an item to view details</p>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Column 3: Settings */}
      <div className="w-96 flex flex-col bg-slate-50/50 shrink-0">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-slate-100">
            <Settings2 size={14} className="text-slate-600" />
          </div>
          <h3 className="text-[13px] font-semibold text-slate-700">Settings</h3>
          <button
            onClick={handleReset}
            disabled={controlsDisabled}
            className="ml-auto text-[11px] font-medium text-slate-600 hover:text-red-700 px-2 py-1 rounded-md hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Run Mode */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Run Mode</label>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden bg-white p-0.5">
              <button
                onClick={() => setMode('auto')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-all ${
                  mode === 'auto'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Zap size={13} />
                Auto
              </button>
              <button
                onClick={() => setMode('interactive')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-all ${
                  mode === 'interactive'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <CheckCircle size={13} />
                Interactive
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              {mode === 'auto' ? 'Run all stages automatically' : 'Pause at each checkpoint for review'}
            </p>
          </div>

          {/* Model */}
          <div className="relative" ref={modelDropdownRef}>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Model</label>
            <button
              onClick={() => setModelOpen(!modelOpen)}
              className="w-full flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white hover:border-slate-300 focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 transition-all"
            >
              <span className="text-slate-700">{selectedModel || 'Select a model'}</span>
              <ChevronDown size={14} className={`text-slate-400 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
            </button>
            {modelOpen && (
              <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {modelGroups.map(group => (
                  <div key={group.providerName}>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider bg-slate-50">{group.providerName}</div>
                    {group.models.map((o, i) => (
                      <button
                        key={`${o.providerName}-${o.model}-${i}`}
                        onClick={() => { setSelectedModel(o.model); setModelName(`${o.model} (${o.providerName})`); setModelOpen(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 transition-colors ${
                          selectedModel === o.model ? 'text-blue-600 font-medium bg-blue-50/50' : 'text-slate-700'
                        }`}
                      >
                        {o.model}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {modelOptions.length === 0 && (
              <p className="text-[11px] text-amber-600 mt-1.5">No models configured. Go to Settings &gt; AI Provider.</p>
            )}
          </div>

          {/* Model Options */}
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Reasoning Effort</label>
              <select
                value={reasoningEffort}
                onChange={e => setReasoningEffort(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10"
              >
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            {(selectedProviderType === 'azure-openai' || selectedProviderType === 'openai-responses') && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Reasoning Summary</label>
              <select
                value={reasoningSummary}
                onChange={e => setReasoningSummary(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10"
              >
                <option value="">Provider default</option>
                <option value="auto">Auto</option>
                <option value="detailed">Detailed</option>
                <option value="concise">Concise</option>
              </select>
            </div>
            )}
            {(selectedProviderType === 'azure-openai' || selectedProviderType === 'openai-responses') && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">Text Verbosity</label>
              <select
                value={textVerbosity}
                onChange={e => setTextVerbosity(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10"
              >
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            )}
          </div>

          <HtmlKnowledgeSection controller={htmlKnowledgeUpload} disabled={controlsDisabled} />

          {/* Reference Runs */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <History size={13} className="text-slate-500" />
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Reference Previous Runs</label>
                  {referenceRunIds.size > 0 && (
                    <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.2 rounded-full">
                      {referenceRunIds.size}
                    </span>
                  )}
                </div>
                {completedRuns.length > 0 && (
                  <div className="flex items-center gap-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => {
                        if (completedRuns.length > 0) {
                          setReferenceRunIds(new Set([completedRuns[0].id]));
                        }
                      }}
                      className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-1.5 py-0.5 rounded font-medium transition-colors"
                    >
                      Latest 1
                    </button>
                    {referenceRunIds.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setReferenceRunIds(new Set())}
                        className="text-slate-400 hover:text-red-500 hover:bg-red-50 px-1.5 py-0.5 rounded transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="border border-slate-200 rounded-lg bg-white overflow-hidden max-h-[96px] overflow-y-auto shadow-inner">
                {completedRuns.length === 0 ? (
                  <p className="text-[11px] text-slate-400 p-3 text-center">No completed runs available</p>
                ) : (
                  completedRuns.map((run: any) => (
                    <label
                      key={run.id}
                      className={`flex items-start gap-2.5 px-3 py-2 text-xs cursor-pointer border-b border-slate-100 last:border-0 transition-colors ${
                        referenceRunIds.has(run.id) ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={referenceRunIds.has(run.id)}
                        onChange={(e) => {
                          const next = new Set(referenceRunIds);
                          if (e.target.checked) next.add(run.id); else next.delete(run.id);
                          setReferenceRunIds(next);
                        }}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500/20 mt-0.5 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className={`truncate font-medium ${referenceRunIds.has(run.id) ? 'text-blue-900' : 'text-slate-700'}`} title={run.config?.name || run.id}>
                          {run.config?.name || run.id}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                          <span>{new Date(run.created_at).toLocaleString()}</span>
                          {run.total_batches > 0 && <span>• {run.total_batches} batch(es)</span>}
                        </div>
                      </div>
                    </label>
                  ))
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">Select previous runs to avoid generating duplicate test conditions.</p>
            </div>
          </div>

          {/* Options */}
          <div className="space-y-2.5 pt-2 border-t border-slate-100">
            <div className="flex items-start gap-2.5 text-xs p-2 rounded-lg bg-blue-50/40 border border-blue-100/60">
              <div className="flex-1">
                <span className="text-slate-700 font-medium">Dual test level (always on)</span>
                <p className="text-[11px] text-slate-500 mt-0.5">Every run produces both component-level and integration-level cases, tagged via <code className="text-[10px] bg-slate-100 px-1 rounded">testLevel</code>.</p>
              </div>
            </div>
            <label className="flex items-start gap-2.5 text-xs cursor-pointer group p-2 rounded-lg hover:bg-white transition-colors">
              <input
                type="checkbox"
                checked={!useCache}
                onChange={e => setUseCache(!e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500/20 mt-0.5"
              />
              <div className="flex-1">
                <span className="text-slate-700 font-medium group-hover:text-slate-900 transition-colors">Disable cache</span>
                <p className="text-[11px] text-slate-400 mt-0.5">Bypass cache for fresh LLM responses each run</p>
              </div>
            </label>
          </div>
        </div>

        {/* Start button */}
        <div className="p-4 border-t border-slate-100">
          <button
            onClick={handleStart}
            disabled={!canStart}
            aria-describedby={startDisabledReason ? startFeedbackId : undefined}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow disabled:shadow-none"
          >
            <Play size={16} fill="currentColor" />
            {startPending ? 'Starting Test Gen...' : 'Start Test Gen'}
          </button>
          {!canStart && startDisabledReason && (
            <p
              id={startFeedbackId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-[11px] text-slate-600 mt-1.5 text-center"
            >
              {startDisabledReason}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
