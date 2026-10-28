import React, { useState, useEffect, useMemo } from "react";
import { Save, Edit3, Eye, AlertTriangle, Check, X, GitBranch, Pencil, FileText, ArrowLeft } from "lucide-react";
import type { Requirement } from "../../../shared/contracts/index";
import { useRequirementMutations, useRequirements, usePrdDocuments } from "../../shared/hooks/useQueryHooks";
import { parseStoryMarkdown } from "../../shared/requirements/format-parser";
import { StoryFormatHelpTooltip } from "./StoryFormatHelpTooltip";
import { ACList } from "./ACList";
import { FormatSegmentBlock } from "./FormatSegmentBlock";
import { HelpTooltip } from "@/shared/ui/HelpTooltip";

interface Props {
  story: Requirement;
  acs: Requirement[];
  projectId: string;
  onSaved: () => void;
  onClose?: () => void;
}

const statusOptions: { value: Requirement["status"]; label: string }[] = [
  { value: "DRAFT", label: "Draft" },
  { value: "APPROVED", label: "Approved" },
  { value: "DEPRECATED", label: "Deprecated" },
];

export function StoryDetailView({ story, acs, projectId, onSaved, onClose }: Props) {
  const { update, updateId } = useRequirementMutations(projectId);
  const { data: allItems = [] } = useRequirements(projectId);
  const { data: prdDocs = [] } = usePrdDocuments(projectId);
  const prdDoc = prdDocs.find((d) => d.id === story.documentId);
  const [idDraft, setIdDraft] = useState(story.id);
  const [idEditing, setIdEditing] = useState(false);
  const [title, setTitle] = useState(story.title);
  const [description, setDescription] = useState(story.description);
  const [status, setStatus] = useState<Requirement["status"]>(story.status);
  const [isFlow, setIsFlow] = useState<boolean>(story.isFlow ?? false);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  useEffect(() => {
    setTitle(story.title);
    setDescription(story.description);
    setStatus(story.status);
    setIsFlow(story.isFlow ?? false);
    setIdDraft(story.id);
    setIdEditing(false);
    setMode("preview");
    setSaveStatus("idle");
  }, [story.id, story.title, story.description, story.status, story.isFlow]);

  const parsed = parseStoryMarkdown(description);
  const isEmpty = !description.trim();
  const showWarning = !isEmpty && !parsed.hasAllSegments;

  const epic = allItems.find((r) => r.id === story.parentId);

  // ID uniqueness check (case-sensitive) across the current project.
  const idCollides = useMemo(() => {
    if (!idEditing) return false;
    if (idDraft === story.id) return false;
    return allItems.some((r) => r.id === idDraft);
  }, [idEditing, idDraft, story.id, allItems]);

  const idDirty = idDraft !== story.id;

  const handleSaveId = async () => {
    if (!idDirty || idCollides || !idDraft.trim() || saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      await updateId(story.id, idDraft.trim());
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
      await update(story.id, {
        title,
        description,
        status,
        isFlow,
      });
      setSaveStatus("success");
      setMode("preview");
      setTimeout(() => setSaveStatus("idle"), 2000);
      onSaved();
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const isDirty = useMemo(() => {
    return (
      title !== story.title ||
      description !== (story.description || "") ||
      status !== (story.status || "DRAFT") ||
      isFlow !== Boolean(story.isFlow)
    );
  }, [title, description, status, isFlow, story]);

  const handleSafeClose = () => {
    if (isDirty) {
      if (window.confirm("You have unsaved changes in this Story. Discard changes and return to overview?")) {
        onClose?.();
      }
    } else {
      onClose?.();
    }
  };

  return (
    <div className="bg-white h-full flex flex-col min-h-0 relative">
      <div className="shrink-0 max-w-5xl mx-auto w-full px-8 pt-6 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-2 mb-3 text-xs">
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
            Story
          </span>
          {isDirty && (
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Unsaved changes
            </span>
          )}
          {epic && (
            <>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">in Epic · {epic.title}</span>
            </>
          )}
          <span className="text-slate-300">·</span>
          <span
            className={`text-[10.5px] font-semibold px-2 py-0.5 rounded border uppercase tracking-wider ${
              status === "APPROVED"
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : status === "DRAFT"
                ? "bg-slate-100 text-slate-500 border-slate-200"
                : "bg-slate-200 text-slate-600 border-slate-300"
            }`}
          >
            {status}
          </span>
          {story.documentId && (
            <>
              <span className="text-slate-300">·</span>
              <span
                className="text-[10.5px] font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"
                title={story.sourceAnchor || undefined}
              >
                <FileText size={11} className="text-blue-500" />
                PRD: {prdDoc?.title || "Document"} {prdDoc?.currentVersionTag ? `(${prdDoc.currentVersionTag})` : ""}
                {story.sourceAnchor ? ` · ${story.sourceAnchor}` : ""}
              </span>
            </>
          )}
        </div>

        <div className="flex items-start gap-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Story title..."
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

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mt-5">
          <div className="flex items-center gap-2">
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
                      setIdDraft(story.id);
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
                    setIdDraft(story.id);
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
                  {story.id}
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
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Requirement["status"])}
              className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none cursor-pointer"
            >
              {statusOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Flow
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={isFlow}
              onClick={() => setIsFlow((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors focus:ring-2 focus:ring-blue-500/20 outline-none ${
                isFlow
                  ? "bg-purple-50 border-purple-200 text-purple-700"
                  : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
              }`}
              title="Mark this story as a business flow (BDD Feature)"
            >
              <GitBranch size={12} className={isFlow ? "text-purple-500" : "text-slate-400"} />
              {isFlow ? "Flow story" : "Standard"}
            </button>
            {isFlow && (
              <HelpTooltip
                content="This is a flow story — its ACs are BDD scenarios (Given/When/Then paths). Use AC-level relatedRequirementIds to link component stories."
                maxWidthClass="max-w-xs"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-6">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Description
              </label>

              <StoryFormatHelpTooltip />
            </div>
            <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setMode("edit")}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  mode === "edit"
                    ? "bg-white text-slate-700 shadow-sm border border-slate-200"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Edit3 size={12} /> Edit
              </button>
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  mode === "preview"
                    ? "bg-white text-slate-700 shadow-sm border border-slate-200"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Eye size={12} /> Preview
              </button>
            </div>
          </div>

          {showWarning && (
            <div className="mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-2">
              <AlertTriangle size={14} />
              <span>As a / I want / So that segments not detected.</span>
            </div>
          )}

          {mode === "preview" ? (
            <FormatSegmentBlock
              variant="story"
              segments={[
                { label: "As a", content: parsed.role },
                { label: "I want", content: parsed.action },
                { label: "So that", content: parsed.value },
              ]}
              remainder={parsed.remainder}
            />
          ) : (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none placeholder-slate-300 resize-none min-h-[160px]"
              placeholder={"As a user\nI want to do something\nSo that I get value"}
            />
          )}
        </div>

        <div className="max-w-5xl mx-auto px-8 py-6">
          <ACList acs={acs} parentStoryId={story.id} projectId={projectId} onSaved={onSaved} parentStoryIsFlow={isFlow} />
        </div>
      </div>
    </div>
  );
}
