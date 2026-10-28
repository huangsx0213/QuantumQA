import React, { useState, useEffect, useMemo, useRef } from "react";
import { Save, Trash2, Edit3, Eye, AlertTriangle, Check, X, Link2, ChevronDown } from "lucide-react";
import type { Requirement } from "../../../shared/contracts/index";
import { useRequirementMutations, useRequirements } from "../../shared/hooks/useQueryHooks";
import { parseACMarkdown } from "../../shared/requirements/format-parser";
import { ACFormatHelpTooltip } from "./ACFormatHelpTooltip";
import { ConfirmModal } from "@/shared/ui/ConfirmModal";
import { FormatSegmentBlock } from "./FormatSegmentBlock";

interface Props {
  ac: Requirement;
  index: number;
  parentStoryId: string;
  projectId: string;
  onSaved: (ac: Requirement) => void;
  parentStoryIsFlow?: boolean;
}

const statusChipClass = (status: Requirement["status"]) => {
  switch (status) {
    case "APPROVED":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "DEPRECATED":
      return "bg-slate-200 text-slate-500 border-slate-300";
    case "DRAFT":
    default:
      return "bg-slate-100 text-slate-500 border-slate-200";
  }
};

const statusOrder: Requirement["status"][] = ["DRAFT", "APPROVED", "DEPRECATED"];

function RelatedRequirementsMultiSelect({
  candidates,
  selected,
  onChange,
}: {
  candidates: { id: string; title: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isSelected = (id: string) => selected.includes(id);
  const toggle = (id: string) => {
    if (isSelected(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div
      className="relative"
      ref={containerRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Link2 size={11} className="text-slate-400" />
        {selected.length === 0 ? (
          <span className="text-slate-400">No related requirements</span>
        ) : (
          <span className="font-mono">{selected.length} linked</span>
        )}
        <ChevronDown size={11} className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-30 mt-1 w-80 max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-1.5"
        >
          {candidates.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-slate-400 text-center">
              No other stories or ACs in this project
            </div>
          ) : (
            candidates.map((c) => (
              <label
                key={c.id}
                className="flex items-start gap-2 px-2.5 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={isSelected(c.id)}
                  onChange={() => toggle(c.id)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500/20"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] font-semibold text-slate-700">{c.id}</div>
                  <div className="text-[11px] text-slate-500 truncate">{c.title}</div>
                </div>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ACCard({ ac, index, projectId, onSaved, parentStoryIsFlow = false }: Props) {
  const { update, remove } = useRequirementMutations(projectId);
  const { data: allItems = [] } = useRequirements(projectId);
  const [description, setDescription] = useState(ac.description);
  const [flowType, setFlowType] = useState<"atomic" | "flow">(ac.flowType || "atomic");
  const [status, setStatus] = useState<Requirement["status"]>(ac.status);
  const [relatedRequirementIds, setRelatedRequirementIds] = useState<string[]>(ac.relatedRequirementIds || []);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");

  useEffect(() => {
    setDescription(ac.description);
    setFlowType(ac.flowType || "atomic");
    setStatus(ac.status);
    setRelatedRequirementIds(ac.relatedRequirementIds || []);
    setMode("preview");
    setSaveStatus("idle");
  }, [ac.id, ac.description, ac.flowType, ac.status, ac.relatedRequirementIds]);

  const parsed = parseACMarkdown(description);
  const isEmpty = !description.trim();
  const showWarning = !isEmpty && !parsed.hasAllSegments;

  // Candidates: other stories and ACs in the project (not the current AC).
  const relatedCandidates = useMemo(() => {
    return allItems
      .filter((r) => (r.level === "story" || r.level === "ac") && r.id !== ac.id)
      .map((r) => ({ id: r.id, title: r.title }));
  }, [allItems, ac.id]);

  const handleSave = async () => {
    if (saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      const effectiveFlowType: "atomic" | "flow" = parentStoryIsFlow ? "flow" : flowType;
      const payload: Parameters<typeof update>[1] = {
        description,
        flowType: effectiveFlowType,
        status,
      };
      if (parentStoryIsFlow) {
        payload.relatedRequirementIds = relatedRequirementIds;
      }
      await update(ac.id, payload);
      setMode("preview");
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
      onSaved({
        ...ac,
        description,
        flowType: effectiveFlowType,
        status,
        ...(parentStoryIsFlow ? { relatedRequirementIds } : {}),
      });
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const handleStatusChange = async (next: "DRAFT" | "APPROVED" | "DEPRECATED") => {
    if (next === status) return;
    if (next === "DEPRECATED" && !window.confirm(`Mark ${ac.id} as DEPRECATED?`)) {
      return;
    }
    const prev = status;
    setStatus(next);
    try {
      await update(ac.id, { status: next });
      onSaved({ ...ac, status: next });
    } catch {
      setStatus(prev);
    }
  };

  const setFlowTypePersist = async (next: "atomic" | "flow") => {
    if (next === flowType) return;
    setFlowType(next);
    try {
      await update(ac.id, { flowType: next });
      onSaved({ ...ac, flowType: next });
    } catch {
      setFlowType(flowType);
    }
  };

  const handleDelete = async () => {
    try {
      await remove(ac.id);
      onSaved({ ...ac, description: "__deleted__" } as Requirement);
    } catch {
      // delete failed
    }
  };

  return (
    <article
      className={`bg-white border rounded-lg overflow-hidden relative ${
        isEmpty ? "border-dashed border-slate-300 opacity-90" : "border-slate-200"
      }`}
    >
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[11px] text-slate-500 flex items-center gap-2">
          <span className="font-semibold text-slate-700">{ac.id}</span>
          <span className="text-slate-300">·</span>
          <span>#{index}</span>
        </span>
        <select
          value={status}
          onChange={(e) => handleStatusChange(e.target.value as "DRAFT" | "APPROVED" | "DEPRECATED")}
          className={`text-[10.5px] font-semibold px-2 py-0.5 rounded border uppercase tracking-wider bg-white cursor-pointer outline-none focus:ring-1 focus:ring-blue-500 ${statusChipClass(status)}`}
          title="Change AC status"
          aria-label="Acceptance criteria status"
        >
          <option value="DRAFT">DRAFT</option>
          <option value="APPROVED">APPROVED</option>
          <option value="DEPRECATED">DEPRECATED</option>
        </select>
        {ac.sourceAnchor && (
          <span className="text-[10px] font-mono text-slate-400 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded" title={`PRD Source: ${ac.sourceAnchor}`}>
            {ac.sourceAnchor}
          </span>
        )}

        {parentStoryIsFlow ? (
          <>
            {/* Scenario badge (flow story ACs are always scenarios) */}
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded border uppercase tracking-wider bg-blue-50 text-blue-700 border-blue-200">
              Scenario
            </span>
            <RelatedRequirementsMultiSelect
              candidates={relatedCandidates}
              selected={relatedRequirementIds}
              onChange={setRelatedRequirementIds}
            />
          </>
        ) : (
          /* Segmented control for Atomic / Flow */
          <div
            role="group"
            aria-label="Flow type"
            className="inline-flex items-stretch rounded-md border border-slate-200 overflow-hidden bg-slate-50"
          >
            <button
              type="button"
              onClick={() => setFlowTypePersist("atomic")}
              aria-pressed={flowType === "atomic"}
              className={`text-[10.5px] font-semibold px-2.5 py-0.5 uppercase tracking-wider transition-colors ${
                flowType === "atomic"
                  ? "bg-emerald-100 text-emerald-700"
                  : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              }`}
            >
              Atomic
            </button>
            <span className="w-px bg-slate-200" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setFlowTypePersist("flow")}
              aria-pressed={flowType === "flow"}
              className={`text-[10.5px] font-semibold px-2.5 py-0.5 uppercase tracking-wider transition-colors ${
                flowType === "flow"
                  ? "bg-blue-100 text-blue-700"
                  : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              }`}
            >
              Flow
            </button>
          </div>
        )}

        <ACFormatHelpTooltip isFlow={parentStoryIsFlow} />
      </div>

      <div className="px-5 py-4">
        {showWarning && (
          <div className="mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-2">
            <AlertTriangle size={14} />
            <span>Given / When / Then segments not detected.</span>
          </div>
        )}

        {isEmpty ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/30 px-4 py-6 text-sm text-slate-400 text-center italic">
            Empty — awaiting content
          </div>
        ) : mode === "preview" ? (
          <FormatSegmentBlock
            variant="ac"
            segments={[
              { label: "Given", content: parsed.given },
              { label: "When", content: parsed.when },
              { label: "Then", content: parsed.then },
            ]}
            remainder={parsed.remainder}
          />
        ) : (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none placeholder-slate-300 resize-none min-h-[120px]"
            placeholder={"Given:\nWhen:\nThen:"}
          />
        )}

        <div className="mt-3 flex items-center gap-2">
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
          <button
            onClick={() => setDeleteConfirmOpen(true)}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
            title="Delete AC"
          >
            <Trash2 size={14} />
          </button>
          <div className="ml-auto flex items-center gap-2">
            {saveStatus === "success" && (
              <span className="text-[11px] text-green-600 font-medium flex items-center gap-1">
                <Check size={12} /> Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="text-[11px] text-red-600 font-medium flex items-center gap-1">
                <X size={12} /> Failed
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saveStatus === "saving"}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-md transition-colors ${
                saveStatus === "saving"
                  ? "bg-blue-400 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              <Save size={12} /> Save
            </button>
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteConfirmOpen}
        title="Delete Acceptance Criterion"
        message={`Delete AC ${ac.id}? This cannot be undone.`}
        onConfirm={handleDelete}
        onClose={() => setDeleteConfirmOpen(false)}
      />
    </article>
  );
}
