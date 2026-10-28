import { db } from '../shared/db/client.ts';
import { Log } from '../shared/services/logger.ts';
import type { Migration } from './types.ts';

export const migration013AddPrdDocumentsAndVersioning: Migration = {
  id: '013_add_prd_documents_and_versioning',
  up: () => {
    Log.for('migration-013').info('Running migration 013: PRD documents and versioning tables');

    // 1. Create prd_documents table
    db.exec(`
      CREATE TABLE IF NOT EXISTS prd_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        file_type TEXT NOT NULL DEFAULT 'docx',
        current_version_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_prd_documents_project ON prd_documents(project_id);
    `);

    // 2. Create prd_document_versions table
    db.exec(`
      CREATE TABLE IF NOT EXISTS prd_document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES prd_documents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL DEFAULT 1,
        version_tag TEXT NOT NULL DEFAULT 'v1.0',
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL DEFAULT '',
        parsed_summary TEXT NOT NULL DEFAULT '',
        item_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_prd_doc_versions_doc ON prd_document_versions(document_id);
    `);

    // 3. Add document columns to requirements table if not present
    const reqCols = db.prepare('PRAGMA table_info(requirements)').all() as Array<{ name: string }>;
    if (!reqCols.some((c) => c.name === 'document_id')) {
      db.exec('ALTER TABLE requirements ADD COLUMN document_id TEXT');
    }
    if (!reqCols.some((c) => c.name === 'document_version_id')) {
      db.exec('ALTER TABLE requirements ADD COLUMN document_version_id TEXT');
    }
    if (!reqCols.some((c) => c.name === 'source_anchor')) {
      db.exec('ALTER TABLE requirements ADD COLUMN source_anchor TEXT');
    }
    // 4. Create indexes for requirements document columns
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_requirements_document ON requirements(document_id);
      CREATE INDEX IF NOT EXISTS idx_requirements_doc_version ON requirements(document_version_id);
    `);
  },
};
