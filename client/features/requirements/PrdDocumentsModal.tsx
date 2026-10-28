import React, { useState, useEffect } from "react";
import {
  X,
  FileText,
  Download,
  Trash2,
  Calendar,
  FileSpreadsheet,
  Plus,
  Upload,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Layers,
  AlertTriangle,
  FileCode,
  GitCompare,
} from "lucide-react";
import type { PrdDocument, PrdDocumentVersion } from "../../../shared/contracts/index";
import {
  usePrdDocuments,
  usePrdDocumentVersions,
  usePrdDocumentMutations,
} from "../../shared/hooks/useQueryHooks";
import { PrdVersionDiffModal } from "./PrdVersionDiffModal";

function formatFileSize(bytes: number): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

interface VersionsListProps {
  projectId: string;
  doc: PrdDocument;
  onDeleteVersion: (v: PrdDocumentVersion) => void;
  onUploadNewVersion?: (doc: PrdDocument) => void;
  onCompareVersions?: (doc: PrdDocument, baseVerId?: string, targetVerId?: string) => void;
}

function DocumentVersionsList({ projectId, doc, onDeleteVersion, onUploadNewVersion, onCompareVersions }: VersionsListProps) {
  const { data: versions = [], isLoading } = usePrdDocumentVersions(projectId, doc.id);

  if (isLoading) {
    return (
      <div className="py-2.5 px-3 text-xs text-slate-400 bg-slate-50/70 rounded-lg border border-slate-100 flex items-center justify-center">
        Loading version history...
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="py-2.5 px-3 text-xs text-slate-400 bg-slate-50/70 rounded-lg border border-slate-100 flex items-center justify-between">
        <span>No recorded versions for this document.</span>
        {onUploadNewVersion && (
          <button
            type="button"
            onClick={() => onUploadNewVersion(doc)}
            className="text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline cursor-pointer flex items-center gap-1"
          >
            <Plus size={12} />
            <span>Upload Version</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-1.5 pl-3 border-l-2 border-blue-200">
      <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>Version History ({versions.length})</span>
          {versions.length >= 2 && onCompareVersions && (
            <button
              type="button"
              onClick={() => onCompareVersions(doc)}
              className="flex items-center gap-1 text-[11px] font-semibold text-purple-600 hover:text-purple-700 hover:underline cursor-pointer"
              title="Compare versions of this document"
            >
              <GitCompare size={11} />
              <span>Compare</span>
            </button>
          )}
        </div>
        {onUploadNewVersion && (
          <button
            type="button"
            onClick={() => onUploadNewVersion(doc)}
            className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
            title="Upload new version of this document"
          >
            <Plus size={11} />
            <span>Upload New Version</span>
          </button>
        )}
      </div>
      {versions.map((v) => {
        const isCurrent = v.id === doc.currentVersionId;
        return (
          <div
            key={v.id}
            className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-200/80 hover:bg-slate-100/70 transition-colors text-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono font-bold text-[11px] px-1.5 py-0.5 rounded bg-blue-100/80 text-blue-800 border border-blue-200 shrink-0">
                {v.versionTag || `v${v.versionNumber}`}
              </span>
              {isCurrent && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 shrink-0">
                  Current
                </span>
              )}
              <span className="text-slate-700 truncate font-medium max-w-[180px]" title={v.fileName}>
                {v.fileName}
              </span>
              <span className="text-slate-400 text-[11px] shrink-0">
                ({formatFileSize(v.fileSize)})
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500 shrink-0 flex items-center gap-1 text-[11px]">
                <CheckCircle2 size={11} className="text-emerald-500" />
                {v.itemCount ?? 0} reqs
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0 ml-2">
              {versions.length >= 2 && onCompareVersions && (
                <button
                  type="button"
                  onClick={() => onCompareVersions(doc, undefined, v.id)}
                  className="p-1 text-slate-400 hover:text-purple-600 hover:bg-white rounded transition-colors cursor-pointer"
                  title={`Compare ${v.versionTag || `v${v.versionNumber}`} with earlier version`}
                  aria-label={`Compare ${v.versionTag}`}
                >
                  <GitCompare size={13} />
                </button>
              )}
              <a
                href={`/api/requirements/${projectId}/documents/${doc.id}/versions/${v.id}/download`}
                download
                className="p-1 text-slate-400 hover:text-blue-600 hover:bg-white rounded transition-colors"
                title={`Download ${v.versionTag}`}
                aria-label={`Download ${v.versionTag}`}
              >
                <Download size={13} />
              </a>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteVersion(v);
                }}
                className="p-1 text-slate-400 hover:text-red-600 hover:bg-white rounded transition-colors cursor-pointer"
                title={`Delete version ${v.versionTag}`}
                aria-label={`Delete version ${v.versionTag}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onUploadNewVersion?: (doc: PrdDocument) => void;
  onNewPrd?: () => void;
}

export function PrdDocumentsModal({
  projectId,
  isOpen,
  onClose,
  onUploadNewVersion,
  onNewPrd,
}: Props) {
  const { data: documents = [], isLoading } = usePrdDocuments(projectId);
  const { removeDoc, removeVersion } = usePrdDocumentMutations(projectId);
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());

  const [deleteConfirmDoc, setDeleteConfirmDoc] = useState<PrdDocument | null>(null);
  const [deleteDocCascade, setDeleteDocCascade] = useState<boolean>(false);

  const [deleteConfirmVersion, setDeleteConfirmVersion] = useState<{
    doc: PrdDocument;
    version: PrdDocumentVersion;
  } | null>(null);
  const [deleteVersionCascade, setDeleteVersionCascade] = useState<boolean>(true);

  const [diffModalDoc, setDiffModalDoc] = useState<PrdDocument | null>(null);
  const [diffModalBaseId, setDiffModalBaseId] = useState<string | undefined>(undefined);
  const [diffModalTargetId, setDiffModalTargetId] = useState<string | undefined>(undefined);

  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (deleteConfirmVersion) {
          setDeleteConfirmVersion(null);
        } else if (deleteConfirmDoc) {
          setDeleteConfirmDoc(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose, deleteConfirmVersion, deleteConfirmDoc]);

  if (!isOpen) return null;

  const toggleExpand = (docId: string) => {
    setExpandedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const handleConfirmDeleteDoc = async () => {
    if (!deleteConfirmDoc) return;
    setIsDeleting(true);
    try {
      await removeDoc({ docId: deleteConfirmDoc.id, deleteRequirements: deleteDocCascade });
      setDeleteConfirmDoc(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleConfirmDeleteVersion = async () => {
    if (!deleteConfirmVersion) return;
    setIsDeleting(true);
    try {
      await removeVersion({
        docId: deleteConfirmVersion.doc.id,
        versionId: deleteConfirmVersion.version.id,
        deleteRequirements: deleteVersionCascade,
      });
      setDeleteConfirmVersion(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const getFormatIcon = (fileType: string) => {
    if (fileType === "xlsx" || fileType === "csv") {
      return (
        <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
          <FileSpreadsheet size={18} className="text-emerald-600" />
        </div>
      );
    }
    if (fileType === "markdown") {
      return (
        <div className="w-9 h-9 rounded-lg bg-purple-50 border border-purple-200 flex items-center justify-center shrink-0">
          <FileCode size={18} className="text-purple-600" />
        </div>
      );
    }
    return (
      <div className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center shrink-0">
        <FileText size={18} className="text-blue-600" />
      </div>
    );
  };

  return (
    <>
      {/* Main PRD Document Library Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] transition-opacity"
          onClick={onClose}
        />

        <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
          {/* Header */}
          <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <FileText size={20} className="text-blue-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  PRD Document Library
                </h2>
                <p className="text-xs text-slate-500">
                  Manage uploaded PRDs, track versions, and download original source files.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content list */}
          <div className="p-6 overflow-y-auto space-y-3 flex-1">
            {isLoading && (
              <div className="py-12 text-center text-slate-400 text-sm">
                Loading PRD documents...
              </div>
            )}

            {!isLoading && documents.length === 0 && (
              <div className="text-center py-12 px-4 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                <FileText size={36} className="mx-auto text-slate-300 mb-3" />
                <p className="text-sm font-semibold text-slate-700">No PRD documents uploaded</p>
                <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                  Upload your first Word (.docx), Excel (3-column .xlsx), or Markdown PRD to enable AI parsing and traceability.
                </p>
                {onNewPrd && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onNewPrd();
                    }}
                    className="mt-4 px-3.5 py-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-all inline-flex items-center gap-1.5"
                  >
                    <Upload size={14} />
                    Upload PRD Now
                  </button>
                )}
              </div>
            )}

            {!isLoading &&
              documents.map((doc) => {
                const isExpanded = expandedDocIds.has(doc.id);
                return (
                  <div
                    key={doc.id}
                    className="p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-xs transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3.5 min-w-0">
                        {getFormatIcon(doc.fileType)}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-slate-900 truncate">
                              {doc.title}
                            </h4>
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200">
                              {doc.currentVersionTag || "v1.0"}
                            </span>
                            <span
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wider border ${
                                doc.fileType === "xlsx" || doc.fileType === "csv"
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  : doc.fileType === "markdown"
                                  ? "bg-purple-50 text-purple-700 border-purple-200"
                                  : "bg-blue-50 text-blue-700 border-blue-200"
                              }`}
                            >
                              {doc.fileType}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                            <span className="flex items-center gap-1">
                              <CheckCircle2 size={12} className="text-emerald-500" />
                              {doc.itemCount ?? 0} requirements
                            </span>
                            <span>·</span>
                            <span className="flex items-center gap-1">
                              <Calendar size={12} />
                              {new Date(doc.createdAt).toLocaleDateString()}
                            </span>
                            <span>·</span>
                            <button
                              type="button"
                              onClick={() => toggleExpand(doc.id)}
                              className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium transition-colors cursor-pointer"
                              aria-label="Toggle version history"
                            >
                              <Layers size={12} />
                              <span>Versions</span>
                              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-4">
                        {doc.currentVersionId && (
                          <a
                            href={`/api/requirements/${projectId}/documents/${doc.id}/versions/${doc.currentVersionId}/download`}
                            download
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100"
                            title="Download current version file"
                          >
                            <Download size={15} />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setDiffModalBaseId(undefined);
                            setDiffModalTargetId(undefined);
                            setDiffModalDoc(doc);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors border border-purple-200 flex items-center gap-1 cursor-pointer"
                          title="Compare PRD Versions"
                        >
                          <GitCompare size={12} />
                          <span>Compare</span>
                        </button>
                        {onUploadNewVersion && (
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onUploadNewVersion(doc);
                            }}
                            className="px-2.5 py-1 text-xs font-semibold text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-slate-200 hover:border-blue-200 flex items-center gap-1 cursor-pointer"
                            title="Upload new version"
                          >
                            <Plus size={12} />
                            New Version
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmDoc(doc);
                            setDeleteDocCascade(false);
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                          title="Delete document"
                          aria-label="Delete document"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <DocumentVersionsList
                        projectId={projectId}
                        doc={doc}
                        onUploadNewVersion={(d) => {
                          onClose();
                          onUploadNewVersion(d);
                        }}
                        onDeleteVersion={(v) => {
                          setDeleteConfirmVersion({ doc, version: v });
                          setDeleteVersionCascade(true);
                        }}
                        onCompareVersions={(d, baseId, targetId) => {
                          setDiffModalBaseId(baseId);
                          setDiffModalTargetId(targetId);
                          setDiffModalDoc(d);
                        }}
                      />
                    )}
                  </div>
                );
              })}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
            <p className="text-xs text-slate-400">
              {documents.length} document{documents.length === 1 ? "" : "s"} archived
            </p>
            <div className="flex items-center gap-2">
              {onNewPrd && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onNewPrd();
                  }}
                  className="px-3.5 py-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus size={14} />
                  Upload New PRD
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200/60 rounded-lg transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Version Confirmation Modal - rendered in front with z-index 100 */}
      {deleteConfirmVersion && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ zIndex: 100 }}
        >
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
            onClick={() => !isDeleting && setDeleteConfirmVersion(null)}
          />
          <div
            className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
            style={{ zIndex: 101 }}
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold text-slate-900 mb-1">
                    Delete Version {deleteConfirmVersion.version.versionTag}
                  </h3>
                  <p className="text-xs text-slate-500 leading-relaxed mb-3">
                    Are you sure you want to delete version <strong className="text-slate-700">{deleteConfirmVersion.version.versionTag}</strong> ({deleteConfirmVersion.version.fileName}) from &ldquo;{deleteConfirmVersion.doc.title}&rdquo;?
                  </p>

                  <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl mb-3 text-xs text-amber-800">
                    <span className="font-semibold">{deleteConfirmVersion.version.itemCount ?? 0} requirement(s)</span> were generated in this PRD version.
                  </div>

                  <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={deleteVersionCascade}
                      onChange={(e) => setDeleteVersionCascade(e.target.checked)}
                      className="mt-0.5 rounded text-red-600 focus:ring-red-500 border-slate-300"
                    />
                    <div className="text-xs">
                      <span className="font-semibold text-slate-800">
                        Also delete all {deleteConfirmVersion.version.itemCount ?? 0} generated requirements
                      </span>
                      <p className="text-slate-500 text-[11px] mt-0.5">
                        {deleteVersionCascade
                          ? "Permanently remove all requirements generated by this version from the requirements tree."
                          : "Keep requirements in the tree as standalone items, unlinked from this version."}
                      </p>
                    </div>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => !isDeleting && setDeleteConfirmVersion(null)}
                  className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 flex items-center justify-end gap-2.5 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDeleteConfirmVersion(null)}
                disabled={isDeleting}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteVersion}
                disabled={isDeleting}
                aria-label="Confirm delete version"
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:bg-red-300 rounded-lg shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 size={13} />
                <span>{isDeleting ? "Deleting..." : "Delete Version"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Document Confirmation Modal - rendered in front with z-index 100 */}
      {deleteConfirmDoc && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ zIndex: 100 }}
        >
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
            onClick={() => !isDeleting && setDeleteConfirmDoc(null)}
          />
          <div
            className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
            style={{ zIndex: 101 }}
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold text-slate-900 mb-1">
                    Delete PRD Document
                  </h3>
                  <p className="text-xs text-slate-500 leading-relaxed mb-3">
                    Are you sure you want to delete <strong className="text-slate-700">&ldquo;{deleteConfirmDoc.title}&rdquo;</strong> and all its version records?
                  </p>

                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl mb-3 text-xs text-slate-700">
                    <span className="font-semibold">{deleteConfirmDoc.itemCount ?? 0} requirement(s)</span> are associated with this PRD document.
                  </div>

                  <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={deleteDocCascade}
                      onChange={(e) => setDeleteDocCascade(e.target.checked)}
                      className="mt-0.5 rounded text-red-600 focus:ring-red-500 border-slate-300"
                    />
                    <div className="text-xs">
                      <span className="font-semibold text-slate-800">
                        Also delete all {deleteConfirmDoc.itemCount ?? 0} generated requirements
                      </span>
                      <p className="text-slate-500 text-[11px] mt-0.5">
                        {deleteDocCascade
                          ? "Permanently remove all requirements belonging to this PRD from the requirements tree."
                          : "Keep requirements in the tree as standalone items, clearing their PRD document link."}
                      </p>
                    </div>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => !isDeleting && setDeleteConfirmDoc(null)}
                  className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 flex items-center justify-end gap-2.5 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDeleteConfirmDoc(null)}
                disabled={isDeleting}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteDoc}
                disabled={isDeleting}
                aria-label="Confirm delete document"
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:bg-red-300 rounded-lg shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 size={13} />
                <span>{isDeleting ? "Deleting..." : "Delete Document"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PRD Version Diff Viewer Modal */}
      {diffModalDoc && (
        <PrdVersionDiffModal
          projectId={projectId}
          document={diffModalDoc}
          isOpen={Boolean(diffModalDoc)}
          onClose={() => {
            setDiffModalDoc(null);
            setDiffModalBaseId(undefined);
            setDiffModalTargetId(undefined);
          }}
          initialBaseVersionId={diffModalBaseId}
          initialTargetVersionId={diffModalTargetId}
        />
      )}
    </>
  );
}
