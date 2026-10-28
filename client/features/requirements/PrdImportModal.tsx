import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Sparkles,
  Upload,
  FileText,
  FileSpreadsheet,
  Check,
  X,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Plus,
  GitBranch,
  Info,
  CheckSquare,
  Square,
} from "lucide-react";
import {
  usePrdDocuments,
  usePrdDocumentMutations,
  useProviderConfigs,
} from "../../shared/hooks/useQueryHooks";
import type {
  PrdDocument,
  PrdParsedPreviewItem,
  PrdParsePreviewResult,
} from "../../../shared/contracts/index";
import {
  parseStoryMarkdown,
  parseACMarkdown,
} from "../../shared/requirements/format-parser";
import { FormatSegmentBlock } from "./FormatSegmentBlock";

interface Props {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
  initialDocumentToUpdate?: PrdDocument | null;
}

export function PrdImportModal({
  projectId,
  isOpen,
  onClose,
  onImported,
  initialDocumentToUpdate,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"config" | "preview">("config");
  const [mode, setMode] = useState<"new" | "update">("new");
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [docTitle, setDocTitle] = useState("");
  const [versionTag, setVersionTag] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState<string>("");
  const [providerConfigId, setProviderConfigId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [diffFilter, setDiffFilter] = useState<"all" | "added" | "modified" | "deprecated">("all");
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFormatGuide, setShowFormatGuide] = useState(false);
  const [showWarnings, setShowWarnings] = useState(true);

  // Inclusion set for committing only selected requirements
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());

  const { data: documents = [] } = usePrdDocuments(projectId);
  const { data: providerConfigs = [] } = useProviderConfigs();
  const { parsePreview, commit, isParsing, isCommitting } = usePrdDocumentMutations(projectId);
  const [previewResult, setPreviewResult] = useState<PrdParsePreviewResult | null>(null);

  // Available models for currently selected provider
  const availableModels = useMemo(() => {
    const conf = providerConfigs.find((c) => c.id === providerConfigId);
    if (!conf) return [];
    const modelsSet = new Set<string>();
    if (Array.isArray(conf.models)) {
      conf.models.forEach((m) => {
        if (typeof m === "string" && m.trim()) modelsSet.add(m.trim());
      });
    }
    if (conf.model && typeof conf.model === "string" && conf.model.trim()) {
      modelsSet.add(conf.model.trim());
    }
    if (modelsSet.size === 0) {
      if (conf.type === "anthropic") {
        modelsSet.add("claude-3-5-sonnet-20241022");
        modelsSet.add("claude-3-5-haiku-20241022");
      } else if (conf.type === "azure-openai") {
        modelsSet.add("gpt-4o");
        modelsSet.add("gpt-4o-mini");
      } else {
        modelsSet.add("gpt-4o");
        modelsSet.add("gpt-4o-mini");
        modelsSet.add("deepseek-chat");
        modelsSet.add("deepseek-reasoner");
      }
    }
    return Array.from(modelsSet);
  }, [providerConfigs, providerConfigId]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  // Default provider config selection
  useEffect(() => {
    if (providerConfigs.length > 0 && !providerConfigId) {
      const active = providerConfigs.find((c) => c.isActive) || providerConfigs[0];
      setProviderConfigId(active.id);
    }
  }, [providerConfigs, providerConfigId]);

  // Auto-select first available model when provider changes
  useEffect(() => {
    if (availableModels.length > 0 && !isCustomModel) {
      if (!model || !availableModels.includes(model)) {
        setModel(availableModels[0]);
      }
    }
  }, [availableModels, model, isCustomModel]);

  const prevIsOpenRef = useRef(false);

  // Reset or initialize state whenever modal opens or documentToUpdate changes
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      // Cleanly reset parsing, preview, and file states whenever modal opens
      setStep("config");
      setFile(null);
      setFileBase64("");
      setPreviewResult(null);
      setSelectedPreviewId(null);
      setError(null);
      setIncludedIds(new Set());
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      if (initialDocumentToUpdate) {
        setMode("update");
        setSelectedDocId(initialDocumentToUpdate.id);
        setDocTitle(initialDocumentToUpdate.title);
      } else {
        setMode("new");
        setSelectedDocId("");
        setDocTitle("");
      }
    } else if (isOpen && initialDocumentToUpdate && initialDocumentToUpdate.id !== selectedDocId) {
      // Document to update changed while already open
      setStep("config");
      setFile(null);
      setFileBase64("");
      setPreviewResult(null);
      setSelectedPreviewId(null);
      setError(null);
      setIncludedIds(new Set());
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setMode("update");
      setSelectedDocId(initialDocumentToUpdate.id);
      setDocTitle(initialDocumentToUpdate.title);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialDocumentToUpdate, selectedDocId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    processSelectedFile(selected);
    e.target.value = "";
  };

  const processSelectedFile = (selected: File) => {
    setError(null);
    setFile(selected);
    if (!docTitle && mode === "new") {
      const cleanTitle = selected.name.replace(/\.[^/.]+$/, "");
      setDocTitle(cleanTitle);
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] || result;
      setFileBase64(base64);
    };
    reader.readAsDataURL(selected);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) processSelectedFile(dropped);
  };

  const handleStartParsing = async () => {
    if (!file || !fileBase64) {
      setError("Please select a PRD document file first.");
      return;
    }
    if (mode === "update" && !selectedDocId) {
      setError("Please select an existing PRD document to update.");
      return;
    }
    setError(null);
    try {
      const targetDocId = mode === "update" ? selectedDocId : undefined;
      const result = await parsePreview({
        fileName: file.name,
        fileBase64,
        documentId: targetDocId,
        documentTitle: docTitle || file.name,
        providerConfigId: providerConfigId || undefined,
        model: model || undefined,
      });
      setPreviewResult(result);
      setVersionTag(result.versionTag);
      setIncludedIds(new Set(result.items.map((i) => i.id)));
      if (result.items.length > 0) {
        setSelectedPreviewId(result.items[0].id);
      }
      setStep("preview");
    } catch (err: any) {
      setError(err.message || "Failed to parse document with AI");
    }
  };

  // Toggle item inclusion with cascade to children & ancestors
  const toggleInclude = (id: string) => {
    if (!previewResult) return;
    setIncludedIds((prev) => {
      const next = new Set(prev);
      const isIncluded = next.has(id);

      // Collect all descendants
      const descendants = new Set<string>();
      const collectDescendants = (parentId: string) => {
        const children = previewResult.items.filter((i) => i.parentId === parentId);
        for (const child of children) {
          descendants.add(child.id);
          collectDescendants(child.id);
        }
      };
      collectDescendants(id);

      if (isIncluded) {
        // Exclude self and all descendants
        next.delete(id);
        descendants.forEach((d) => next.delete(d));
      } else {
        // Include self and all descendants
        next.add(id);
        descendants.forEach((d) => next.add(d));

        // Also ensure all ancestors are included
        const itemMap = new Map<string, PrdParsedPreviewItem>(
          previewResult.items.map((i) => [i.id, i])
        );
        let curr: PrdParsedPreviewItem | undefined = itemMap.get(id);
        while (curr && curr.parentId) {
          next.add(curr.parentId);
          curr = itemMap.get(curr.parentId);
        }
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (!previewResult) return;
    setIncludedIds(new Set(previewResult.items.map((i) => i.id)));
  };

  const handleDeselectAll = () => {
    setIncludedIds(new Set());
  };

  // Inline editing in preview inspection pane
  const handleUpdateItem = (id: string, patch: Partial<PrdParsedPreviewItem>) => {
    setPreviewResult((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      };
    });
  };

  const handleCommit = async () => {
    if (!previewResult) return;
    setError(null);
    try {
      const itemsToCommit = previewResult.items.filter((item) => includedIds.has(item.id));
      if (itemsToCommit.length === 0) {
        setError("Please select at least one requirement to commit.");
        return;
      }
      await commit({
        fileName: previewResult.fileName,
        fileBase64,
        documentId: mode === "update" ? selectedDocId : undefined,
        documentTitle: docTitle || previewResult.documentTitle,
        versionTag: versionTag.trim() || previewResult.versionTag,
        items: itemsToCommit,
      });
      setStep("config");
      setFile(null);
      setFileBase64("");
      setPreviewResult(null);
      onImported();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to commit requirements");
    }
  };

  const selectedItem = previewResult?.items.find((r) => r.id === selectedPreviewId) || null;
  const childAcs = selectedItem && selectedItem.level === "story"
    ? previewResult?.items.filter((r) => r.parentId === selectedItem.id && r.level === "ac") || []
    : [];

  const filteredItems = useMemo(() => {
    if (!previewResult) return [];
    if (diffFilter === "all") return previewResult.items;
    return previewResult.items.filter((item) => item.diffStatus === diffFilter);
  }, [previewResult, diffFilter]);

  // Root items for the hierarchical tree
  const rootPreviewItems = useMemo(() => {
    const allFilteredIds = new Set(filteredItems.map((i) => i.id));
    return filteredItems.filter(
      (item) => !item.parentId || !allFilteredIds.has(item.parentId)
    );
  }, [filteredItems]);

  const includedCount = useMemo(() => {
    if (!previewResult) return 0;
    return previewResult.items.filter((i) => includedIds.has(i.id)).length;
  }, [previewResult, includedIds]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />

      <div
        className={`relative w-full ${
          step === "preview" ? "max-w-6xl" : "max-w-2xl"
        } bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh] transition-all duration-200`}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
              <Sparkles size={20} className="text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">
                  {step === "config"
                    ? mode === "update"
                      ? "Upload New PRD Version (AI-Powered)"
                      : "Import PRD Document (AI-Powered)"
                    : "Review & Commit Requirements"}
                </h2>
                {previewResult && (
                  <div className="flex items-center gap-1.5 ml-1">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                      Version:
                    </span>
                    <input
                      type="text"
                      value={versionTag}
                      onChange={(e) => setVersionTag(e.target.value)}
                      className="w-20 px-2 py-0.5 text-xs font-bold font-mono bg-blue-50 text-blue-700 border border-blue-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="e.g. v1.1"
                      title="Version tag for this commit (editable)"
                    />
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">
                {step === "config"
                  ? mode === "update"
                    ? `Upload a new version of "${docTitle || "PRD"}". AI will analyze changes, structure requirements, and generate version diffs.`
                    : "Upload Word (.docx), Excel (3-column .xlsx), Markdown, or CSV for AI structuring, review gate, and versioning."
                  : `Reviewing ${previewResult?.items.length || 0} parsed requirements from ${previewResult?.fileName}. (${includedCount} included for commit)`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        {step === "config" ? (
          <div className="p-6 overflow-y-auto space-y-5 flex-1">
            {/* Mode selection tabs */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Import Destination Mode
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setMode("new")}
                  className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                    mode === "new"
                      ? "border-blue-500 bg-blue-50 text-blue-700 shadow-xs"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  }`}
                >
                  <Plus size={16} />
                  Create New PRD Document
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("update");
                    if (!selectedDocId && documents.length > 0) {
                      setSelectedDocId(documents[0].id);
                      setDocTitle(documents[0].title);
                    }
                  }}
                  disabled={documents.length === 0}
                  className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                    mode === "update"
                      ? "border-blue-500 bg-blue-50 text-blue-700 shadow-xs"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  }`}
                >
                  <RefreshCw size={15} />
                  Update Existing PRD (New Version)
                </button>
              </div>
            </div>

            {/* Target document selection (if updating) */}
            {mode === "update" && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Select Existing PRD Document to Update
                </label>
                <select
                  value={selectedDocId}
                  onChange={(e) => {
                    setSelectedDocId(e.target.value);
                    const doc = documents.find((d) => d.id === e.target.value);
                    if (doc) setDocTitle(doc.title);
                  }}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                >
                  <option value="">-- Choose document --</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} ({d.currentVersionTag || "v1.0"}) · {d.fileType}
                    </option>
                  ))}
                </select>
                {selectedDocId && (
                  <p className="mt-1.5 text-xs text-blue-600 flex items-center gap-1.5">
                    <GitBranch size={13} className="shrink-0" />
                    <span>
                      Updating <strong>{documents.find((d) => d.id === selectedDocId)?.title}</strong> (Current:{" "}
                      <strong>{documents.find((d) => d.id === selectedDocId)?.currentVersionTag || "v1.0"}</strong>).
                      New file will be staged as next version (v1.1) and diffed against current requirements.
                    </span>
                  </p>
                )}
              </div>
            )}

            {/* Document Title */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Document Title
              </label>
              <input
                type="text"
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                placeholder="e.g. User Authentication & Authorization PRD"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>

            {/* File dropzone */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Upload size={13} className="text-blue-600" />
                  <span>
                    {mode === "update"
                      ? "Upload New Version Document (.docx, .xlsx, .md, .csv)"
                      : "Upload Source File (.docx, .xlsx, .md, .csv)"}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowFormatGuide(!showFormatGuide)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                  <Info size={13} />
                  <span>{showFormatGuide ? "Hide format guide" : "Supported formats"}</span>
                </button>
              </div>

              {showFormatGuide && (
                <div className="mb-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 space-y-2">
                  <h4 className="font-bold text-slate-800">Supported File Formats &amp; Structure:</h4>
                  <ul className="list-disc list-inside space-y-1 text-slate-600">
                    <li>
                      <strong className="text-slate-800">Markdown (.md):</strong> # Epic, ## Story, and bullet points <code className="bg-white px-1 py-0.5 rounded border border-slate-200 font-mono text-[11px]">- AC 1: Given... When... Then...</code> or <code className="bg-white px-1 py-0.5 rounded border border-slate-200 font-mono text-[11px]">### Acceptance Criteria</code>.
                    </li>
                    <li>
                      <strong className="text-slate-800">Excel (.xlsx):</strong> 3-column table: Column A = Module / Epic, Column B = User Story, Column C = Acceptance Criteria.
                    </li>
                    <li>
                      <strong className="text-slate-800">Word (.docx):</strong> Structured document with Heading 1 (Epic), Heading 2 (Story), and bullet lists.
                    </li>
                    <li>
                      <strong className="text-slate-800">CSV (.csv):</strong> Header row containing <code className="bg-white px-1 py-0.5 rounded border border-slate-200 font-mono text-[11px]">title, parent_title, description, level</code>.
                    </li>
                  </ul>
                </div>
              )}

              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".docx,.xlsx,.md,.csv,.txt"
                className="hidden"
              />
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer ${
                  file
                    ? "border-blue-400 bg-blue-50/20"
                    : "border-slate-300 bg-slate-50/50 hover:bg-slate-50 hover:border-blue-400"
                }`}
              >
                {file ? (
                  <div className="flex items-center justify-between max-w-md mx-auto bg-white p-3 rounded-lg border border-slate-200 shadow-xs">
                    <div className="flex items-center gap-3 truncate">
                      {file.name.endsWith(".xlsx") ? (
                        <FileSpreadsheet className="text-emerald-600 shrink-0" size={24} />
                      ) : (
                        <FileText className="text-blue-600 shrink-0" size={24} />
                      )}
                      <div className="text-left truncate">
                        <p className="text-sm font-semibold text-slate-800 truncate">{file.name}</p>
                        <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                        setFileBase64("");
                      }}
                      className="p-1 text-slate-400 hover:text-red-500 rounded transition-colors"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <div>
                    <Upload className="mx-auto text-slate-400 mb-2" size={28} />
                    <p className="text-sm font-semibold text-slate-700">
                      {mode === "update"
                        ? "Click to browse or drag & drop new version file here"
                        : "Click to browse or drag & drop file here"}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      Supports Word (.docx), Excel (3-column .xlsx), Markdown (.md), and CSV
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* AI Provider & Model configuration */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-blue-600" />
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  AI Model Configuration
                </h4>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    AI Provider
                  </label>
                  <select
                    value={providerConfigId}
                    onChange={(e) => {
                      setProviderConfigId(e.target.value);
                      setIsCustomModel(false);
                    }}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  >
                    {providerConfigs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-600">
                      Model
                    </label>
                    {isCustomModel && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsCustomModel(false);
                          if (availableModels.length > 0) setModel(availableModels[0]);
                        }}
                        className="text-[11px] text-blue-600 hover:underline cursor-pointer"
                      >
                        Choose from list
                      </button>
                    )}
                  </div>
                  {isCustomModel ? (
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="e.g. gpt-4o, deepseek-chat"
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                      autoFocus
                    />
                  ) : (
                    <select
                      value={model}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setIsCustomModel(true);
                          setModel("");
                        } else {
                          setModel(e.target.value);
                        }
                      }}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer"
                    >
                      {availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">+ Enter custom model name...</option>
                    </select>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-400">
                The selected AI model parses the document, extracts module hierarchies, structures standard User Stories, and formats Acceptance Criteria.
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        ) : (
          /* Preview & Staging Studio */
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Parser Warnings Alert Banner */}
            {previewResult?.warnings && previewResult.warnings.length > 0 && showWarnings && (
              <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 space-y-1 shrink-0">
                <div className="flex items-center justify-between font-bold">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle size={15} className="text-amber-600" />
                    <span>Parser Warnings ({previewResult.warnings.length})</span>
                  </div>
                  <button
                    onClick={() => setShowWarnings(false)}
                    className="text-amber-600 hover:text-amber-800 text-[11px]"
                  >
                    Dismiss
                  </button>
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-700 max-h-20 overflow-y-auto">
                  {previewResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Top metrics filter bar & bulk selection */}
            {previewResult && (
              <div className="px-6 py-2.5 bg-slate-50/80 border-b border-slate-100 flex items-center justify-between text-xs shrink-0 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-600">Filters:</span>
                  <button
                    onClick={() => setDiffFilter("all")}
                    className={`px-2 py-0.5 rounded-full font-medium transition-colors ${
                      diffFilter === "all"
                        ? "bg-blue-600 text-white"
                        : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    All ({previewResult.stats.total})
                  </button>
                  {previewResult.stats.added > 0 && (
                    <button
                      onClick={() => setDiffFilter("added")}
                      className={`px-2 py-0.5 rounded-full font-medium transition-colors ${
                        diffFilter === "added"
                          ? "bg-emerald-600 text-white"
                          : "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      }`}
                    >
                      + {previewResult.stats.added} Added
                    </button>
                  )}
                  {previewResult.stats.modified > 0 && (
                    <button
                      onClick={() => setDiffFilter("modified")}
                      className={`px-2 py-0.5 rounded-full font-medium transition-colors ${
                        diffFilter === "modified"
                          ? "bg-amber-600 text-white"
                          : "bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                      }`}
                    >
                      ~ {previewResult.stats.modified} Modified
                    </button>
                  )}
                  {previewResult.stats.deprecated > 0 && (
                    <button
                      onClick={() => setDiffFilter("deprecated")}
                      className={`px-2 py-0.5 rounded-full font-medium transition-colors ${
                        diffFilter === "deprecated"
                          ? "bg-slate-600 text-white"
                          : "bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200"
                      }`}
                    >
                      - {previewResult.stats.deprecated} Deprecated
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSelectAll}
                      className="text-[11px] text-blue-600 hover:underline font-medium"
                    >
                      Include All
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      onClick={handleDeselectAll}
                      className="text-[11px] text-slate-500 hover:underline"
                    >
                      Exclude All
                    </button>
                  </div>
                  <span className="text-slate-300">|</span>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {previewResult.stats.epics} Epics · {previewResult.stats.stories} Stories · {previewResult.stats.acs} ACs
                  </div>
                </div>
              </div>
            )}

            {/* Dual pane review: Left Hierarchical Tree + Right Detail Inspection & Editor */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left Tree: Recursive rendering to prevent swallowing any nested stories or ACs */}
              <div className="w-88 border-r border-slate-200 bg-slate-50/50 overflow-y-auto p-3 space-y-1 shrink-0">
                {rootPreviewItems.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-400">
                    No items matching filter
                  </div>
                )}
                {rootPreviewItems.map((item) => (
                  <PreviewTreeNode
                    key={item.id}
                    item={item}
                    allItems={filteredItems}
                    selectedId={selectedPreviewId}
                    onSelect={(id) => setSelectedPreviewId(id)}
                    includedIds={includedIds}
                    onToggleInclude={toggleInclude}
                    depth={0}
                  />
                ))}
              </div>

              {/* Right Detail Inspection & Inline Editor */}
              <div className="flex-1 overflow-y-auto p-6 bg-white">
                {selectedItem ? (
                  <div className="space-y-5 max-w-2xl">
                    <div className="border-b border-slate-100 pb-4 space-y-3">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200">
                          {selectedItem.level}
                        </span>
                        {selectedItem.diffStatus && (
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                              selectedItem.diffStatus === "added"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : selectedItem.diffStatus === "deprecated"
                                ? "bg-red-50 text-red-700 border border-red-200"
                                : selectedItem.diffStatus === "modified"
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-slate-100 text-slate-500 border border-slate-200"
                            }`}
                          >
                            Status: {selectedItem.diffStatus}
                          </span>
                        )}
                        {selectedItem.sourceAnchor && (
                          <span className="text-[10.5px] text-slate-400 font-mono ml-auto">
                            Source: {selectedItem.sourceAnchor}
                          </span>
                        )}
                      </div>

                      {/* Editable Title */}
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                          Requirement Title
                        </label>
                        <input
                          type="text"
                          value={selectedItem.title}
                          onChange={(e) =>
                            handleUpdateItem(selectedItem.id, { title: e.target.value })
                          }
                          className="w-full text-base font-bold text-slate-900 border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg px-3 py-1.5 outline-none transition-colors"
                          placeholder="Requirement title..."
                        />
                      </div>

                      {/* Inclusion Toggle Button */}
                      <div className="flex items-center justify-between pt-1">
                        <button
                          type="button"
                          onClick={() => toggleInclude(selectedItem.id)}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold border transition-colors cursor-pointer ${
                            includedIds.has(selectedItem.id)
                              ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300"
                              : "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                          }`}
                        >
                          {includedIds.has(selectedItem.id) ? (
                            <>
                              <Square size={13} className="text-slate-500" />
                              <span>Exclude from Commit</span>
                            </>
                          ) : (
                            <>
                              <CheckSquare size={13} className="text-blue-600" />
                              <span>Include in Commit</span>
                            </>
                          )}
                        </button>

                        {selectedItem.level === "story" && (
                          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(selectedItem.isFlow)}
                              onChange={(e) =>
                                handleUpdateItem(selectedItem.id, { isFlow: e.target.checked })
                              }
                              className="rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                            />
                            <GitBranch size={13} className="text-purple-600" />
                            <span>Mark as Cross-Feature Flow Story</span>
                          </label>
                        )}
                      </div>
                    </div>

                    {/* Editable Description */}
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        Description / Specifications
                      </label>
                      <textarea
                        value={selectedItem.description}
                        onChange={(e) =>
                          handleUpdateItem(selectedItem.id, { description: e.target.value })
                        }
                        rows={4}
                        className="w-full text-xs font-mono border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg p-3 outline-none resize-none text-slate-700 leading-relaxed"
                        placeholder="Requirement description or Given/When/Then specification..."
                      />
                    </div>

                    {/* Formatted Preview for User Story */}
                    {selectedItem.level === "story" && (
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                          Standard User Story Visualization
                        </label>
                        {(() => {
                          const parsed = parseStoryMarkdown(selectedItem.description);
                          return (
                            <FormatSegmentBlock
                              variant="story"
                              segments={[
                                { label: "As a", content: parsed.role },
                                { label: "I want", content: parsed.action },
                                { label: "So that", content: parsed.value },
                              ]}
                              remainder={parsed.remainder}
                            />
                          );
                        })()}
                      </div>
                    )}

                    {/* Child Acceptance Criteria List (if story) */}
                    {selectedItem.level === "story" && childAcs.length > 0 && (
                      <div className="space-y-3 pt-2">
                        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
                          <span>Acceptance Criteria ({childAcs.length})</span>
                        </label>
                        <div className="space-y-2.5">
                          {childAcs.map((ac, idx) => {
                            const parsedAc = parseACMarkdown(ac.description);
                            return (
                              <div
                                key={ac.id}
                                className="p-3 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-2"
                              >
                                <div className="flex items-center justify-between text-xs">
                                  <span className="font-semibold text-slate-800">
                                    AC {idx + 1}: {ac.title}
                                  </span>
                                  {ac.sourceAnchor && (
                                    <span className="text-[10px] text-slate-400 font-mono">
                                      {ac.sourceAnchor}
                                    </span>
                                  )}
                                </div>
                                <FormatSegmentBlock
                                  variant="ac"
                                  segments={[
                                    { label: "Given", content: parsedAc.given },
                                    { label: "When", content: parsedAc.when },
                                    { label: "Then", content: parsedAc.then },
                                  ]}
                                  remainder={parsedAc.remainder}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                    Select an item from the left tree to inspect or edit
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
          {step === "config" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartParsing}
                disabled={!file || !fileBase64 || isParsing}
                className="px-5 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-200 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isParsing ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    AI is Reading &amp; Structuring...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    {mode === "update" ? "Start AI Parsing & Diff" : "Start AI Parsing"}
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep("config")}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-all"
              >
                Back to Config
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-all"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={isCommitting || includedCount === 0}
                  className="px-5 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-200 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isCommitting ? (
                    <>
                      <RefreshCw size={16} className="animate-spin" />
                      Saving to Database...
                    </>
                  ) : (
                    <>
                      <Check size={16} />
                      Commit {versionTag || previewResult.versionTag} ({includedCount})
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Recursive tree node component supporting arbitrary depth (Epics -> Stories -> Sub-stories -> ACs)
function PreviewTreeNode({
  item,
  allItems,
  selectedId,
  onSelect,
  includedIds,
  onToggleInclude,
  depth = 0,
}: {
  item: PrdParsedPreviewItem;
  allItems: PrdParsedPreviewItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  includedIds: Set<string>;
  onToggleInclude: (id: string) => void;
  depth?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const children = allItems.filter((i) => i.parentId === item.id);
  const isSelected = selectedId === item.id;
  const isIncluded = includedIds.has(item.id);

  const dotColor =
    item.level === "epic"
      ? "bg-purple-500"
      : item.level === "story"
      ? "bg-emerald-500"
      : "bg-blue-400";

  return (
    <div className="space-y-0.5">
      <div
        onClick={() => onSelect(item.id)}
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
          isSelected
            ? "bg-blue-50 text-slate-900 border border-blue-200 font-semibold"
            : "text-slate-700 hover:bg-slate-100"
        } ${!isIncluded ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(!collapsed);
            }}
            className="p-0.5 -ml-1 text-slate-400 hover:text-slate-600 rounded"
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <input
          type="checkbox"
          checked={isIncluded}
          onChange={(e) => {
            e.stopPropagation();
            onToggleInclude(item.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 shrink-0 cursor-pointer"
          title={isIncluded ? "Exclude from commit" : "Include in commit"}
        />

        <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
        <span
          className={`flex-1 truncate ${!isIncluded ? "line-through text-slate-400" : ""}`}
          title={item.title}
        >
          {item.title}
        </span>

        {item.level === "story" && item.isFlow && (
          <span className="text-[9px] font-semibold px-1 py-0.2 rounded bg-purple-50 text-purple-600 border border-purple-200 uppercase shrink-0">
            Flow
          </span>
        )}

        {item.diffStatus && item.diffStatus !== "unchanged" && (
          <span
            className={`text-[9px] font-bold px-1 py-0.2 rounded uppercase tracking-wider shrink-0 ${
              item.diffStatus === "added"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : item.diffStatus === "deprecated"
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}
          >
            {item.diffStatus}
          </span>
        )}
      </div>

      {children.length > 0 && !collapsed && (
        <div className="border-l border-slate-200 ml-3">
          {children.map((child) => (
            <PreviewTreeNode
              key={child.id}
              item={child}
              allItems={allItems}
              selectedId={selectedId}
              onSelect={onSelect}
              includedIds={includedIds}
              onToggleInclude={onToggleInclude}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
