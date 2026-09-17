import path from 'node:path';

import { Log } from './shared/services/logger';
import { db } from './shared/db/client.ts';
import { saveBodyTemplate } from './modules/bodies/repository.ts';
import { dynamicVariableRepository } from './modules/dynamic-variables/repository.ts';
import { createEnvironment, updateEnvironmentVariables } from './modules/environments/repository.ts';
import { saveApiEndpoint } from './modules/endpoints/repository.ts';
import { saveHeaderProfile } from './modules/headers/repository.ts';
import { saveProject } from './modules/projects/repository.ts';
import { seedRequirements } from './modules/requirements/seed-data.ts';
import { saveSuite } from './modules/suites/repository.ts';
import { businessConfigSeed } from './seed-data/business-config.ts';

// Clears ALL business data EXCEPT the `settings` table, then re-applies the
// business config seed (environments, projects, suites, headers, bodies,
// endpoints, dynamic variables) and re-seeds requirements.
// Run with: npm run reset-data
function resetDataKeepSettings(): void {
  db.exec(`
    DELETE FROM natural_language_test_cases;
    DELETE FROM test_gen_html_knowledge_sets WHERE run_id IS NULL;
    DELETE FROM test_gen_runs;
    DELETE FROM report_logs;
    DELETE FROM reports;
    DELETE FROM execution_runs;
    DELETE FROM endpoint_parameters;
    DELETE FROM endpoint_base_urls;
    DELETE FROM endpoints;
    DELETE FROM body_default_values;
    DELETE FROM bodies;
    DELETE FROM header_items;
    DELETE FROM headers;
    DELETE FROM case_steps;
    DELETE FROM suite_steps;
    DELETE FROM suite_cases;
    DELETE FROM suite_data_row_values;
    DELETE FROM suite_data_rows;
    DELETE FROM suite_variables;
    DELETE FROM scenario_suite_variable_overrides;
    DELETE FROM scenario_suites;
    DELETE FROM scenario_variables;
    DELETE FROM scenario_data_row_values;
    DELETE FROM scenario_data_rows;
    DELETE FROM scenarios;
    DELETE FROM test_plan_scenarios;
    DELETE FROM test_plans;
    DELETE FROM module_steps;
    DELETE FROM module_params;
    DELETE FROM project_modules;
    DELETE FROM project_elements;
    DELETE FROM project_pages;
    DELETE FROM dynamic_variables;
    DELETE FROM requirements;
    DELETE FROM suites;
    DELETE FROM projects;
    DELETE FROM environments;
  `);

  for (const environment of businessConfigSeed.environments) {
    createEnvironment(environment.name);
    updateEnvironmentVariables(environment.name, environment.variables);
  }
  for (const project of businessConfigSeed.projects) {
    saveProject(project);
  }
  for (const suite of businessConfigSeed.suites) {
    saveSuite(suite);
  }
  for (const header of businessConfigSeed.headers) {
    saveHeaderProfile(header);
  }
  for (const body of businessConfigSeed.bodies) {
    saveBodyTemplate(body);
  }
  for (const endpoint of businessConfigSeed.endpoints) {
    saveApiEndpoint(endpoint);
  }
  for (const dynamicVariable of businessConfigSeed.dynamicVariables) {
    dynamicVariableRepository.save(dynamicVariable);
  }

  // NOTE: the `settings` table is intentionally preserved (not re-seeded).

  seedRequirements();
  Log.for('reset').info('Database reset complete (settings preserved) and requirements re-seeded.');
}

if (path.basename(process.argv[1] || '') === 'reset-data.ts') {
  import('./migrations/index.ts').then(({ runMigrations }) => {
    runMigrations();
    resetDataKeepSettings();
  });
}