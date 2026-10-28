export type DbBaseProjectRow = {
  id: string;
  name: string;
  description: string;
};

export type DbBaseSuiteRow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  position: number;
};

export type DbPageRow = {
  id: string;
  name: string;
  description: string;
};

export type DbElementRow = {
  id: string;
  page_id: string;
  name: string;
  selector_type: string;
  value: string;
  description: string;
  original_html: string | null;
  page_url: string | null;
  metadata: string | null;
};

export type DbModuleRow = {
  id: string;
  name: string;
  description: string;
};

export type DbModuleParamRow = {
  id: string;
  module_id: string;
  name: string;
  default_value: string;
  description: string;
};

export type DbScenarioRow = {
  id: string;
  name: string;
  description: string;
};

export type DbScenarioSuiteRow = {
  id: string;
  scenario_id: string;
  suite_id: string;
};

export type DbSuiteVariableRow = {
  id: string;
  scenario_id: string;
  variable_key: string;
  variable_value: string;
};

export type DbScenarioDataRowRow = {
  id: number;
  scenario_id: string;
  row_index: number;
  item_key: string;
  item_value: string;
};

export type DbSuiteOverrideRow = {
  scenario_suite_id: string;
  item_key: string;
  item_value: string;
};

export type DbPlanScenarioRow = {
  id: string;
  plan_id: string;
  scenario_id: string;
};

export type DbCaseRow = {
  id: string;
  name: string;
  description: string;
};

export type DbStepRow = {
  id: string;
  module_id: string;
  action: string;
  target: string;
  data: string;
  description: string;
  header_profile_id: string | null;
  body_template_id: string | null;
  endpoint_id: string | null;
  screenshot: number | null;
  enabled: number;
  metadata?: string | null;
  extractors?: string | null;
  assertions?: string | null;
  wait_for_network?: string | null;
  network_mocks?: string | null;
};

export type DbHeaderRow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
};

export type DbHeaderItemRow = {
  item_key: string;
  item_value: string;
  enabled: number;
};

export type DbBodyRow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  content_type: string;
  content: string;
};

export type DbBodyDefaultValueRow = {
  item_key: string;
  item_value: string;
};

export type DbEndpointRow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  method: string | null;
};

export type DbEndpointBaseUrlRow = {
  environment: string;
  url: string;
};

export type DbEndpointParameterRow = {
  item_key: string;
  item_value: string;
  enabled: number;
};

export type DbReportRow = {
  id: string;
  suite_id: string;
  suite_name: string | null;
  environment: string | null;
  start_time: number;
  end_time: number | null;
  status: string;
  pass_rate: number;
  total_cases: number | null;
  passed_cases: number | null;
  failed_cases: number | null;
};

export type DbReportLogRow = {
  step_id: string;
  timestamp: number;
  status: string;
  level: string | null;
  message: string;
  screenshot: string | null;
  metadata: string | null;
};

export type DbSettingsRow = {
  id: string;
  current_project_id: string;
  current_environment: string;
  headless_mode: number;
  viewport_width: number;
  viewport_height: number;
};

export type DbRequirementRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  level: string;
  status: string;
  position: number;
  flow_type: string | null;
  is_flow: number;
  related_requirement_ids: string;
  document_id: string | null;
  document_version_id: string | null;
  source_anchor: string | null;
};

export type DbPrdDocumentRow = {
  id: string;
  project_id: string;
  title: string;
  file_type: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DbPrdDocumentVersionRow = {
  id: string;
  document_id: string;
  version_number: number;
  version_tag: string;
  file_name: string;
  file_size: number;
  storage_path: string;
  parsed_summary: string;
  item_count: number;
  created_at: string;
};


