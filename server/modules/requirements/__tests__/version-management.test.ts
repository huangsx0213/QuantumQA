import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { requirementRepo } from '../repository.ts';
import { db } from '../../../shared/db/client.ts';
import { randomId } from '../../../shared/utils/index.ts';

describe('PRD Document Version Management & Cascade Deletion', () => {
  const testProjectId = 'proj-test-ver-mgmt';
  let tempFilePath: string | null = null;

  beforeEach(() => {
    // Ensure test project exists in database
    db.prepare(`
      INSERT OR IGNORE INTO projects (id, name, description)
      VALUES (?, 'Test Project', 'Testing version deletion')
    `).run(testProjectId);
  });

  afterEach(() => {
    // Clean up test data
    try {
      db.prepare('DELETE FROM requirements WHERE project_id = ?').run(testProjectId);
      const docs = db.prepare('SELECT id FROM prd_documents WHERE project_id = ?').all(testProjectId) as Array<{ id: string }>;
      for (const d of docs) {
        db.prepare('DELETE FROM prd_document_versions WHERE document_id = ?').run(d.id);
      }
      db.prepare('DELETE FROM prd_documents WHERE project_id = ?').run(testProjectId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(testProjectId);
    } catch {}

    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  });

  it('deletes a version and cascades deletion to generated requirements', () => {
    const doc = requirementRepo.saveDocument({
      projectId: testProjectId,
      title: 'Checkout Flow PRD',
      fileType: 'markdown',
    });

    const v1 = requirementRepo.saveDocumentVersion({
      documentId: doc.id,
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'checkout_v1.md',
      itemCount: 2,
    });

    const v2 = requirementRepo.saveDocumentVersion({
      documentId: doc.id,
      versionNumber: 2,
      versionTag: 'v2.0',
      fileName: 'checkout_v2.md',
      itemCount: 1,
    });

    // Create requirements for v1
    const r1 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Cart Review',
      description: 'Review cart items',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v1.id,
      sourceAnchor: 'Heading: Cart Review',
    });

    const r2 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Price Calculation',
      description: 'Calculate subtotals',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v1.id,
      sourceAnchor: 'Heading: Price Calculation',
    });

    // Create requirement for v2
    const r3 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Apply Coupon Code',
      description: 'Support promo codes',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v2.id,
      sourceAnchor: 'Heading: Coupon Code',
    });

    // Verify parent document current version is v2
    const docBefore = requirementRepo.getDocument(doc.id);
    expect(docBefore?.currentVersionId).toBe(v2.id);

    // Delete v2 with deleteRequirements = true
    const result = requirementRepo.deleteDocumentVersion(doc.id, v2.id, true);
    expect(result.deletedRequirementsCount).toBe(1);

    // r3 should be deleted
    expect(requirementRepo.get(r3.id)).toBeUndefined();

    // r1 and r2 from v1 must remain intact
    const fetchedR1 = requirementRepo.get(r1.id);
    const fetchedR2 = requirementRepo.get(r2.id);
    expect(fetchedR1).toBeDefined();
    expect(fetchedR1?.documentVersionId).toBe(v1.id);
    expect(fetchedR2).toBeDefined();
    expect(fetchedR2?.documentVersionId).toBe(v1.id);

    // Document current_version_id should automatically revert to v1
    const docAfter = requirementRepo.getDocument(doc.id);
    expect(docAfter?.currentVersionId).toBe(v1.id);
  });

  it('unlinks requirements without deleting them when deleteRequirements is false', () => {
    const doc = requirementRepo.saveDocument({
      projectId: testProjectId,
      title: 'Auth PRD',
      fileType: 'markdown',
    });

    const v1 = requirementRepo.saveDocumentVersion({
      documentId: doc.id,
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'auth_v1.md',
      itemCount: 1,
    });

    const r1 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Google OAuth',
      description: 'Login with Google',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v1.id,
      sourceAnchor: 'Heading: Google OAuth',
    });

    // Delete v1 with deleteRequirements = false
    const result = requirementRepo.deleteDocumentVersion(doc.id, v1.id, false);
    expect(result.deletedRequirementsCount).toBe(0);

    // r1 should still exist, but documentVersionId and sourceAnchor should be cleared
    const fetched = requirementRepo.get(r1.id);
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe('Google OAuth');
    expect(fetched?.documentVersionId).toBeFalsy();
    expect(fetched?.sourceAnchor).toBeFalsy();

    // Document should now have 0 versions and current_version_id = null
    const docAfter = requirementRepo.getDocument(doc.id);
    expect(docAfter?.currentVersionId).toBeNull();
  });

  it('removes storage file from disk when version is deleted', () => {
    const storageDir = path.resolve(process.cwd(), 'server/storage/prd-files/test');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    tempFilePath = path.join(storageDir, `${randomId('file')}_sample.md`);
    fs.writeFileSync(tempFilePath, '# Test Document Content', 'utf-8');

    const relativePath = path.relative(process.cwd(), tempFilePath);

    const doc = requirementRepo.saveDocument({
      projectId: testProjectId,
      title: 'File Test PRD',
      fileType: 'markdown',
    });

    const v1 = requirementRepo.saveDocumentVersion({
      documentId: doc.id,
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'sample.md',
      storagePath: relativePath,
      itemCount: 0,
    });

    expect(fs.existsSync(tempFilePath)).toBe(true);

    requirementRepo.deleteDocumentVersion(doc.id, v1.id, true);

    // File should have been removed from disk
    expect(fs.existsSync(tempFilePath)).toBe(false);
  });

  it('deletes document and cascades requirement deletion when deleteRequirements = true', () => {
    const doc = requirementRepo.saveDocument({
      projectId: testProjectId,
      title: 'Whole Doc PRD',
      fileType: 'markdown',
    });

    const v1 = requirementRepo.saveDocumentVersion({
      documentId: doc.id,
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'doc_v1.md',
      itemCount: 2,
    });

    const r1 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Doc Story 1',
      description: '',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v1.id,
    });

    const r2 = requirementRepo.save({
      projectId: testProjectId,
      title: 'Doc Story 2',
      description: '',
      level: 'story',
      status: 'APPROVED',
      documentId: doc.id,
      documentVersionId: v1.id,
    });

    const result = requirementRepo.deleteDocument(doc.id, true);
    expect(result.deletedRequirementsCount).toBe(2);

    expect(requirementRepo.get(r1.id)).toBeUndefined();
    expect(requirementRepo.get(r2.id)).toBeUndefined();
    expect(requirementRepo.getDocument(doc.id)).toBeUndefined();
    expect(requirementRepo.getDocumentVersions(doc.id).length).toBe(0);
  });

  it('compares two versions via GET /:projectId/documents/:docId/diff endpoint', async () => {
    const { createApp } = await import('../../../app/createApp.ts');
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const doc = requirementRepo.saveDocument({
        projectId: testProjectId,
        title: 'API Versioned Spec',
        fileType: 'markdown',
      });

      // Attempting diff with 0 versions -> 400
      const res0 = await fetch(`${baseUrl}/api/requirements/${testProjectId}/documents/${doc.id}/diff`);
      expect(res0.status).toBe(400);

      // Create dummy storage files
      const storageDir = path.resolve(process.cwd(), 'server/storage/prd-files', testProjectId);
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }

      const f1Path = path.join(storageDir, 'test_v1.md');
      const f2Path = path.join(storageDir, 'test_v2.md');
      fs.writeFileSync(f1Path, `# Module 1\n## Story A\nGiven condition A\nWhen event A\nThen result A`);
      fs.writeFileSync(f2Path, `# Module 1\n## Story A\nGiven condition A\nWhen event A\nThen result A (updated)\n## Story B\nGiven B\nWhen B\nThen B`);

      const v1 = requirementRepo.saveDocumentVersion({
        documentId: doc.id,
        versionNumber: 1,
        versionTag: 'v1.0',
        fileName: 'test_v1.md',
        storagePath: `server/storage/prd-files/${testProjectId}/test_v1.md`,
        itemCount: 3,
      });

      // Still only 1 version -> 400
      const res1 = await fetch(`${baseUrl}/api/requirements/${testProjectId}/documents/${doc.id}/diff`);
      expect(res1.status).toBe(400);

      const v2 = requirementRepo.saveDocumentVersion({
        documentId: doc.id,
        versionNumber: 2,
        versionTag: 'v1.1',
        fileName: 'test_v2.md',
        storagePath: `server/storage/prd-files/${testProjectId}/test_v2.md`,
        itemCount: 5,
      });

      // Now 2 versions -> 200 with full diff stats
      const res2 = await fetch(`${baseUrl}/api/requirements/${testProjectId}/documents/${doc.id}/diff`);
      expect(res2.status).toBe(200);
      const data = await res2.json();

      expect(data.documentId).toBe(doc.id);
      expect(data.baseVersion.versionTag).toBe('v1.0');
      expect(data.targetVersion.versionTag).toBe('v1.1');
      expect(data.stats.total).toBeGreaterThan(0);
      expect(data.stats.added).toBeGreaterThan(0); // Story B was added
      expect(data.items.some((i: any) => i.title.includes('Story B') && i.diffStatus === 'added')).toBe(true);

      // Cleanup files
      try { fs.unlinkSync(f1Path); } catch {}
      try { fs.unlinkSync(f2Path); } catch {}
    } finally {
      server.close();
    }
  });
});
