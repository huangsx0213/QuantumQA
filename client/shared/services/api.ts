import { Project, TestSuite, HeaderProfile, BodyTemplate, ApiEndpoint, ExecutionReport, Settings, ExecutionRequest, DynamicVariable } from '@/shared/types';
import type { Requirement } from '../../../shared/contracts/index';
import type { StartConfig } from '@/shared/test-gen-run/types';

export type HtmlKnowledgeSetStatus = 'UPLOADING' | 'READY' | 'BOUND';
export type HtmlKnowledgePageStatus = 'PENDING' | 'READY' | 'FAILED';
export type HtmlInformationLevel = 'NORMAL' | 'LOW_INFORMATION';

export interface HtmlKnowledgeManifestPage {
  readonly fileName: string;
  readonly byteSize: number;
}

export interface HtmlKnowledgeManifest {
  readonly pages: readonly HtmlKnowledgeManifestPage[];
}

export interface HtmlKnowledgePageDto {
  readonly pageId: string;
  readonly fileName: string;
  readonly expectedByteSize: number;
  readonly status: HtmlKnowledgePageStatus;
  readonly errorMessage: string | null;
  readonly pageTitle: string | null;
  readonly byteSize: number | null;
  readonly informationLevel: HtmlInformationLevel | null;
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HtmlKnowledgeSetDto {
  readonly knowledgeSetId: string;
  readonly status: HtmlKnowledgeSetStatus;
  readonly pageCount: number;
  readonly totalBytes: number;
  readonly indexVersion: number;
  readonly pages: readonly HtmlKnowledgePageDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CrudService<T extends { id: string }> {
  list: () => Promise<T[]>;
  get: (id: string) => Promise<T>;
  create: (data: Omit<T, 'id'> | T) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;
  delete: (id: string) => Promise<void>;
}

export interface EnvironmentService {
  list: () => Promise<string[]>;
  create: (env: string) => Promise<string>;
  delete: (env: string) => Promise<void>;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `/api/${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options?.headers || {}),
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    let message = 'An error occurred';
    try {
      const errorData = await response.json();
      message = errorData.error || message;
    } catch (e) {
      message = response.statusText;
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// --- API Services ---
// This pattern provides strong typing and a clean interface for components

function createCrudService<T extends { id: string }>(resource: string): CrudService<T> {
  return {
    list: () => apiFetch<T[]>(resource),
    get: (id: string) => apiFetch<T>(`${resource}/${id}`),
    create: (data: Omit<T, 'id'> | T) => apiFetch<T>(resource, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    update: (id: string, data: Partial<T>) => apiFetch<T>(`${resource}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    delete: (id: string) => apiFetch<void>(`${resource}/${id}`, {
      method: 'DELETE',
    }),
  };
}

export const api = {
  projects: createCrudService<Project>('projects'),
  suites: createCrudService<TestSuite>('suites'),
  headers: createCrudService<HeaderProfile>('headers'),
  bodies: createCrudService<BodyTemplate>('bodies'),
  endpoints: createCrudService<ApiEndpoint>('endpoints'),
  reports: createCrudService<ExecutionReport>('reports'),
  settings: createCrudService<Settings>('settings'),
  environments: {
    list: () => apiFetch<string[]>('environments'),
    create: (env: string) => apiFetch<string>('environments', {
      method: 'POST',
      body: JSON.stringify({ name: env })
    }),
    delete: (env: string) => apiFetch<void>(`environments/${env}`, {
      method: 'DELETE'
    }),
  } satisfies EnvironmentService,
  dynamicVariables: {
    list: (projectId: string) => apiFetch<DynamicVariable[]>(`projects/${projectId}/dynamic-variables`),
    create: (projectId: string, data: Omit<DynamicVariable, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>) => apiFetch<DynamicVariable>(`projects/${projectId}/dynamic-variables`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    update: (id: string, data: Partial<DynamicVariable>) => apiFetch<DynamicVariable>(`dynamic-variables/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    delete: (id: string) => apiFetch<void>(`dynamic-variables/${id}`, {
      method: 'DELETE',
    }),
    preview: (expression: string) => apiFetch<{ samples: string[] }>(`dynamic-variables/preview`, {
      method: 'POST',
      body: JSON.stringify({ expression }),
    }),
  },
  agents: {
    list: () => apiFetch<any[]>('agents'),
    updateStatus: (id: string, status: string) => apiFetch<any>(`agents/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    updateLabels: (id: string, labels: string[]) => apiFetch<any>(`agents/${id}/labels`, { method: 'PUT', body: JSON.stringify({ labels }) }),
    delete: (id: string) => apiFetch<void>(`agents/${id}`, { method: 'DELETE' }),
    logs: (id: string) => apiFetch<any[]>(`agents/${id}/logs`),
    logsStream: (id: string): EventSource => new EventSource(`/api/agents/${id}/logs/stream`),
  },
  queue: {
    list: () => apiFetch<any[]>('runners/queue'),
  },
  requirements: {
    ...createCrudService<Requirement>('requirements'),
    listByProject: (projectId: string) => apiFetch<Requirement[]>(`requirements/by-project/${projectId}`),
    updateId: (oldId: string, newId: string) =>
      apiFetch<Requirement>(`requirements/${oldId}/id`, {
        method: 'PUT',
        body: JSON.stringify({ newId }),
      }),
  },
  testGen: {
    runs: (projectId: string) => apiFetch<any[]>(`test-gen/runs/${projectId}`),
    active: (projectId: string) => apiFetch<any | null>(`test-gen/active/${projectId}`),
    get: (runId: string) => apiFetch<any>(`test-gen/${runId}`),
    start: (projectId: string, config: StartConfig) =>
      apiFetch<{ runId: string; created?: boolean }>(`test-gen/${projectId}/start`, {
        method: 'POST',
        body: JSON.stringify(config),
      }),
    htmlKnowledge: {
      createSet: (projectId: string, manifest: HtmlKnowledgeManifest) =>
        apiFetch<HtmlKnowledgeSetDto>(`test-gen/${projectId}/html-knowledge-sets`, {
          method: 'POST',
          body: JSON.stringify(manifest),
        }),
      getSet: (projectId: string, setId: string, signal?: AbortSignal) =>
        apiFetch<HtmlKnowledgeSetDto>(
          `test-gen/${projectId}/html-knowledge-sets/${setId}`,
          signal ? { signal } : undefined,
        ),
      uploadPage: (
        projectId: string,
        setId: string,
        pageId: string,
        file: File,
        signal?: AbortSignal,
      ) => apiFetch<HtmlKnowledgePageDto>(
        `test-gen/${projectId}/html-knowledge-sets/${setId}/pages/${pageId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: file,
          signal,
        },
      ),
      deletePage: (
        projectId: string,
        setId: string,
        pageId: string,
        signal?: AbortSignal,
      ) =>
        apiFetch<HtmlKnowledgeSetDto>(
          `test-gen/${projectId}/html-knowledge-sets/${setId}/pages/${pageId}`,
          { method: 'DELETE', ...(signal ? { signal } : {}) },
        ),
      deleteSet: (projectId: string, setId: string, signal?: AbortSignal) =>
        apiFetch<{ success: boolean }>(
          `test-gen/${projectId}/html-knowledge-sets/${setId}`,
          { method: 'DELETE', ...(signal ? { signal } : {}) },
        ),
      finalizeSet: (projectId: string, setId: string, signal?: AbortSignal) =>
        apiFetch<HtmlKnowledgeSetDto>(
          `test-gen/${projectId}/html-knowledge-sets/${setId}/finalize`,
          { method: 'POST', ...(signal ? { signal } : {}) },
        ),
    },
    resume: (runId: string, action: any) =>
      apiFetch<{ success: boolean }>(`test-gen/${runId}/resume`, {
        method: 'POST',
        body: JSON.stringify(action),
      }),
    checkpoint: (runId: string) =>
      apiFetch<any>(`test-gen/${runId}/checkpoint`),
    saveCheckpointEdits: (runId: string, editedData: any, checkpointNumber: number) =>
      apiFetch<{ success: boolean }>(`test-gen/${runId}/checkpoint-update`, {
        method: 'POST',
        body: JSON.stringify({ editedData, checkpointNumber }),
      }),
    getCheckpointState: (runId: string) =>
      apiFetch<{ checkpointData: any }>(`test-gen/${runId}/checkpoint-state`),
    logs: (runId: string, agentName?: string) =>
      apiFetch<any[]>(`test-gen/${runId}/logs${agentName ? `?agent=${agentName}` : ''}`),
    audit: (runId: string, checkpointId?: string) =>
      apiFetch<any[]>(`test-gen/${runId}/audit${checkpointId ? `?checkpointId=${encodeURIComponent(checkpointId)}` : ''}`),
    saveCases: (runId: string) =>
      apiFetch<{ saved: number }>(`test-gen/${runId}/save-cases`, { method: 'POST' }),
    abort: (runId: string) =>
      apiFetch<{ success: boolean }>(`test-gen/${runId}/abort`, { method: 'POST' }),
    retry: (runId: string) =>
      apiFetch<{ success: boolean }>(`test-gen/${runId}/retry`, { method: 'POST' }),
    delete: (runId: string) =>
      apiFetch<{ success: boolean }>(`test-gen/${runId}`, { method: 'DELETE' }),
    getThinkingData: (runId: string) =>
      apiFetch<Record<string, Array<{ type: string; phase: string; text: string; timestamp: number }>> | null>(`test-gen/${runId}/thinking`),
    promptOverrides: (projectId: string) =>
      apiFetch<any[]>(`test-gen/prompts/${projectId}`),
    savePromptOverride: (projectId: string, agentName: string, data: { customPrompt?: string | null; modelOverride?: string | null }) =>
      apiFetch<{ success: boolean }>(`test-gen/prompts/${projectId}/${agentName}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deletePromptOverride: (projectId: string, agentName: string) =>
      apiFetch<{ success: boolean }>(`test-gen/prompts/${projectId}/${agentName}`, { method: 'DELETE' }),
    getDefaultPrompt: (projectId: string, agentName: string) =>
      apiFetch<{ agentName: string; prompt: string }>(`test-gen/prompts/${projectId}/default/${agentName}`),
    getLatestRunPrompts: (projectId: string) =>
      apiFetch<any[]>(`test-gen/prompts/${projectId}/latest`),
  },
  nlCases: {
    ...createCrudService<any>('nl-cases'),
    listByProject: (projectId: string) =>
      apiFetch<any[]>(`nl-cases/by-project/${projectId}`),
  },
  providerConfigs: {
    ...createCrudService<any>('provider-configs'),
    setActive: (id: string) =>
      apiFetch<{ success: boolean }>(`provider-configs/${id}/set-active`, { method: 'POST' }),
    copy: (id: string) =>
      apiFetch<any>(`provider-configs/${id}/copy`, { method: 'POST' }),
    test: (id: string) =>
      apiFetch<any>(`provider-configs/${id}/test`, { method: 'POST' }),
  },
  aiDrivenRecorder: {
    runs: (projectId: string) =>
      apiFetch<any[]>(`ai-driven-recorder/${projectId}/runs`),
    getRun: (projectId: string, runId: string) =>
      apiFetch<any>(`ai-driven-recorder/${projectId}/runs/${runId}`),
    steps: (projectId: string, runId: string) =>
      apiFetch<{ runId: string; runStatus: string; steps: any[] }>(`ai-driven-recorder/${projectId}/runs/${runId}/steps`),
    start: (projectId: string, config: { nlCaseId: string; providerConfigId: string; executionMode?: 'agent' | 'local'; startUrl?: string; options?: Record<string, unknown> }) =>
      apiFetch<{ runId: string; suiteId: string; caseId: string; status: string }>(`ai-driven-recorder/${projectId}/runs`, {
        method: 'POST',
        body: JSON.stringify(config),
      }),
    delete: (projectId: string, runId: string) =>
      apiFetch<{ success: boolean }>(`ai-driven-recorder/${projectId}/runs/${runId}`, { method: 'DELETE' }),
    streamUrl: (projectId: string, runId: string) =>
      `/api/ai-driven-recorder/${projectId}/runs/${runId}/stream`,
  },
};

// --- Execution API ---

export const executionApi = {
  execute: (request: ExecutionRequest) =>
    apiFetch<{ reportId: string; runId: string; status: string }>('runners/execute', {
      method: 'POST',
      body: JSON.stringify(request),
    }),

  stream: (reportId: string): EventSource => {
    return new EventSource(`/api/runners/stream/${reportId}`);
  },

  status: (reportId: string) =>
    apiFetch<{ runId: string; reportId: string; status: string }>(`runners/status/${reportId}`),

  abort: (reportId: string) =>
    apiFetch<{ success: boolean }>(`runners/abort/${reportId}`, { method: 'POST' }),
};
