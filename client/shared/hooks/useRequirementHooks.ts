import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/services/api';
import type { Requirement } from '../../../shared/contracts/index';

export function useRequirements(projectId: string) {
  return useQuery({
    queryKey: ['requirements', projectId],
    queryFn: () => api.requirements.listByProject(projectId),
    enabled: !!projectId,
  });
}

export function useRequirementMutations(projectId: string) {
  const qc = useQueryClient();
  const queryKey = ['requirements', projectId];
  const create = useMutation({
    mutationFn: (item: Omit<Requirement, 'id'> | Requirement) => api.requirements.create(item),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Requirement> }) => api.requirements.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const updateId = useMutation({
    mutationFn: ({ oldId, newId }: { oldId: string; newId: string }) => api.requirements.updateId(oldId, newId),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.requirements.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  return {
    create: (item) => create.mutateAsync(item),
    update: (id, data) => update.mutateAsync({ id, data }),
    updateId: (oldId: string, newId: string) => updateId.mutateAsync({ oldId, newId }),
    remove: (id) => remove.mutateAsync(id),
  };
}

export function usePrdDocuments(projectId: string) {
  return useQuery({
    queryKey: ['prd-documents', projectId],
    queryFn: () => api.requirements.listPrdDocuments(projectId),
    enabled: !!projectId,
  });
}

export function usePrdDocumentVersions(projectId: string, docId: string | null) {
  return useQuery({
    queryKey: ['prd-document-versions', projectId, docId],
    queryFn: () => docId ? api.requirements.getPrdDocumentVersions(projectId, docId) : Promise.resolve([]),
    enabled: Boolean(projectId && docId),
  });
}

export function usePrdDocumentDiff(
  projectId: string,
  docId: string | null,
  baseVersionId?: string,
  targetVersionId?: string,
  enabled: boolean = true
) {
  return useQuery({
    queryKey: ['prd-diff', projectId, docId, baseVersionId, targetVersionId],
    queryFn: () =>
      docId
        ? api.requirements.getPrdDocumentDiff(projectId, docId, baseVersionId, targetVersionId)
        : Promise.reject(new Error('Document ID is required')),
    enabled: Boolean(projectId && docId && enabled),
  });
}

export function usePrdDocumentMutations(projectId: string) {
  const qc = useQueryClient();
  const docsKey = ['prd-documents', projectId];
  const reqsKey = ['requirements', projectId];
  const versionsKey = ['prd-document-versions', projectId];

  const parsePreview = useMutation({
    mutationFn: (payload: {
      fileName: string;
      fileBase64: string;
      documentId?: string;
      documentTitle?: string;
      providerConfigId?: string;
      model?: string;
    }) => api.requirements.parsePreviewPrd(projectId, payload),
  });

  const commit = useMutation({
    mutationFn: (payload: {
      fileName: string;
      fileBase64: string;
      documentId?: string;
      documentTitle?: string;
      versionTag?: string;
      items: any[];
    }) => api.requirements.commitPrd(projectId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: docsKey });
      qc.invalidateQueries({ queryKey: reqsKey });
      qc.invalidateQueries({ queryKey: versionsKey });
    },
  });

  const removeDoc = useMutation({
    mutationFn: (arg: string | { docId: string; deleteRequirements?: boolean }) => {
      const docId = typeof arg === 'string' ? arg : arg.docId;
      const deleteRequirements = typeof arg === 'string' ? false : arg.deleteRequirements;
      return api.requirements.deletePrdDocument(projectId, docId, deleteRequirements);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: docsKey });
      qc.invalidateQueries({ queryKey: reqsKey });
      qc.invalidateQueries({ queryKey: versionsKey });
    },
  });

  const removeVersion = useMutation({
    mutationFn: ({ docId, versionId, deleteRequirements }: { docId: string; versionId: string; deleteRequirements?: boolean }) =>
      api.requirements.deletePrdDocumentVersion(projectId, docId, versionId, deleteRequirements ?? true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: docsKey });
      qc.invalidateQueries({ queryKey: reqsKey });
      qc.invalidateQueries({ queryKey: versionsKey });
    },
  });

  return {
    parsePreview: (payload: Parameters<typeof parsePreview.mutateAsync>[0]) => parsePreview.mutateAsync(payload),
    commit: (payload: Parameters<typeof commit.mutateAsync>[0]) => commit.mutateAsync(payload),
    removeDoc: (arg: Parameters<typeof removeDoc.mutateAsync>[0]) => removeDoc.mutateAsync(arg),
    removeVersion: (payload: Parameters<typeof removeVersion.mutateAsync>[0]) => removeVersion.mutateAsync(payload),
    isParsing: parsePreview.isPending,
    isCommitting: commit.isPending,
  };
}
