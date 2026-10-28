import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RequirementTree } from "./RequirementTree";
import { StoryDetailView } from "./StoryDetailView";
import { EpicDetailView } from "./EpicDetailView";
import { PrdImportModal } from "./PrdImportModal";
import { PrdDocumentsModal } from "./PrdDocumentsModal";
import { useRequirements, useRequirementMutations, usePrdDocuments } from "../../shared/hooks/useQueryHooks";
import { queryKeys } from "@/shared/hooks/queryKeys";
import type { Requirement, PrdDocument } from "../../../shared/contracts/index";
import {
  Upload,
  ListTree,
  RefreshCw,
  Search,
  ClipboardPaste,
  FileText,
  ChevronsUpDown,
  FolderOpen,
  LayoutDashboard,
  Plus,
} from "lucide-react";
import { HelpTooltip } from "@/shared/ui/HelpTooltip";

interface Props {
  currentProjectId?: string;
}

export function RequirementsPage({ currentProjectId }: Props) {
  const queryClient = useQueryClient();
  const projectId = currentProjectId || "";

  const {
    data: items = [],
    isLoading: loading,
    refetch: refresh,
  } = useRequirements(projectId);
  const { create: _create, update: _update, remove: _remove } = useRequirementMutations(projectId);
  const { data: prdDocs = [] } = usePrdDocuments(projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showDocumentsModal, setShowDocumentsModal] = useState(false);
  const [selectedDocIdFilter, setSelectedDocIdFilter] = useState<string>("all");
  const [documentToUpdate, setDocumentToUpdate] = useState<PrdDocument | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [leftWidth, setLeftWidth] = useState(320);
  const [clipboard, setClipboard] = useState<Requirement | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const isDragging = useRef(false);
  const hasInitializedRef = useRef(false);
  const minWidth = 80;
  const maxWidth = 600;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = leftWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        setLeftWidth(newWidth);
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [leftWidth]
  );

  // Auto-expand epics once on initial load (without overriding user's manual folding on subsequent mutations)
  useEffect(() => {
    if (items.length > 0 && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      const epics = items.filter((r) => r.level === "epic").map((r) => r.id);
      setExpandedIds(new Set(epics));
    }
  }, [items]);

  // Clean stale document/version filter if selected document was deleted
  useEffect(() => {
    if (selectedDocIdFilter !== "all") {
      if (selectedDocIdFilter.startsWith("doc:")) {
        const docId = selectedDocIdFilter.slice(4);
        if (!prdDocs.some((d) => d.id === docId)) setSelectedDocIdFilter("all");
      } else if (selectedDocIdFilter.startsWith("ver:")) {
        const verId = selectedDocIdFilter.slice(4);
        const versionExists = prdDocs.some((d) =>
          d.versions ? d.versions.some((v) => v.id === verId) : true
        );
        if (!versionExists) setSelectedDocIdFilter("all");
      } else if (!prdDocs.some((d) => d.id === selectedDocIdFilter)) {
        setSelectedDocIdFilter("all");
      }
    }
  }, [prdDocs, selectedDocIdFilter]);

  const selected = items.find((r) => r.id === selectedId) || null;

  const siblings = (parentId: string | null) =>
    items.filter((r) => (r.parentId || null) === parentId).sort((a, b) => a.position - b.position);

  const reorderRequirement = async (parentId: string | null, fromId: string, toId: string) => {
    if (fromId === toId) return;
    const sibs = siblings(parentId);
    const fromIdx = sibs.findIndex((s) => s.id === fromId);
    const toIdx = sibs.findIndex((s) => s.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const moved = sibs.splice(fromIdx, 1)[0];
    sibs.splice(toIdx, 0, moved);
    const updates = sibs.map((s, i) => _update(s.id, { position: i }));
    await Promise.all(updates);
    refresh();
  };

  const copyRequirement = (id: string) => {
    const req = items.find((r) => r.id === id);
    if (!req) return;
    setClipboard(JSON.parse(JSON.stringify(req)));
  };

  const levelProgression: Record<Requirement["level"], Requirement["level"]> = {
    epic: "story",
    story: "ac",
    ac: "ac",
  };

  // Safe paste: strips source document traceability and forces DRAFT
  const pasteRequirement = async (parentId: string | null) => {
    if (!clipboard) return;
    const sibs = siblings(parentId);
    const nextPosition = sibs.length > 0 ? Math.max(...sibs.map((s) => s.position)) + 1 : 0;
    const pasteLevel = parentId
      ? levelProgression[items.find((r) => r.id === parentId)?.level ?? "story"]
      : "epic";

    const { documentId, documentVersionId, sourceAnchor, ...rest } = clipboard;
    const newId = `req-${Date.now()}`;
    await _create({
      ...rest,
      id: newId,
      projectId,
      title: `${clipboard.title} (Copy)`,
      parentId,
      position: nextPosition,
      level: pasteLevel,
      status: "DRAFT",
      documentId: null,
      documentVersionId: null,
      sourceAnchor: null,
    });
    setClipboard(null);
    refresh();
    setSelectedId(newId);
  };

  // From-scratch creation workflows
  const handleCreateEpic = async () => {
    const epics = items.filter((r) => r.level === "epic");
    const nextPosition = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    const newId = `req-${Date.now()}`;
    await _create({
      id: newId,
      projectId,
      title: `New Epic ${epics.length + 1}`,
      description: "",
      level: "epic",
      status: "DRAFT",
      position: nextPosition,
      parentId: null,
    });
    refresh();
    setSelectedId(newId);
    setExpandedIds((prev) => new Set([...prev, newId]));
  };

  const handleCreateStory = async (epicId: string) => {
    const stories = items.filter((r) => r.parentId === epicId);
    const nextPosition = stories.length > 0 ? Math.max(...stories.map((s) => s.position)) + 1 : 0;
    const newId = `req-${Date.now()}`;
    await _create({
      id: newId,
      projectId,
      title: `New Story ${stories.length + 1}`,
      description: "As a [role], I want [feature] so that [benefit].",
      level: "story",
      status: "DRAFT",
      position: nextPosition,
      parentId: epicId,
    });
    refresh();
    setSelectedId(newId);
    setExpandedIds((prev) => new Set([...prev, epicId]));
  };

  // Hierarchical search: preserves ancestor chain so matching stories render inside their parent epics
  const filteredItems = useMemo(() => {
    let base = items;
    if (selectedDocIdFilter !== "all") {
      const matchedIds = new Set<string>();
      if (selectedDocIdFilter.startsWith("doc:")) {
        const docId = selectedDocIdFilter.slice(4);
        items.filter((r) => r.documentId === docId).forEach((r) => matchedIds.add(r.id));
      } else if (selectedDocIdFilter.startsWith("ver:")) {
        const verId = selectedDocIdFilter.slice(4);
        items
          .filter((r) => r.documentVersionId === verId || (r.versionIds && r.versionIds.includes(verId)))
          .forEach((r) => matchedIds.add(r.id));
      } else {
        items.filter((r) => r.documentId === selectedDocIdFilter).forEach((r) => matchedIds.add(r.id));
      }

      // Trace ancestors up to root so hierarchy remains intact even if parent was from previous version
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const matchedWithAncestors = new Set<string>(matchedIds);
      for (const id of matchedIds) {
        let curr = itemMap.get(id);
        while (curr && curr.parentId) {
          matchedWithAncestors.add(curr.parentId);
          curr = itemMap.get(curr.parentId);
        }
      }
      base = items.filter((r) => matchedWithAncestors.has(r.id));
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
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const matchedWithAncestors = new Set<string>(directMatches);

    for (const id of directMatches) {
      let curr = itemMap.get(id);
      while (curr && curr.parentId) {
        matchedWithAncestors.add(curr.parentId);
        curr = itemMap.get(curr.parentId);
      }
    }

    return items.filter((r) => matchedWithAncestors.has(r.id));
  }, [items, selectedDocIdFilter, searchTerm]);

  // Auto-expand ancestors when searching so matched items are immediately visible
  useEffect(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return;

    const itemMap = new Map(items.map((i) => [i.id, i]));
    const toExpand = new Set<string>();

    for (const r of items) {
      if (
        r.title.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term) ||
        r.id.toLowerCase().includes(term)
      ) {
        let curr = itemMap.get(r.id);
        while (curr && curr.parentId) {
          toExpand.add(curr.parentId);
          curr = itemMap.get(curr.parentId);
        }
        if (r.level === "epic") {
          toExpand.add(r.id);
        }
      }
    }

    if (toExpand.size > 0) {
      setExpandedIds((prev) => new Set([...prev, ...toExpand]));
    }
  }, [searchTerm, items]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllEpics = () => {
    const epicIds = items.filter((r) => r.level === "epic").map((r) => r.id);
    const allExpanded = epicIds.every((id) => expandedIds.has(id));
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(epicIds));
    }
  };

  const filteredStories = filteredItems.filter((r) => r.level === "story").length;
  const filteredEpics = filteredItems.filter((r) => r.level === "epic").length;
  const filteredAcs = filteredItems.filter((r) => r.level === "ac").length;
  const isFiltered = Boolean(searchTerm.trim() || selectedDocIdFilter !== "all");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-3.5rem)] text-slate-400">
        <RefreshCw className="animate-spin mr-2" size={16} />
        <span>Loading requirements...</span>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] bg-white overflow-hidden select-none">
      {/* Left panel: Requirements Tree & Controls */}
      <div
        style={{ width: `${leftWidth}px` }}
        className="flex flex-col border-r border-slate-200 bg-white shrink-0 relative"
      >
        <div className="p-3 border-b border-slate-100 space-y-3 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <h2
              className="text-sm font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5 cursor-pointer hover:text-blue-600 transition-colors"
              onClick={() => setSelectedId(null)}
              title="Return to PRD & Requirements Overview"
            >
              <ListTree size={14} />
              Requirements
              <HelpTooltip content="Organize requirements in a tree hierarchy. Click a requirement to view or edit its details." />
            </h2>
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setSelectedId(null)}
                className={`p-1 rounded-md transition-colors ${
                  !selectedId
                    ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                    : "text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                }`}
                title="PRD & Requirements Overview"
                aria-label="Overview"
              >
                <LayoutDashboard size={14} />
              </button>
              <button
                onClick={() => {
                  setIsRefreshing(true);
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.requirements,
                  });
                  setTimeout(() => setIsRefreshing(false), 500);
                }}
                className="text-slate-400 hover:text-blue-600 p-1 rounded-md hover:bg-blue-50 transition-colors"
                title="Refresh"
                aria-label="Refresh requirements"
              >
                <RefreshCw
                  size={14}
                  className={isRefreshing ? "animate-spin" : ""}
                />
              </button>
              <button
                onClick={toggleAllEpics}
                className="text-slate-400 hover:text-blue-600 p-1 rounded-md hover:bg-blue-50 transition-colors"
                title={
                  items.filter((r) => r.level === "epic").every((r) => expandedIds.has(r.id))
                    ? "Collapse All Epics"
                    : "Expand All Epics"
                }
                aria-label="Toggle all epics"
              >
                <ChevronsUpDown size={14} />
              </button>
              <button
                onClick={() => setShowDocumentsModal(true)}
                className="text-slate-400 hover:text-blue-600 p-1 rounded-md hover:bg-blue-50 transition-colors relative"
                title={`PRD Document Library (${prdDocs.length})`}
                aria-label="PRD Document Library"
              >
                <FolderOpen size={14} />
                {prdDocs.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                )}
              </button>
              <button
                onClick={() => {
                  setDocumentToUpdate(null);
                  setShowImport(true);
                }}
                className="text-slate-400 hover:text-blue-600 p-1 rounded-md hover:bg-blue-50 transition-colors"
                title="Import PRD Document (AI)"
                aria-label="Import PRD Document"
              >
                <Upload size={14} />
              </button>
              <button
                onClick={() => pasteRequirement(null)}
                disabled={!clipboard}
                className={`p-1 rounded-md transition-colors ${
                  clipboard
                    ? "text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                    : "text-slate-300 cursor-not-allowed"
                }`}
                title="Paste as Root Requirement"
                aria-label="Paste as Root Requirement"
              >
                <ClipboardPaste size={14} />
              </button>
              <button
                onClick={handleCreateEpic}
                className="flex items-center gap-1 px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow-xs transition-colors ml-1"
                title="Create New Epic"
                aria-label="Create New Epic"
              >
                <Plus size={12} />
                <span>Epic</span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
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
                    All Documents &amp; Versions ({items.length} items)
                  </option>
                  {prdDocs.map((doc) => {
                    const docCount = items.filter((r) => r.documentId === doc.id).length;
                    const versions = doc.versions || [];
                    return (
                      <optgroup
                        key={doc.id}
                        label={`${doc.title} (${doc.currentVersionTag || "v1.0"})`}
                      >
                        <option value={`doc:${doc.id}`}>
                          All Versions of &quot;{doc.title}&quot; ({docCount} items)
                        </option>
                        {versions.map((v) => {
                          const vCount = items.filter(
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
        </div>

        {/* Tree Container */}
        <div
          className="flex-1 overflow-y-auto px-2 py-3"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedId(null);
            }
          }}
        >
          {filteredItems.length === 0 && (
            <div className="text-center py-10 px-4">
              <ListTree size={36} className="mx-auto text-slate-300 mb-3" />
              <p className="text-sm font-semibold text-slate-700">
                {searchTerm ? "No matching requirements" : "No requirements yet"}
              </p>
              <p className="text-xs text-slate-400 mt-1 mb-4">
                {searchTerm
                  ? `No requirements match "${searchTerm}". Try a different term or clear the filter.`
                  : "Create your first epic to start structuring test requirements, or import a PRD."}
              </p>
              {!searchTerm && (
                <div className="flex flex-col gap-2 max-w-[200px] mx-auto">
                  <button
                    onClick={handleCreateEpic}
                    className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                  >
                    <Plus size={14} /> New Epic
                  </button>
                  <button
                    onClick={() => {
                      setDocumentToUpdate(null);
                      setShowImport(true);
                    }}
                    className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-semibold rounded-lg shadow-sm transition-colors"
                  >
                    <Upload size={14} /> Import PRD (AI)
                  </button>
                </div>
              )}
            </div>
          )}
          <RequirementTree
            items={filteredItems}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id || null)}
            projectId={projectId}
            onRefresh={refresh}
            onReorder={reorderRequirement}
            onCopy={copyRequirement}
            onPaste={pasteRequirement}
            onAddChild={handleCreateStory}
            clipboardExists={!!clipboard}
            expandedIds={expandedIds}
            onToggleExpand={toggleExpand}
          />
        </div>

        {/* Bottom statistics bar */}
        <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/50">
          <p className="text-[10px] text-slate-400 text-center font-mono">
            {filteredStories} stories · {filteredEpics} epics · {filteredAcs} ACs
            {isFiltered && ` (${filteredItems.length} of ${items.length} total)`}
          </p>
        </div>
      </div>

      {/* Resize Handle */}
      <div
        className="w-1.5 cursor-col-resize shrink-0 relative -ml-0.5 z-10 group"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px rounded-full group-hover:w-[2px] group-hover:bg-blue-400 transition-all" />
      </div>

      {/* Right panel: Detail View / Overview */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {!selected && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50 h-full p-8">
            <div className="max-w-md w-full text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-white shadow-xs border border-slate-200 flex items-center justify-center mx-auto text-blue-600">
                <FileText size={32} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-800">
                  Select a Requirement
                </h3>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                  Select a story or epic from the tree on the left to view details and PRD traceability anchors, or manage PRD documents using the toolbar.
                </p>
              </div>
              <div className="flex items-center justify-center gap-2.5 pt-2">
                <button
                  onClick={handleCreateEpic}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                >
                  <Plus size={14} />
                  <span>Create Epic</span>
                </button>
                <button
                  onClick={() => {
                    setDocumentToUpdate(null);
                    setShowImport(true);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-semibold shadow-xs transition-colors"
                >
                  <Upload size={14} />
                  <span>Import PRD (AI)</span>
                </button>
                <button
                  onClick={() => setShowDocumentsModal(true)}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-semibold shadow-xs transition-colors"
                >
                  <FolderOpen size={14} className="text-slate-500" />
                  <span>PRD Library ({prdDocs.length})</span>
                </button>
              </div>
            </div>
          </div>
        )}
        {selected?.level === "story" && (
          <StoryDetailView
            story={selected}
            acs={items.filter((r) => r.parentId === selected.id && r.level === "ac")}
            projectId={projectId}
            onSaved={() => refresh()}
            onClose={() => setSelectedId(null)}
          />
        )}
        {selected?.level === "epic" && (
          <EpicDetailView
            epic={selected}
            projectId={projectId}
            onSaved={() => refresh()}
            onClose={() => setSelectedId(null)}
            onSelectStory={(id) => setSelectedId(id)}
            onCreateStory={handleCreateStory}
          />
        )}
      </div>

      {/* Modals */}
      <PrdImportModal
        projectId={projectId}
        isOpen={showImport}
        onClose={() => {
          setShowImport(false);
          setDocumentToUpdate(null);
        }}
        onImported={refresh}
        initialDocumentToUpdate={documentToUpdate}
      />

      <PrdDocumentsModal
        projectId={projectId}
        isOpen={showDocumentsModal}
        onClose={() => setShowDocumentsModal(false)}
        onUploadNewVersion={(doc) => {
          setDocumentToUpdate(doc);
          setShowImport(true);
        }}
        onNewPrd={() => {
          setDocumentToUpdate(null);
          setShowImport(true);
        }}
      />
    </div>
  );
}