import { Log } from '../shared/services/logger.ts';
import { db } from '../shared/db/client.ts';
import { migration000InitialSchema } from './000_initial_schema.ts';
import { migration001AddTestLevelToNlCases } from './001_add_test_level_to_nl_cases.ts';
import { migration002RequirementsHumanIdAndFlowType } from './002_requirements_human_id_and_flow_type.ts';
import { migration003RemoveFeatureLevel } from './003_remove_feature_level.ts';
import { migration004RequirementsTestScenario } from './004_requirements_test_scenario.ts';
import { migration005DropPriorityAndTagsAndInProgress } from './005_drop_priority_and_tags_and_in_progress.ts';
import { migration006DropMetadataAndTestScenario } from './006_drop_metadata_and_test_scenario.ts';
import { migration007AddIsFlowAndRelatedRequirements } from './007_add_is_flow_and_related_requirements.ts';
import { migration008MigrateBusinessFlows } from './008_migrate_business_flows_to_requirements.ts';
import { migration009DropHumanIdDependenciesType } from './009_drop_human_id_dependencies_type.ts';
import { migration010AddTestGenHtmlKnowledge } from './010_add_test_gen_html_knowledge.ts';
import { migration011AddRecorderExecutionMode } from './011_add_recorder_execution_mode.ts';
import { migration012AddStepLogDetails } from './012_add_step_log_details.ts';
import { migration013AddPrdDocumentsAndVersioning } from './013_add_prd_documents_and_versioning.ts';
import { migration014AddPrdDocumentVersionItems } from './014_add_prd_document_version_items.ts';
import { seedDefaults } from '../seed.ts';
import type { Migration } from './types.ts';

export const migrations: Migration[] = [
  migration000InitialSchema,
  migration001AddTestLevelToNlCases,
  migration002RequirementsHumanIdAndFlowType,
  migration003RemoveFeatureLevel,
  migration004RequirementsTestScenario,
  migration005DropPriorityAndTagsAndInProgress,
  migration006DropMetadataAndTestScenario,
  migration007AddIsFlowAndRelatedRequirements,
  migration008MigrateBusinessFlows,
  migration009DropHumanIdDependenciesType,
  migration010AddTestGenHtmlKnowledge,
  migration011AddRecorderExecutionMode,
  migration012AddStepLogDetails,
  migration013AddPrdDocumentsAndVersioning,
  migration014AddPrdDocumentVersionItems,
];

function appliedMigrationIds(): Set<string> {
  const rows = db
    .prepare('SELECT id FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string }>;

  return new Set(rows.map((row) => row.id));
}

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = appliedMigrationIds();
  const markApplied = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    const transaction = db.transaction(() => {
      migration.up();
      markApplied.run(migration.id);
    });

    transaction();
  }

  const projectCount = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as any).count;

  if (process.env.FORCE_SEED === 'true' || projectCount === 0) {
    if (process.env.FORCE_SEED === 'true') {
      Log.for('migrate').info('FORCE_SEED=true: Resetting database...');
    } else {
      Log.for('migrate').info('Empty database: Auto-seeding...');
    }
    seedDefaults();
  }
}

export function rollbackLastMigration(): void {
  const applied = appliedMigrationIds();
  if (applied.size === 0) {
    Log.for('migrate').info('No migrations to rollback.');
    return;
  }

  // Find the last applied migration
  for (let i = migrations.length - 1; i >= 0; i--) {
    const migration = migrations[i];
    if (applied.has(migration.id)) {
      if (!migration.down) {
        Log.for('migrate').warn(`Cannot rollback migration ${migration.id}: missing down() function.`);
        return;
      }

      const transaction = db.transaction(() => {
        migration.down!();
        db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(migration.id);
      });

      transaction();
      Log.for('migrate').info(`Rolled back migration ${migration.id}.`);
      return;
    }
  }
}
