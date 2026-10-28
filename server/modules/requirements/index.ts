import { Router } from 'express';
import { createCrudModule, getParam } from '../../shared/http/crud.ts';
import { requirementRepo } from './repository.ts';
import { normalizeRequirement } from './mapper.ts';
import { requirementPayloadSchema, requirementPatchSchema } from './schema.ts';
import { withErrorHandling } from '../../shared/http/async-handler.ts';
import { ValidationError } from '../../shared/http/errors.ts';

const baseModule = createCrudModule({
  basePath: '/api/requirements',
  repository: requirementRepo,
  normalize: normalizeRequirement,
  createSchema: requirementPayloadSchema,
  patchSchema: requirementPatchSchema,
});

const router = baseModule.router as Router;

router.get('/by-project/:projectId', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  res.json(requirementRepo.listByProject(projectId));
}));

// Update a requirement's primary key id with cascade updates for parentId
// and relatedRequirementIds references. Body: { newId: string }.
router.put('/:id/id', withErrorHandling(async (req, res) => {
  const oldId = getParam(req.params.id);
  const newId = String(req.body?.newId ?? '').trim();
  if (!newId) {
    throw new ValidationError('newId is required.');
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(newId)) {
    throw new ValidationError('newId must start with a letter and contain only letters, digits, hyphens, or underscores.');
  }
  const existing = requirementRepo.get(oldId);
  if (!existing) {
    throw new ValidationError(`Requirement ${oldId} not found.`);
  }
  if (newId === oldId) {
    res.json(existing);
    return;
  }
  const collision = requirementRepo.get(newId);
  if (collision) {
    throw new ValidationError(`ID "${newId}" is already used by another requirement.`);
  }
  requirementRepo.updateId(oldId, newId);
  res.json(requirementRepo.get(newId));
}));

// --- PRD Document Endpoints ---

router.get('/:projectId/documents', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  res.json(requirementRepo.listDocuments(projectId));
}));

router.get('/:projectId/documents/:docId/versions', withErrorHandling(async (req, res) => {
  const docId = getParam(req.params.docId);
  res.json(requirementRepo.getDocumentVersions(docId));
}));

router.get('/:projectId/documents/:docId/diff', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const docId = getParam(req.params.docId);
  const doc = requirementRepo.getDocument(docId);
  if (!doc || doc.projectId !== projectId) {
    res.status(404).json({ error: 'Document not found in this project' });
    return;
  }

  const versions = requirementRepo.getDocumentVersions(docId);
  if (versions.length < 2) {
    res.status(400).json({ error: 'At least two versions are required to compare differences.' });
    return;
  }

  const sortedAsc = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);

  const baseVerId = req.query.baseVersionId as string | undefined;
  const targetVerId = req.query.targetVersionId as string | undefined;

  // Default: base = earlier version (v1.0), target = latest version (v1.1)
  const baseVersion = baseVerId
    ? versions.find((v) => v.id === baseVerId)
    : sortedAsc[0];
  const targetVersion = targetVerId
    ? versions.find((v) => v.id === targetVerId)
    : sortedAsc[sortedAsc.length - 1];

  if (!baseVersion || !targetVersion) {
    res.status(400).json({ error: 'Specified version(s) not found for this document.' });
    return;
  }

  const fs = await import('fs');
  const path = await import('path');
  const { parsePrdDocument, computePrdDiff } = await import('./prd-parser.ts');

  const baseFilePath = path.resolve(process.cwd(), baseVersion.storagePath);
  const targetFilePath = path.resolve(process.cwd(), targetVersion.storagePath);

  if (!fs.existsSync(baseFilePath) || !fs.existsSync(targetFilePath)) {
    res.status(404).json({ error: 'One or both version source files are not found on disk.' });
    return;
  }

  const baseBuf = fs.readFileSync(baseFilePath);
  const targetBuf = fs.readFileSync(targetFilePath);

  const baseParsed = await parsePrdDocument({
    fileName: baseVersion.fileName,
    buffer: baseBuf,
    projectId,
    documentTitle: doc.title,
  });

  const targetParsed = await parsePrdDocument({
    fileName: targetVersion.fileName,
    buffer: targetBuf,
    projectId,
    documentTitle: doc.title,
  });

  const baseReqs = baseParsed.items.map((i, idx) => ({
    id: i.id || `base-${idx}`,
    projectId,
    parentId: i.parentId || null,
    title: i.title,
    description: i.description || '',
    level: i.level,
    status: 'APPROVED' as const,
    position: idx,
    sourceAnchor: i.sourceAnchor,
  }));

  const diffResult = computePrdDiff(targetParsed.items, baseReqs);

  let unchanged = 0;
  let modified = 0;
  let added = 0;
  let epics = 0;
  let stories = 0;
  let acs = 0;

  for (const item of diffResult.items) {
    if (item.level === 'epic') epics++;
    else if (item.level === 'story') stories++;
    else if (item.level === 'ac') acs++;

    if (item.diffStatus === 'unchanged') unchanged++;
    else if (item.diffStatus === 'modified') modified++;
    else if (item.diffStatus === 'added') added++;
  }

  res.json({
    documentId: doc.id,
    documentTitle: doc.title,
    baseVersion,
    targetVersion,
    stats: {
      total: diffResult.items.length,
      epics,
      stories,
      acs,
      added,
      modified,
      deprecated: diffResult.deprecatedCount,
      unchanged,
    },
    items: diffResult.items,
  });
}));

router.post('/:projectId/documents/parse-preview', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const { fileName, fileBase64, documentId, documentTitle, providerConfigId, model } = req.body;
  if (!fileName || !fileBase64) {
    throw new ValidationError('fileName and fileBase64 are required.');
  }

  const buffer = Buffer.from(fileBase64, 'base64');
  let existingRequirements: any[] = [];
  let existingVersionsCount = 0;
  if (documentId) {
    const all = requirementRepo.listByProject(projectId);
    existingRequirements = all.filter((r) => r.documentId === documentId);
    existingVersionsCount = requirementRepo.getDocumentVersions(documentId).length;
  }

  const result = await (await import('./prd-parser.ts')).parsePrdDocument({
    fileName,
    buffer,
    projectId,
    documentTitle: documentTitle || fileName,
    providerConfigId,
    model,
    existingRequirements,
    existingVersionsCount,
  });

  res.json(result);
}));

router.post('/:projectId/documents/commit', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const { fileName, fileBase64, documentId, documentTitle, versionTag, items: rawItems } = req.body;
  if (!fileName || !fileBase64 || !Array.isArray(rawItems)) {
    throw new ValidationError('fileName, fileBase64, and items array are required.');
  }

  const { compilePrdGate } = await import('./prd-parser.ts');
  const compileResult = compilePrdGate(rawItems);
  const items = compileResult.items;

  const fileExt = fileName.split('.').pop()?.toLowerCase() || 'docx';
  const fileType = (fileExt === 'xlsx' || fileExt === 'xls')
    ? 'xlsx'
    : (fileExt === 'csv' ? 'csv' : (fileExt === 'md' ? 'markdown' : 'docx'));

  const fileBuffer = Buffer.from(fileBase64, 'base64');
  const storageDir = (await import('path')).resolve(process.cwd(), 'server/storage/prd-files', projectId);
  const fs = await import('fs');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const verId = (await import('../../shared/utils/index.ts')).randomId('docver');
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = (await import('path')).join(storageDir, `${verId}_${safeName}`);
  fs.writeFileSync(storagePath, fileBuffer);

  const { db } = await import('../../shared/db/client.ts');

  try {
    const commitTx = db.transaction(() => {
      // 1. Create or get PRD Document
      let doc = documentId ? requirementRepo.getDocument(documentId) : null;
      if (!doc) {
        doc = requirementRepo.saveDocument({
          projectId,
          title: documentTitle || fileName.replace(/\.[^/.]+$/, ''),
          fileType: fileType as any,
        });
      }

      // 2. Create Document Version
      const existingVersions = requirementRepo.getDocumentVersions(doc.id);
      const versionNumber = existingVersions.length + 1;
      const finalVersionTag = versionTag || `v1.${versionNumber - 1}`;

      // Count active requirements for this version (excluding deprecated ones that only exist from earlier versions)
      const activeItems = items.filter((i) => i.diffStatus !== 'deprecated');
      const addedCount = items.filter((i) => i.diffStatus === 'added').length;
      const modifiedCount = items.filter((i) => i.diffStatus === 'modified').length;
      const unchangedCount = items.filter((i) => i.diffStatus === 'unchanged').length;
      const deprecatedCount = items.filter((i) => i.diffStatus === 'deprecated').length;

      requirementRepo.saveDocumentVersion({
        id: verId,
        documentId: doc.id,
        versionNumber,
        versionTag: finalVersionTag,
        fileName,
        fileSize: fileBuffer.length,
        storagePath: `server/storage/prd-files/${projectId}/${verId}_${safeName}`,
        parsedSummary: `${activeItems.length} active requirements (${addedCount} added, ${modifiedCount} modified, ${unchangedCount} unchanged, ${deprecatedCount} deprecated)`,
        itemCount: activeItems.length,
      });

      // 3. Save items into requirements table
      const existingItemsInProject = requirementRepo.listByProject(projectId);
      const maxExistingPos = existingItemsInProject.reduce(
        (max, r) => Math.max(max, typeof r.position === 'number' ? r.position : 0),
        0
      );

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const existingItem = item.id ? requirementRepo.get(item.id) : null;

        let status: 'DRAFT' | 'APPROVED' | 'DEPRECATED' = 'APPROVED';
        let docVerId = verId;

        if (item.diffStatus === 'deprecated') {
          status = 'DEPRECATED';
          // Deprecated items belong to the earlier version where they were last active, not the new version that removed them
          if (existingItem?.documentVersionId) {
            docVerId = existingItem.documentVersionId;
          }
        } else if (existingItem?.documentVersionId) {
          // Preserve originating version ID for requirements created in earlier versions
          docVerId = existingItem.documentVersionId;
          if (item.diffStatus === 'unchanged') {
            status = existingItem.status;
          }
        } else {
          // Brand new requirement introduced in this version
          docVerId = verId;
        }

        const position = existingItem && typeof existingItem.position === 'number'
          ? existingItem.position
          : maxExistingPos + 1 + idx;

        requirementRepo.save({
          id: item.id,
          projectId,
          parentId: item.parentId || null,
          title: item.title,
          description: item.description,
          level: item.level || 'story',
          status,
          position,
          isFlow: Boolean(item.isFlow),
          flowType: item.flowType || null,
          documentId: doc.id,
          documentVersionId: docVerId,
          sourceAnchor: item.sourceAnchor || null,
        });

        // Record version membership: active items exist in this version
        if (item.diffStatus !== 'deprecated') {
          requirementRepo.linkVersionItem(verId, item.id, item.diffStatus || 'added');
        }
      }

      return doc;
    });

    const doc = commitTx();

    res.json({
      documentId: doc.id,
      versionId: verId,
      importedCount: items.length,
      warnings: compileResult.warnings.length > 0 ? compileResult.warnings : undefined,
    });
  } catch (err) {
    if (fs.existsSync(storagePath)) {
      try { fs.unlinkSync(storagePath); } catch {}
    }
    throw err;
  }
}));

router.delete('/:projectId/documents/:docId', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const docId = getParam(req.params.docId);
  const doc = requirementRepo.getDocument(docId);
  if (!doc || doc.projectId !== projectId) {
    res.status(404).json({ error: 'Document not found in this project' });
    return;
  }
  const deleteRequirements = req.query.deleteRequirements === 'true';
  const result = requirementRepo.deleteDocument(docId, deleteRequirements);
  res.json(result);
}));

router.delete('/:projectId/documents/:docId/versions/:versionId', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const docId = getParam(req.params.docId);
  const versionId = getParam(req.params.versionId);
  const doc = requirementRepo.getDocument(docId);
  if (!doc || doc.projectId !== projectId) {
    res.status(404).json({ error: 'Document not found in this project' });
    return;
  }
  const deleteRequirements = req.query.deleteRequirements !== 'false';
  const result = requirementRepo.deleteDocumentVersion(docId, versionId, deleteRequirements);
  res.json(result);
}));

router.get('/:projectId/documents/:docId/versions/:versionId/download', withErrorHandling(async (req, res) => {
  const projectId = getParam(req.params.projectId);
  const docId = getParam(req.params.docId);
  const versionId = getParam(req.params.versionId);

  const doc = requirementRepo.getDocument(docId);
  if (!doc || doc.projectId !== projectId) {
    res.status(404).json({ error: 'Document not found in this project' });
    return;
  }

  const versions = requirementRepo.getDocumentVersions(docId);
  const version = versions.find((v) => v.id === versionId);
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.resolve(process.cwd(), version.storagePath);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Original file not found on disk' });
    return;
  }

  res.download(filePath, version.fileName);
}));

export const requirementsModule = { basePath: '/api/requirements', router };