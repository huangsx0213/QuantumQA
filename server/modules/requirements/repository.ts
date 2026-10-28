import fs from 'node:fs';
import path from 'path';
import type { Requirement } from '../../shared/contracts/index.ts';
import { db } from '../../shared/db/client.ts';
import { BaseCrudRepository } from '../../shared/db/BaseCrudRepository.ts';
import type { DbRequirementRow } from '../../shared/db/types.ts';
import { randomId } from '../../shared/utils/index.ts';
import { validateRequirementFlowType, validateRequirementIsFlow, validateRelatedRequirementIds } from './validation.ts';
import { regenerateIndexFile } from './index-generator.ts';

class RequirementRepository extends BaseCrudRepository<Requirement> {
  protected table = 'requirements';

  list(): Requirement[] {
    const rows = db.prepare('SELECT * FROM requirements ORDER BY position, rowid').all() as DbRequirementRow[];
    return rows.map(r => this.rowToRequirement(r));
  }

  listByProject(projectId: string): Requirement[] {
    const rows = db.prepare(
      'SELECT * FROM requirements WHERE project_id = ? ORDER BY position, rowid'
    ).all(projectId) as DbRequirementRow[];

    const versionIdsByReq = new Map<string, string[]>();
    try {
      const verItemRows = db.prepare(`
        SELECT version_id, requirement_id
        FROM prd_document_version_items
      `).all() as Array<{ version_id: string; requirement_id: string }>;

      for (const row of verItemRows) {
        const list = versionIdsByReq.get(row.requirement_id);
        if (list) {
          list.push(row.version_id);
        } else {
          versionIdsByReq.set(row.requirement_id, [row.version_id]);
        }
      }
    } catch {
      // Table may not exist yet in early migration stages
    }

    return rows.map(r => {
      const req = this.rowToRequirement(r);
      const vIds = versionIdsByReq.get(r.id);
      if (vIds && vIds.length > 0) {
        req.versionIds = vIds;
      } else if (req.documentVersionId) {
        req.versionIds = [req.documentVersionId];
      }
      return req;
    });
  }

  linkVersionItem(versionId: string, requirementId: string, diffStatus = 'added'): void {
    try {
      db.prepare(`
        INSERT INTO prd_document_version_items (version_id, requirement_id, diff_status)
        VALUES (?, ?, ?)
        ON CONFLICT(version_id, requirement_id) DO UPDATE SET diff_status = excluded.diff_status
      `).run(versionId, requirementId, diffStatus);
    } catch {
      // Table may not exist yet
    }
  }

  remove(id: string): void {
    const existing = this.get(id);
    db.prepare('DELETE FROM requirements WHERE id = ?').run(id);
    if (existing) { regenerateIndexFile(existing.projectId); }
  }

  get(id: string): Requirement | undefined {
    const row = db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as DbRequirementRow | undefined;
    if (!row) return undefined;
    return this.rowToRequirement(row);
  }

  save(record: Partial<Requirement>): Requirement {
    const id = record.id || randomId('req');
    const existing = record.id ? this.get(record.id) : null;
    const normalizedRecord = {
      ...existing,
      ...record,
      id,
      projectId: record.projectId || existing?.projectId || '',
    } as Requirement;

    validateRequirementFlowType(normalizedRecord);
    validateRequirementIsFlow(normalizedRecord);
    validateRelatedRequirementIds(normalizedRecord, this.listByProject(normalizedRecord.projectId));

    db.prepare(`
      INSERT INTO requirements (id, project_id, parent_id, title, description, level, status, position, flow_type, is_flow, related_requirement_ids, document_id, document_version_id, source_anchor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        parent_id = excluded.parent_id,
        title = excluded.title,
        description = excluded.description,
        level = excluded.level,
        status = excluded.status,
        position = excluded.position,
        flow_type = excluded.flow_type,
        is_flow = excluded.is_flow,
        related_requirement_ids = excluded.related_requirement_ids,
        document_id = excluded.document_id,
        document_version_id = excluded.document_version_id,
        source_anchor = excluded.source_anchor,
        updated_at = datetime('now')
    `).run(
      id,
      record.projectId || existing?.projectId || '',
      record.parentId !== undefined ? (record.parentId || null) : (existing?.parentId || null),
      record.title || existing?.title || '',
      record.description ?? existing?.description ?? '',
      record.level || existing?.level || 'story',
      record.status || existing?.status || 'DRAFT',
      record.position ?? existing?.position ?? 0,
      record.flowType !== undefined ? (record.flowType || null) : (existing?.flowType || null),
      record.isFlow !== undefined ? (record.isFlow ? 1 : 0) : (existing?.isFlow ? 1 : 0),
      JSON.stringify(record.relatedRequirementIds ?? existing?.relatedRequirementIds ?? []),
      record.documentId !== undefined ? (record.documentId || null) : (existing?.documentId || null),
      record.documentVersionId !== undefined ? (record.documentVersionId || null) : (existing?.documentVersionId || null),
      record.sourceAnchor !== undefined ? (record.sourceAnchor || null) : (existing?.sourceAnchor || null),
    );

    const result = this.get(id)!;
    regenerateIndexFile(result.projectId);
    return result;
  }

  /** Update a requirement's primary key id with cascade updates for parentId
   *  and relatedRequirementIds references. Caller is responsible for validation
   *  (newId format + uniqueness) before invoking. */
  updateId(oldId: string, newId: string): void {
    const existing = this.get(oldId);
    if (!existing) throw new Error(`Requirement ${oldId} not found`);
    // 1. Update the row's own id.
    db.prepare('UPDATE requirements SET id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newId, oldId);
    // 2. Cascade parent_id on children.
    db.prepare('UPDATE requirements SET parent_id = ? WHERE parent_id = ?').run(newId, oldId);
    // 3. Cascade relatedRequirementIds references (stored as JSON array string).
    const allRows = db.prepare('SELECT id, related_requirement_ids FROM requirements').all() as { id: string; related_requirement_ids: string }[];
    for (const row of allRows) {
      if (!row.related_requirement_ids) continue;
      let arr: string[];
      try { arr = JSON.parse(row.related_requirement_ids); } catch { continue; }
      if (!Array.isArray(arr) || !arr.includes(oldId)) continue;
      const next = arr.map((v) => (v === oldId ? newId : v));
      db.prepare('UPDATE requirements SET related_requirement_ids = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    }
    regenerateIndexFile(existing.projectId);
  }

  rowToRequirement(row: DbRequirementRow): Requirement {
    return {
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id || undefined,
      title: row.title,
      description: row.description,
      level: (row.level || 'story') as Requirement['level'],
      flowType: (row.flow_type as Requirement['flowType']) || null,
      status: row.status as Requirement['status'],
      position: row.position,
      isFlow: Boolean(row.is_flow),
      relatedRequirementIds: JSON.parse(row.related_requirement_ids || '[]'),
      documentId: row.document_id || undefined,
      documentVersionId: row.document_version_id || undefined,
      sourceAnchor: row.source_anchor || undefined,
    };
  }

  // --- PRD Document Methods ---

  listDocuments(projectId: string): import('../../shared/contracts/index.ts').PrdDocument[] {
    const rows = db.prepare(`
      SELECT d.*, v.version_tag as current_version_tag, v.item_count
      FROM prd_documents d
      LEFT JOIN prd_document_versions v ON d.current_version_id = v.id
      WHERE d.project_id = ?
      ORDER BY d.created_at DESC
    `).all(projectId) as any[];

    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      fileType: r.file_type,
      currentVersionId: r.current_version_id,
      currentVersionTag: r.current_version_tag || 'v1.0',
      itemCount: r.item_count || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      versions: this.getDocumentVersions(r.id),
    }));
  }

  getDocument(docId: string): import('../../shared/contracts/index.ts').PrdDocument | undefined {
    const row = db.prepare(`
      SELECT d.*, v.version_tag as current_version_tag, v.item_count
      FROM prd_documents d
      LEFT JOIN prd_document_versions v ON d.current_version_id = v.id
      WHERE d.id = ?
    `).get(docId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      fileType: row.file_type,
      currentVersionId: row.current_version_id,
      currentVersionTag: row.current_version_tag || 'v1.0',
      itemCount: row.item_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getDocumentVersions(docId: string): import('../../shared/contracts/index.ts').PrdDocumentVersion[] {
    const rows = db.prepare(`
      SELECT * FROM prd_document_versions WHERE document_id = ? ORDER BY version_number DESC
    `).all(docId) as any[];

    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      versionNumber: r.version_number,
      versionTag: r.version_tag,
      fileName: r.file_name,
      fileSize: r.file_size,
      storagePath: r.storage_path,
      parsedSummary: r.parsed_summary,
      itemCount: r.item_count,
      createdAt: r.created_at,
    }));
  }

  saveDocument(doc: Partial<import('../../shared/contracts/index.ts').PrdDocument>): import('../../shared/contracts/index.ts').PrdDocument {
    const id = doc.id || randomId('doc');
    db.prepare(`
      INSERT INTO prd_documents (id, project_id, title, file_type, current_version_id, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        file_type = excluded.file_type,
        current_version_id = excluded.current_version_id,
        updated_at = datetime('now')
    `).run(
      id,
      doc.projectId || '',
      doc.title || 'Untitled PRD',
      doc.fileType || 'docx',
      doc.currentVersionId || null,
    );
    return this.getDocument(id)!;
  }

  saveDocumentVersion(v: Partial<import('../../shared/contracts/index.ts').PrdDocumentVersion>): import('../../shared/contracts/index.ts').PrdDocumentVersion {
    const id = v.id || randomId('docver');
    db.prepare(`
      INSERT INTO prd_document_versions (id, document_id, version_number, version_tag, file_name, file_size, storage_path, parsed_summary, item_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      v.documentId,
      v.versionNumber ?? 1,
      v.versionTag || 'v1.0',
      v.fileName || 'document',
      v.fileSize ?? 0,
      v.storagePath || '',
      v.parsedSummary || '',
      v.itemCount ?? 0,
    );
    // Also update parent document's current_version_id
    if (v.documentId) {
      db.prepare(`UPDATE prd_documents SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(id, v.documentId);
    }
    return {
      id,
      documentId: v.documentId!,
      versionNumber: v.versionNumber ?? 1,
      versionTag: v.versionTag || 'v1.0',
      fileName: v.fileName || 'document',
      fileSize: v.fileSize ?? 0,
      storagePath: v.storagePath || '',
      parsedSummary: v.parsedSummary || '',
      itemCount: v.itemCount ?? 0,
      createdAt: new Date().toISOString(),
    };
  }

  deleteDocumentVersion(docId: string, versionId: string, deleteRequirements = true): { deletedRequirementsCount: number } {
    const doc = this.getDocument(docId);
    if (!doc) return { deletedRequirementsCount: 0 };

    const versionRow = db.prepare('SELECT * FROM prd_document_versions WHERE id = ? AND document_id = ?').get(versionId, docId) as any;
    if (!versionRow) return { deletedRequirementsCount: 0 };

    // Remove file on disk if exists
    if (versionRow.storage_path) {
      try {
        const fullPath = path.resolve(process.cwd(), versionRow.storage_path);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // Ignore file removal errors
      }
    }

    let deletedRequirementsCount = 0;
    if (deleteRequirements) {
      const countRow = db.prepare('SELECT count(*) as count FROM requirements WHERE document_version_id = ?').get(versionId) as { count: number } | undefined;
      deletedRequirementsCount = countRow?.count ?? 0;
      db.prepare('DELETE FROM requirements WHERE document_version_id = ?').run(versionId);
      if (deletedRequirementsCount > 0 && doc.projectId) {
        regenerateIndexFile(doc.projectId);
      }
    } else {
      db.prepare('UPDATE requirements SET document_version_id = NULL, source_anchor = NULL WHERE document_version_id = ?').run(versionId);
    }

    // Delete version record
    db.prepare('DELETE FROM prd_document_versions WHERE id = ?').run(versionId);

    // Update parent document's current_version_id if it pointed to this version
    const remainingVersions = db.prepare(
      'SELECT id FROM prd_document_versions WHERE document_id = ? ORDER BY version_number DESC, created_at DESC'
    ).all(docId) as Array<{ id: string }>;
    const nextCurrentVersionId = remainingVersions.length > 0 ? remainingVersions[0].id : null;

    db.prepare(`UPDATE prd_documents SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`).run(nextCurrentVersionId, docId);

    return { deletedRequirementsCount };
  }

  deleteDocument(docId: string, deleteRequirements = false): { deletedRequirementsCount: number } {
    const doc = this.getDocument(docId);
    let deletedRequirementsCount = 0;

    // Delete physical files for all versions of this document
    const versions = db.prepare('SELECT storage_path FROM prd_document_versions WHERE document_id = ?').all(docId) as Array<{ storage_path: string }>;
    for (const v of versions) {
      if (v.storage_path) {
        try {
          const fullPath = path.resolve(process.cwd(), v.storage_path);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // Ignore unlink errors
        }
      }
    }

    if (deleteRequirements) {
      const countRow = db.prepare('SELECT count(*) as count FROM requirements WHERE document_id = ?').get(docId) as { count: number } | undefined;
      deletedRequirementsCount = countRow?.count ?? 0;
      db.prepare('DELETE FROM requirements WHERE document_id = ?').run(docId);
      if (doc?.projectId && deletedRequirementsCount > 0) {
        regenerateIndexFile(doc.projectId);
      }
    } else {
      // Unlink requirements and clear hanging anchors
      db.prepare('UPDATE requirements SET document_id = NULL, document_version_id = NULL, source_anchor = NULL WHERE document_id = ?').run(docId);
    }

    // Delete versions
    db.prepare('DELETE FROM prd_document_versions WHERE document_id = ?').run(docId);
    // Delete document
    db.prepare('DELETE FROM prd_documents WHERE id = ?').run(docId);

    return { deletedRequirementsCount };
  }
}

export const requirementRepo = new RequirementRepository();
