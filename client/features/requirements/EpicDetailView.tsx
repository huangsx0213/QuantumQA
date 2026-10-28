import React, { useState, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Save,
  Edit3,
  Eye,
  Check,
  X,
  Pencil,
  ArrowLeft,
  Plus,
  GitBranch,
  ChevronRight,
  CheckCircle2,
  ListTree,
  FileText,
} from "lucide-react";
import type { Requirement } from "../../../shared/contracts/index";
import { useRequirementMutations, useRequirements, usePrdDocuments } from "../../shared/hooks/useQueryHooks";

interface Props {
  epic: Requirement;
  projectId: string;
  onSaved: () => void;
  onClose?: () => void;
  onSelectStory?: (storyId: string) => void;
  onCreateStory?: (epicId: string) => void;
}

export function EpicDetailView({
  epic,
  projectId,
  onSaved,
  onClose,
  onSelectStory,
  onCreateStory,
}: Props) {
  const { update, updateId } = useRequirementMutations(projectId);
  const { data: allItems = [] } = useRequirements(projectId);
  const { data: prdDocs = [] } = usePrdDocuments(projectId);
  const prdDoc = prdDocs.find((d) => d.id === epic.documentId);
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description);
  const [idDraft, setIdDraft] = useState(epic.id);
  const [idEditing, setIdEditing] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");

  useEffect(() => {
    setTitle(epic.title);
    setDescription(epic.description);
    setIdDraft(epic.id);
    setIdEditing(false);
    setShowPreview(true);
    setSaveStatus("idle");
  }, [epic.id, epic.title, epic.description]);

  const idCollides = useMemo(() => {
    if (!idEditing) return false;
    if (idDraft === epic.id) return false;
    return allItems.some((r) => r.id === idDraft);
  }, [idEditing, idDraft, epic.id, allItems]);

  const idDirty = idDraft !== epic.id;

  const isDirty = useMemo(() => {
    return title !== epic.title || description !== (epic.description || "");
  }, [title, description, epic]);

  // Aggregate metrics
  const childStories = useMemo(() => {
    return allItems
      .filter((r) => r.parentId === epic.id && r.level === "story")
      .sort((a, b) => a.position - b.position);
  }, [allItems, epic.id]);

  const childStoryIds = useMemo(() => new Set(childStories.map((s) => s.id)), [childStories]);

  const allEpicAcs = useMemo(() => {
    return allItems.filter(
      (r) => r.parentId && childStoryIds.has(r.parentId) && r.level === "ac"
    );
  }, [allItems, childStoryIds]);

  const approvedAcs = useMemo(
    () => allEpicAcs.filter((r) => r.status === "APPROVED"),
    [allEpicAcs]
  );

  const approvalRate = allEpicAcs.length > 0
    ? Math.round((approvedAcs.length / allEpicAcs.length) * 100)
    : 0;

  const handleSafeClose = () => {
    if (isDirty) {
      if (
        window.confirm(
          "You have unsaved changes in this Epic. Discard changes and return to overview?"
        )
      ) {
        onClose?.();
      }
    } else {
      onClose?.();
    }
  };

  const handleSaveId = async () => {
    if (!idDirty || idCollides || !idDraft.trim() || saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      await updateId(epic.id, idDraft.trim());
      setSaveStatus("success");
      setIdEditing(false);
      setTimeout(() => setSaveStatus("idle"), 2000);
      onSaved();
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      await update(epic.id, {
        title,
        description,
      });
      setSaveStatus("success");
      setShowPreview(true);
      setTimeout(() => setSaveStatus("idle"), 2000);
      onSaved();
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white overflow-y-auto">
      {/* Header section */}
      <div className="shrink-0 max-w-5xl mx-auto w-full px-8 pt-6 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-2 mb-3 text-xs flex-wrap">
          {onClose && (
            <>
              <button
                onClick={handleSafeClose}
                className="flex items-center gap-1 text-slate-500 hover:text-blue-600 px-2 py-0.5 rounded-md hover:bg-blue-50 transition-colors font-medium border border-slate-200 hover:border-blue-200 mr-1 cursor-pointer"
                title="Return to PRD & Requirements Overview"
              >
                <ArrowLeft size={12} />
                <span>Overview</span>
              </button>
              <span className="text-slate-300">·</span>
            </>
          )}
          <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 uppercase tracking-wider">
            Epic
          </span>
          {epic.documentId && (
            <>
              <span className="text-slate-300">·</span>
              <span
                className="text-[10.5px] font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"
                title={epic.sourceAnchor || undefined}
              >
                <FileText size={11} className="text-blue-500" />
                PRD: {prdDoc?.title || "Document"} {prdDoc?.currentVersionTag ? `(${prdDoc.currentVersionTag})` : ""}
                {epic.sourceAnchor ? ` · ${epic.sourceAnchor}` : ""}
              </span>
            </>
          )}
          {isDirty && (
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Unsaved changes
            </span>
          )}
        </div>

        <div className="flex items-start gap-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Epic title..."
            className="flex-1 min-w-0 text-2xl font-bold text-slate-900 bg-transparent border-none outline-none placeholder-slate-300 tracking-tight p-0"
          />
          <div className="flex items-center gap-2 shrink-0 pt-1">
            {saveStatus === "saving" && <span className="text-xs text-slate-500 animate-pulse">Saving...</span>}
            {saveStatus === "success" && (
              <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                <Check size={14} /> Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                <X size={14} /> Failed
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={!title.trim() || saveStatus === "saving"}
              className={`flex items-center gap-2 px-4 py-2 text-white text-sm font-medium rounded-md transition-colors shadow-sm ${
                !title.trim() || saveStatus === "saving"
                  ? "bg-blue-400 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              <Save size={16} /> Save
            </button>
            {onClose && (
              <button
                onClick={handleSafeClose}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                title="Close and return to overview"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        {/* ID editing */}
        <div className="flex items-center gap-2 mt-4">
          <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            ID
          </label>
          {idEditing ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={idDraft}
                autoFocus
                onChange={(e) => setIdDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveId();
                  if (e.key === "Escape") {
                    setIdDraft(epic.id);
                    setIdEditing(false);
                  }
                }}
                className={`font-mono bg-slate-50 border rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:ring-2 focus:ring-blue-500/20 outline-none w-56 ${
                  idCollides ? "border-red-300 focus:border-red-500" : "border-slate-200 focus:border-blue-500"
                }`}
              />
              <button
                onClick={handleSaveId}
                disabled={!idDirty || idCollides || !idDraft.trim() || saveStatus === "saving"}
                className="p-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                title="Save new ID"
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => {
                  setIdDraft(epic.id);
                  setIdEditing(false);
                }}
                className="p-1 text-slate-400 hover:bg-slate-100 rounded"
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5">
                {epic.id}
              </span>
              <button
                onClick={() => setIdEditing(true)}
                className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                title="Edit ID (cascades to children and references)"
              >
                <Pencil size={12} />
              </button>
            </div>
          )}
          {idCollides && (
            <span className="text-[11px] text-red-600">ID already in use</span>
          )}
          {idEditing && idDirty && !idCollides && (
            <span className="text-[11px] text-amber-600">
              Renaming cascades to children &amp; references
            </span>
          )}
        </div>
      </div>

      {/* Aggregate metrics bar */}
      <div className="shrink-0 max-w-5xl mx-auto w-full px-8 py-4 bg-slate-50/70 border-b border-slate-200">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Child Stories
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-xl font-bold text-slate-800">{childStories.length}</span>
              <span className="text-xs text-slate-500">stories under this epic</span>
            </div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Acceptance Criteria
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-xl font-bold text-slate-800">{allEpicAcs.length}</span>
              <span className="text-xs text-slate-500">total criteria defined</span>
            </div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Approval Progress
              </span>
              <span className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                <CheckCircle2 size={12} />
                {approvedAcs.length} / {allEpicAcs.length} ({approvalRate}%)
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2 mt-2.5 overflow-hidden">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${approvalRate}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main content body: Description + Child Stories Dashboard */}
      <div className="max-w-5xl mx-auto w-full px-8 py-6 space-y-8 flex-1">
        {/* Description section */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Description &amp; Objective
            </label>
            <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setShowPreview(false)}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  !showPreview ? "bg-white text-slate-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Edit3 size={12} /> Edit
              </button>
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  showPreview ? "bg-white text-slate-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Eye size={12} /> Preview
              </button>
            </div>
          </div>
          {showPreview ? (
            <div className="markdown-body min-h-[90px] border border-slate-200 bg-slate-50/30 rounded-lg px-4 py-3 text-sm text-slate-700 leading-relaxed [&_p]:mb-2 [&_p:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {description || "*No description provided*"}
              </ReactMarkdown>
            </div>
          ) : (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none placeholder-slate-300 resize-none"
              placeholder="Describe the business objective of this epic. Provides AI context for downstream story generation."
            />
          )}
        </div>

        {/* Child Stories List Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-800">
                Stories in this Epic
              </h3>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                {childStories.length}
              </span>
            </div>
            {onCreateStory && (
              <button
                onClick={() => onCreateStory(epic.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                title="Add a new story under this epic"
              >
                <Plus size={14} /> Add Story
              </button>
            )}
          </div>

          {childStories.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center bg-slate-50/50">
              <ListTree size={28} className="mx-auto text-slate-300 mb-2" />
              <p className="text-sm font-medium text-slate-600">No stories in this epic yet</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                Break this epic down into actionable user stories to generate targeted test cases.
              </p>
              {onCreateStory && (
                <button
                  onClick={() => onCreateStory(epic.id)}
                  className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                >
                  <Plus size={14} /> Add First Story
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {childStories.map((story) => {
                const storyAcs = allItems.filter(
                  (r) => r.parentId === story.id && r.level === "ac"
                );
                const approvedCount = storyAcs.filter((ac) => ac.status === "APPROVED").length;

                return (
                  <div
                    key={story.id}
                    onClick={() => onSelectStory?.(story.id)}
                    className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-all cursor-pointer group bg-white shadow-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-slate-800 truncate group-hover:text-blue-700">
                            {story.title}
                          </span>
                          {story.isFlow && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200 uppercase flex items-center gap-0.5 shrink-0">
                              <GitBranch size={10} /> Flow
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-slate-400 font-mono">
                          {story.id} · {storyAcs.length} AC{storyAcs.length === 1 ? "" : "s"}
                          {storyAcs.length > 0 && ` (${approvedCount} approved)`}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded border uppercase tracking-wider ${
                          story.status === "APPROVED"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : story.status === "DRAFT"
                            ? "bg-slate-100 text-slate-500 border-slate-200"
                            : "bg-slate-200 text-slate-600 border-slate-300"
                        }`}
                      >
                        {story.status || "DRAFT"}
                      </span>
                      <ChevronRight
                        size={16}
                        className="text-slate-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
