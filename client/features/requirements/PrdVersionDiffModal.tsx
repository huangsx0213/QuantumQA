import React, { useState, useEffect, useMemo } from "react";
import {
  GitCompare,
  X,
  FileText,
  FileSpreadsheet,
  FileCode,
  Layers,
  ArrowRight,
  ArrowLeftRight,
  CheckCircle2,
  AlertTriangle,
  Folder,
  BookOpen,
  CheckSquare,
  Sparkles,
  RefreshCw,
  Search,
  MinusCircle,
  PlusCircle,
  HelpCircle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type {
  PrdDocument,
  PrdDocumentVersion,
  PrdParsedPreviewItem,
  PrdVersionDiffResult,
} from "../../../shared/contracts/index";
import {
  usePrdDocumentVersions,
  usePrdDocumentDiff,
} from "../../shared/hooks/useQueryHooks";
import {
  parseStoryMarkdown,
  parseACMarkdown,
} from "../../shared/requirements/format-parser";
import { FormatSegmentBlock } from "./FormatSegmentBlock";

interface Props {
  projectId: string;
  document: PrdDocument | null;
  isOpen: boolean;
  onClose: () => void;
  initialBaseVersionId?: string;
  initialTargetVersionId?: string;
}

export function PrdVersionDiffModal({
  projectId,
  document,
  isOpen,
  onClose,
  initialBaseVersionId,
  initialTargetVersionId,
}: Props) {
  const { data: versions = [] } = usePrdDocumentVersions(
    projectId,
    document?.id || null
  );

  const [baseVersionId, setBaseVersionId] = useState<string>("");
  const [targetVersionId, setTargetVersionId] = useState<string>("");
  const [diffFilter, setDiffFilter] = useState<
    "all" | "added" | "modified" | "deprecated" | "unchanged"
  >("all");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Initialize version selectors when versions load or modal opens
  useEffect(() => {
    if (!isOpen || versions.length < 2) return;
    const sortedAsc = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);

    if (initialBaseVersionId && versions.some((v) => v.id === initialBaseVersionId)) {
      setBaseVersionId(initialBaseVersionId);
    } else if (!baseVersionId || !versions.some((v) => v.id === baseVersionId)) {
      setBaseVersionId(sortedAsc[0]?.id || "");
    }

    if (
      initialTargetVersionId &&
      versions.some((v) => v.id === initialTargetVersionId)
    ) {
      setTargetVersionId(initialTargetVersionId);
    } else if (!targetVersionId || !versions.some((v) => v.id === targetVersionId)) {
      setTargetVersionId(sortedAsc[sortedAsc.length - 1]?.id || "");
    }
  }, [isOpen, versions, initialBaseVersionId, initialTargetVersionId]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const {
    data: diffResult,
    isLoading,
    isFetching,
    error,
    refetch,
  } = usePrdDocumentDiff(
    projectId,
    document?.id || null,
    baseVersionId,
    targetVersionId,
    isOpen && Boolean(document && baseVersionId && targetVersionId)
  );

  const items = useMemo(() => diffResult?.items || [], [diffResult]);

  // Automatically select first modified, added, or first item when result loads
  useEffect(() => {
    if (items.length > 0 && !selectedItemId) {
      const firstModified = items.find((i) => i.diffStatus === "modified");
      const firstAdded = items.find((i) => i.diffStatus === "added");
      const firstDeprecated = items.find((i) => i.diffStatus === "deprecated");
      setSelectedItemId(
        firstModified?.id || firstAdded?.id || firstDeprecated?.id || items[0].id
      );
    }
  }, [items, selectedItemId]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId]
  );

  // Filtered items based on diff status and search
  const filteredItems = useMemo(() => {
    let result = items;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.sourceAnchor && i.sourceAnchor.toLowerCase().includes(q))
      );
    }

    if (diffFilter !== "all") {
      // Collect IDs of directly matching items
      const matchingIds = new Set<string>();
      result.forEach((i) => {
        if (i.diffStatus === diffFilter) matchingIds.add(i.id);
      });

      // Include ancestors of matched items so hierarchical tree displays properly
      const ancestorIds = new Set<string>();
      const itemMap = new Map(items.map((i) => [i.id, i]));
      matchingIds.forEach((id) => {
        let cur = itemMap.get(id);
        while (cur?.parentId) {
          ancestorIds.add(cur.parentId);
          cur = itemMap.get(cur.parentId);
        }
      });

      result = items.filter(
        (i) => matchingIds.has(i.id) || ancestorIds.has(i.id)
      );
    }

    return result;
  }, [items, diffFilter, searchQuery]);

  const rootItems = useMemo(
    () => filteredItems.filter((i) => !i.parentId),
    [filteredItems]
  );

  if (!isOpen || !document) return null;

  const baseVer = versions.find((v) => v.id === baseVersionId);
  const targetVer = versions.find((v) => v.id === targetVersionId);

  const handleSwapVersions = () => {
    const temp = baseVersionId;
    setBaseVersionId(targetVersionId);
    setTargetVersionId(temp);
  };

  const formatFileTypeIcon = (fileType: string) => {
    if (fileType === "xlsx" || fileType === "csv") {
      return <FileSpreadsheet className="text-emerald-600" size={18} />;
    }
    if (fileType === "markdown") {
      return <FileCode className="text-purple-600" size={18} />;
    }
    return <FileText className="text-blue-600" size={18} />;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prd-version-diff-title"
    >
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl h-[88vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center shrink-0">
              <GitCompare size={20} className="text-blue-600" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3
                  id="prd-version-diff-title"
                  className="text-base font-bold text-slate-800 truncate"
                >
                  Version Diff: {document.title}
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-600 border border-slate-200 flex items-center gap-1 shrink-0">
                  {formatFileTypeIcon(document.fileType)}
                  <span className="uppercase">{document.fileType}</span>
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Compare requirement specifications between historical document snapshots
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            aria-label="Close diff viewer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Version Selector Bar */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">Base Version:</span>
              <select
                value={baseVersionId}
                onChange={(e) => setBaseVersionId(e.target.value)}
                className="text-xs bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer shadow-xs"
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.versionTag || `v${v.versionNumber}`} ({v.fileName})
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleSwapVersions}
              title="Swap base and target versions"
              className="p-1.5 bg-white hover:bg-slate-100 text-slate-500 hover:text-blue-600 border border-slate-200 rounded-lg transition-colors cursor-pointer shadow-xs"
            >
              <ArrowLeftRight size={14} />
            </button>

            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">Target Version:</span>
              <select
                value={targetVersionId}
                onChange={(e) => setTargetVersionId(e.target.value)}
                className="text-xs bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer shadow-xs"
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.versionTag || `v${v.versionNumber}`} ({v.fileName})
                    {v.id === document.currentVersionId ? " · Current" : ""}
                  </option>
                ))}
              </select>
            </div>

            {isFetching && (
              <span className="flex items-center gap-1.5 text-xs text-blue-600 font-medium ml-2">
                <RefreshCw size={12} className="animate-spin" />
                Computing diff...
              </span>
            )}
          </div>

          {/* Quick search input */}
          <div className="relative w-56">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search diff items..."
              className="w-full pl-8 pr-3 py-1 text-xs bg-white border border-slate-300 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 shadow-xs"
            />
          </div>
        </div>

        {/* Metrics & Filter Bar */}
        {diffResult && (
          <div className="px-6 py-2.5 bg-white border-b border-slate-100 flex items-center justify-between text-xs shrink-0 flex-wrap gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-slate-600 mr-1">Filter:</span>
              <button
                type="button"
                onClick={() => setDiffFilter("all")}
                className={`px-2.5 py-0.5 rounded-full font-medium transition-colors cursor-pointer ${
                  diffFilter === "all"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All ({diffResult.stats.total})
              </button>
              <button
                type="button"
                onClick={() => setDiffFilter("added")}
                className={`px-2.5 py-0.5 rounded-full font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                  diffFilter === "added"
                    ? "bg-emerald-600 text-white"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                }`}
              >
                + {diffResult.stats.added} Added
              </button>
              <button
                type="button"
                onClick={() => setDiffFilter("modified")}
                className={`px-2.5 py-0.5 rounded-full font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                  diffFilter === "modified"
                    ? "bg-amber-600 text-white"
                    : "bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                }`}
              >
                ~ {diffResult.stats.modified} Modified
              </button>
              <button
                type="button"
                onClick={() => setDiffFilter("deprecated")}
                className={`px-2.5 py-0.5 rounded-full font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                  diffFilter === "deprecated"
                    ? "bg-rose-600 text-white"
                    : "bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                }`}
              >
                - {diffResult.stats.deprecated} Deprecated
              </button>
              <button
                type="button"
                onClick={() => setDiffFilter("unchanged")}
                className={`px-2.5 py-0.5 rounded-full font-medium transition-colors cursor-pointer ${
                  diffFilter === "unchanged"
                    ? "bg-slate-700 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {diffResult.stats.unchanged} Unchanged
              </button>
            </div>

            <div className="text-[11px] text-slate-400 font-mono">
              {diffResult.stats.epics} Epics · {diffResult.stats.stories} Stories · {diffResult.stats.acs} ACs
            </div>
          </div>
        )}

        {/* Content Pane: Dual Split View */}
        <div className="flex-1 flex min-h-0 overflow-hidden bg-slate-50">
          {isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-slate-400 space-y-3">
              <RefreshCw size={28} className="animate-spin text-blue-600" />
              <p className="text-sm font-medium text-slate-600">
                Analyzing specification differences between {baseVer?.versionTag || "Base"} and {targetVer?.versionTag || "Target"}...
              </p>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-red-500 space-y-3">
              <AlertTriangle size={32} />
              <p className="text-sm font-semibold">Failed to compare versions</p>
              <p className="text-xs text-slate-500 max-w-md text-center">
                {(error as Error)?.message || "An unexpected error occurred while computing the version diff."}
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
              >
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-slate-400 space-y-2">
              <HelpCircle size={32} />
              <p className="text-sm font-semibold text-slate-600">No specifications found</p>
              <p className="text-xs text-slate-400">
                Neither version has parsed requirements to compare.
              </p>
            </div>
          ) : (
            <>
              {/* Left Tree Navigator */}
              <div className="w-96 border-r border-slate-200 bg-white overflow-y-auto p-3 space-y-1 shrink-0">
                {rootItems.length === 0 ? (
                  <div className="py-12 text-center text-xs text-slate-400">
                    No requirements match the current filter
                  </div>
                ) : (
                  rootItems.map((item) => (
                    <DiffTreeNode
                      key={item.id}
                      item={item}
                      allItems={filteredItems}
                      selectedId={selectedItemId}
                      onSelect={(id) => setSelectedItemId(id)}
                      depth={0}
                    />
                  ))
                )}
              </div>

              {/* Right Detail & Diff Inspector */}
              <div className="flex-1 overflow-y-auto p-6 bg-white">
                {selectedItem ? (
                  <DiffItemDetail
                    item={selectedItem}
                    baseTag={baseVer?.versionTag || "v1.0"}
                    targetTag={targetVer?.versionTag || "v1.1"}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400">
                    Select a requirement from the hierarchy on the left to inspect its diff details.
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-600">Base:</span>
            <span className="font-mono text-slate-700">{baseVer?.versionTag || "v1.0"}</span>
            <span className="text-slate-300">({baseVer?.fileName})</span>
            <ArrowRight size={12} className="text-slate-400 mx-1" />
            <span className="font-medium text-slate-600">Target:</span>
            <span className="font-mono text-slate-700">{targetVer?.versionTag || "v1.1"}</span>
            <span className="text-slate-300">({targetVer?.fileName})</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Left Hierarchical Tree Node ---

interface TreeNodeProps {
  item: PrdParsedPreviewItem;
  allItems: PrdParsedPreviewItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}

function DiffTreeNode({
  item,
  allItems,
  selectedId,
  onSelect,
  depth,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const isSelected = item.id === selectedId;

  const children = useMemo(
    () => allItems.filter((i) => i.parentId === item.id),
    [allItems, item.id]
  );

  const getDiffBadge = (diffStatus?: string) => {
    switch (diffStatus) {
      case "added":
        return (
          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0">
            + Added
          </span>
        );
      case "modified":
        return (
          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
            ~ Modified
          </span>
        );
      case "deprecated":
        return (
          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300 line-through shrink-0">
            - Deprecated
          </span>
        );
      default:
        return null;
    }
  };

  const getLevelIcon = () => {
    switch (item.level) {
      case "epic":
        return <Folder size={14} className="text-indigo-600 shrink-0" />;
      case "story":
        return <BookOpen size={13} className="text-blue-600 shrink-0" />;
      case "ac":
        return <CheckSquare size={12} className="text-emerald-600 shrink-0" />;
    }
  };

  return (
    <div className="select-none">
      <div
        onClick={() => onSelect(item.id)}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        className={`group flex items-center justify-between py-1.5 pr-2 rounded-lg text-xs cursor-pointer transition-colors ${
          isSelected
            ? "bg-blue-50/80 border border-blue-200 text-blue-900 font-semibold"
            : "hover:bg-slate-50 text-slate-700"
        } ${item.diffStatus === "deprecated" ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-1.5 min-w-0 mr-1">
          {children.length > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((prev) => !prev);
              }}
              className="p-0.5 text-slate-400 hover:text-slate-600 rounded transition-colors"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3.5" />
          )}

          {getLevelIcon()}

          <span
            className={`truncate text-[11.5px] ${
              item.diffStatus === "deprecated" ? "line-through text-slate-400" : ""
            }`}
            title={item.title}
          >
            {item.title}
          </span>
        </div>

        {getDiffBadge(item.diffStatus)}
      </div>

      {expanded && children.length > 0 && (
        <div className="space-y-0.5">
          {children.map((child) => (
            <DiffTreeNode
              key={child.id}
              item={child}
              allItems={allItems}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Right Detailed Diff & Comparison Inspector ---

interface DiffDetailProps {
  item: PrdParsedPreviewItem;
  baseTag: string;
  targetTag: string;
}

function DiffItemDetail({ item, baseTag, targetTag }: DiffDetailProps) {
  const isModified = item.diffStatus === "modified";
  const isAdded = item.diffStatus === "added";
  const isDeprecated = item.diffStatus === "deprecated";
  const isUnchanged = item.diffStatus === "unchanged" || !item.diffStatus;

  // Render format blocks for current content
  const renderCurrentFormatBlock = () => {
    if (item.level === "story") {
      const parsed = parseStoryMarkdown(item.description);
      return (
        <FormatSegmentBlock
          segments={[
            { label: "As a", content: parsed.role },
            { label: "I want", content: parsed.action },
            { label: "So that", content: parsed.value },
          ]}
          remainder={parsed.remainder}
          variant="story"
        />
      );
    }
    if (item.level === "ac") {
      const parsed = parseACMarkdown(item.description);
      return (
        <FormatSegmentBlock
          segments={[
            { label: "Given", content: parsed.given },
            { label: "When", content: parsed.when },
            { label: "Then", content: parsed.then },
          ]}
          remainder={parsed.remainder}
          variant="ac"
        />
      );
    }
    return (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 whitespace-pre-wrap">
        {item.description || "No description provided."}
      </div>
    );
  };

  // Render format blocks for previous content (for modified items)
  const renderPreviousFormatBlock = () => {
    if (!item.previousDescription) {
      return (
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-400 italic">
          No previous description recorded.
        </div>
      );
    }

    if (item.level === "story") {
      const parsed = parseStoryMarkdown(item.previousDescription);
      return (
        <FormatSegmentBlock
          segments={[
            { label: "As a", content: parsed.role },
            { label: "I want", content: parsed.action },
            { label: "So that", content: parsed.value },
          ]}
          remainder={parsed.remainder}
          variant="story"
        />
      );
    }
    if (item.level === "ac") {
      const parsed = parseACMarkdown(item.previousDescription);
      return (
        <FormatSegmentBlock
          segments={[
            { label: "Given", content: parsed.given },
            { label: "When", content: parsed.when },
            { label: "Then", content: parsed.then },
          ]}
          remainder={parsed.remainder}
          variant="ac"
        />
      );
    }
    return (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 whitespace-pre-wrap">
        {item.previousDescription}
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Title & Level Header */}
      <div className="border-b border-slate-200 pb-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="uppercase text-[10px] font-bold px-2 py-0.5 rounded tracking-wider bg-slate-100 text-slate-700 border border-slate-200 font-mono">
            {item.level}
          </span>

          {item.diffStatus === "added" && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
              + Added in {targetTag}
            </span>
          )}
          {item.diffStatus === "modified" && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              ~ Modified between {baseTag} and {targetTag}
            </span>
          )}
          {item.diffStatus === "deprecated" && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300">
              - Deprecated / Removed in {targetTag}
            </span>
          )}
          {isUnchanged && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
              Unchanged
            </span>
          )}

          {item.sourceAnchor && (
            <span className="text-[10.5px] px-2 py-0.5 rounded font-mono text-slate-500 bg-slate-50 border border-slate-200">
              Anchor: {item.sourceAnchor}
            </span>
          )}
        </div>

        <h2 className="text-lg font-bold text-slate-800 leading-snug">
          {item.title}
        </h2>
      </div>

      {/* Diff Status Explanatory Alert */}
      {isModified && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-start gap-2.5">
          <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-semibold">Modified Specification</p>
            <p className="text-[11.5px] text-amber-700">
              This requirement existed in {baseTag} and has been updated in {targetTag}. Compare the specification differences below:
            </p>
          </div>
        </div>
      )}

      {isAdded && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-start gap-2.5">
          <PlusCircle size={16} className="text-emerald-600 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-semibold">New Requirement</p>
            <p className="text-[11.5px] text-emerald-700">
              This requirement is introduced for the first time in {targetTag} and did not exist in {baseTag}.
            </p>
          </div>
        </div>
      )}

      {isDeprecated && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-2.5">
          <MinusCircle size={16} className="text-rose-600 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-semibold">Deprecated Requirement</p>
            <p className="text-[11.5px] text-rose-700">
              This requirement existed in {baseTag} but has been removed or discontinued in {targetTag}.
            </p>
          </div>
        </div>
      )}

      {/* Content Rendering: Side-by-Side Comparison for Modified Items */}
      {isModified ? (
        <div className="space-y-4">
          <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
            <GitCompare size={14} className="text-blue-600" />
            Before vs After Specification Comparison
          </h4>

          {/* If title changed, display title diff */}
          {item.previousTitle && item.previousTitle !== item.title && (
            <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
              <div>
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">
                  Title in {baseTag}
                </span>
                <span className="text-slate-700 font-medium line-through">
                  {item.previousTitle}
                </span>
              </div>
              <div>
                <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider block mb-1">
                  Title in {targetTag}
                </span>
                <span className="text-emerald-800 font-semibold">
                  {item.title}
                </span>
              </div>
            </div>
          )}

          {/* Side-by-side or stacked content comparison */}
          <div className="space-y-3">
            <div className="border border-rose-200 rounded-xl p-3 bg-rose-50/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-rose-700 uppercase tracking-wider flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-rose-500" />
                  Previous Specification ({baseTag})
                </span>
              </div>
              {renderPreviousFormatBlock()}
            </div>

            <div className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-emerald-700 uppercase tracking-wider flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  Updated Specification ({targetTag})
                </span>
              </div>
              {renderCurrentFormatBlock()}
            </div>
          </div>
        </div>
      ) : (
        /* Single content block for added, deprecated, or unchanged */
        <div className="space-y-3">
          <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Specification Details
          </h4>
          {renderCurrentFormatBlock()}
        </div>
      )}
    </div>
  );
}
