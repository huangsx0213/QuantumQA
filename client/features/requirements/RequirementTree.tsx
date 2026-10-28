import React, { useState, useMemo } from "react";
import type { Requirement } from "../../../shared/contracts/index";
import { useRequirementMutations, usePrdDocuments } from "../../shared/hooks/useQueryHooks";
import {
  ChevronRight,
  ChevronDown,
  Edit2,
  Trash2,
  Copy,
  ClipboardPaste,
  GitBranch,
  FileText,
  Plus,
} from "lucide-react";
import { ConfirmModal } from "@/shared/ui/ConfirmModal";

interface Props {
  items: Requirement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  projectId: string;
  parentId?: string | null;
  depth?: number;
  onRefresh: () => void;
  onReorder?: (parentId: string | null, fromId: string, toId: string) => void;
  onCopy?: (id: string) => void;
  onPaste?: (parentId: string | null) => void;
  onAddChild?: (parentId: string, level: Requirement["level"]) => void;
  clipboardExists?: boolean;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
}

const levelDotColors: Record<Exclude<Requirement["level"], "ac">, string> = {
  epic: "bg-purple-500",
  story: "bg-emerald-500",
};

export function RequirementTree({
  items,
  selectedId,
  onSelect,
  projectId,
  parentId = null,
  depth = 0,
  onRefresh,
  onReorder,
  onCopy,
  onPaste,
  onAddChild,
  clipboardExists = false,
  expandedIds,
  onToggleExpand,
}: Props) {
  const { remove, update: _update } = useRequirementMutations(projectId);
  const { data: prdDocs = [] } = usePrdDocuments(projectId);
  const prdDocMap = useMemo(() => new Map(prdDocs.map((d) => [d.id, d])), [prdDocs]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const children = items
    .filter((r) => (r.parentId || null) === parentId && r.level !== "ac")
    .sort((a, b) => a.position - b.position);

  const isExpanded = (id: string) => expandedIds.has(id);

  const saveTitle = (id: string) => {
    _update(id, { title: editTitle });
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await remove(id);
    setDeleteConfirm(null);
    onRefresh();
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverId !== id) setDragOverId(id);
  };

  const handleDragLeave = (id: string) => {
    if (dragOverId === id) setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("text/plain");
    setDragOverId(null);
    if (!fromId || fromId === targetId || !onReorder) return;
    onReorder(parentId, fromId, targetId);
  };

  const handleDragEnd = () => {
    setDragOverId(null);
  };

  return (
    <div>
      <ConfirmModal
        isOpen={!!deleteConfirm}
        title="Delete Requirement"
        message="Are you sure you want to delete this requirement? All child requirements will also be removed."
        onConfirm={() => deleteConfirm && handleDelete(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
      />
      {children.map((r) => {
        // Only epic rows are expandable (story rows have AC children that are hidden from the tree)
        const isExpandable = r.level === "epic";
        const expanded = isExpanded(r.id);
        const isSelected = selectedId === r.id;
        const isDragOver = dragOverId === r.id;

        return (
          <div key={r.id} className="space-y-px">
            <div
              draggable
              role="treeitem"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(isSelected ? "" : r.id);
                }
              }}
              onDragStart={(e) => handleDragStart(e, r.id)}
              onDragOver={(e) => handleDragOver(e, r.id)}
              onDragLeave={() => handleDragLeave(r.id)}
              onDrop={(e) => handleDrop(e, r.id)}
              onDragEnd={handleDragEnd}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-all duration-150 outline-none focus:ring-1 focus:ring-blue-500/50 ${
                isSelected
                  ? "bg-blue-50 text-slate-900 border border-blue-200 shadow-sm"
                  : isDragOver
                  ? "bg-blue-50/60 border border-blue-300 border-dashed"
                  : "text-slate-700 hover:bg-slate-100 hover:text-slate-900 border border-transparent"
              }`}
              style={{ paddingLeft: `${depth * 4 + 4}px` }}
              onClick={() => onSelect(isSelected ? "" : r.id)}
              data-testid="tree-row"
            >
              {isExpandable ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(r.id);
                  }}
                  className="shrink-0 -ml-1 p-1 hover:bg-slate-200/70 rounded-md transition-colors"
                  aria-label={expanded ? "Collapse" : "Expand"}
                >
                  {expanded ? (
                    <ChevronDown size={14} className="text-slate-500" />
                  ) : (
                    <ChevronRight size={14} className="text-slate-400" />
                  )}
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <span
                className={`inline-block w-2 h-2 rounded-full shrink-0 ${levelDotColors[r.level as keyof typeof levelDotColors]}`}
              />
              {r.level === "story" && r.isFlow && (
                <>
                  <GitBranch size={11} className="text-purple-500 shrink-0" />
                  <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200 uppercase tracking-wider shrink-0">
                    Flow
                  </span>
                </>
              )}
              {r.documentId && (
                (() => {
                  const doc = prdDocMap.get(r.documentId);
                  const tooltip = doc
                    ? `PRD: ${doc.title}${doc.currentVersionTag ? ` (${doc.currentVersionTag})` : ""}${r.sourceAnchor ? ` · ${r.sourceAnchor}` : ""}`
                    : (r.sourceAnchor ? `PRD: ${r.sourceAnchor}` : "Linked to PRD document");
                  return (
                    <span title={tooltip}>
                      <FileText
                        size={11}
                        className="text-blue-500/80 shrink-0"
                      />
                    </span>
                  );
                })()
              )}
              {editingId === r.id ? (
                <input
                  className="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-white border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.key === "Enter" && saveTitle(r.id)}
                  onBlur={() => saveTitle(r.id)}
                  autoFocus
                />
              ) : (
                <span
                  className={`flex-1 min-w-0 truncate ${
                    isSelected
                      ? "font-semibold text-[13px]"
                      : "font-medium text-sm"
                  }`}
                  title={r.title}
                >
                  {r.title}
                </span>
              )}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-auto">
                {onAddChild && r.level === "epic" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddChild(r.id, "story");
                    }}
                    className="p-1 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                    title="Add Story to this Epic"
                    aria-label="Add Story to this Epic"
                  >
                    <Plus size={12} />
                  </button>
                )}
                {onCopy && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(r.id);
                    }}
                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    title="Copy"
                    aria-label="Copy requirement"
                  >
                    <Copy size={12} />
                  </button>
                )}
                {onPaste && clipboardExists && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPaste(r.id);
                    }}
                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    title="Paste as Child"
                    aria-label="Paste child requirement"
                  >
                    <ClipboardPaste size={12} />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(r.id);
                    setEditTitle(r.title);
                  }}
                  className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                  title="Edit title"
                  aria-label="Edit title"
                >
                  <Edit2 size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(r.id);
                  }}
                  className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Delete"
                  aria-label="Delete requirement"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {editingId === r.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    saveTitle(r.id);
                  }}
                  className="p-1 text-green-600 hover:bg-green-100 rounded ml-1 shrink-0 transition-colors"
                  aria-label="Save title"
                >
                  <ChevronDown size={12} />
                </button>
              )}
            </div>
            {isExpandable && expanded && (
              <div className="ml-2 pl-1 border-l border-slate-200 space-y-px">
                <RequirementTree
                  items={items}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  projectId={projectId}
                  parentId={r.id}
                  depth={depth + 1}
                  onRefresh={onRefresh}
                  onReorder={onReorder}
                  onCopy={onCopy}
                  onPaste={onPaste}
                  onAddChild={onAddChild}
                  clipboardExists={clipboardExists}
                  expandedIds={expandedIds}
                  onToggleExpand={onToggleExpand}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
