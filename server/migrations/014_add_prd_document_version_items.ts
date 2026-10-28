import { db } from '../shared/db/client.ts';
import { Log } from '../shared/services/logger.ts';
import type { Migration } from './types.ts';

export const migration014AddPrdDocumentVersionItems: Migration = {
  id: '014_add_prd_document_version_items',
  up: () => {
    Log.for('migration-014').info('Running migration 014: PRD document version items junction table');

    // 1. Create junction table
    db.exec(`
      CREATE TABLE IF NOT EXISTS prd_document_version_items (
        version_id TEXT NOT NULL REFERENCES prd_document_versions(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        diff_status TEXT NOT NULL DEFAULT 'added',
        PRIMARY KEY (version_id, requirement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_prd_doc_ver_items_ver ON prd_document_version_items(version_id);
      CREATE INDEX IF NOT EXISTS idx_prd_doc_ver_items_req ON prd_document_version_items(requirement_id);
    `);

    // 2. Backfill existing PRD document versions and requirements
    try {
      const versions = db.prepare(`
        SELECT id, document_id, version_number, version_tag
        FROM prd_document_versions
        ORDER BY version_number ASC, created_at ASC
      `).all() as Array<{ id: string; document_id: string; version_number: number; version_tag: string }>;

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO prd_document_version_items (version_id, requirement_id, diff_status)
        VALUES (?, ?, ?)
      `);

      for (const ver of versions) {
        // Link all active requirements associated with this document
        const reqs = db.prepare(`
          SELECT id, document_version_id, status, source_anchor
          FROM requirements
          WHERE document_id = ?
        `).all(ver.document_id) as Array<{ id: string; document_version_id: string | null; status: string; source_anchor: string | null }>;

        for (const r of reqs) {
          // If this is version 1, or requirement is currently linked to this version
          // Exclude requirements only if they were added in a later version
          if (ver.version_number === 1) {
            // For v1, if it wasn't newly added in v2 (e.g. Row 72)
            if (r.source_anchor !== 'Row 72') {
              insertStmt.run(ver.id, r.id, 'added');
            }
          } else {
            // For v2 and beyond, all active requirements in this document exist in this version
            if (r.status !== 'DEPRECATED') {
              insertStmt.run(ver.id, r.id, r.source_anchor === 'Row 72' ? 'added' : 'unchanged');
            }
          }
        }
      }
    } catch (e: any) {
      Log.for('migration-014').warn(`Backfill failed: ${e.message}`);
    }
  },
  down: () => {
    db.exec(`DROP TABLE IF EXISTS prd_document_version_items`);
  },
};
