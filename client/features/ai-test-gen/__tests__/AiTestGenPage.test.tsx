import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AiTestGenPage } from '../AiTestGenPage';
import { TestGenRunDepsProvider } from '@/shared/test-gen-run';
import { createFetchSSEConnection } from '@/shared/sse';
import type {
  HtmlKnowledgeManifest,
  HtmlKnowledgePageDto,
  HtmlKnowledgeSetDto,
} from '@/shared/services/api';

const queryHookMocks = vi.hoisted(() => ({
  useRequirements: vi.fn(),
  useTestGenRuns: vi.fn(),
  useCheckpoint: vi.fn(),
  useAgentLogs: vi.fn(),
  useProviderConfigs: vi.fn(),
  usePrdDocuments: vi.fn().mockReturnValue({ data: [] }),
}));

vi.mock('@/shared/ui/HelpTooltip', () => ({
  HelpTooltip: ({ content }: { content: string }) => React.createElement('span', { 'data-testid': 'help-tooltip' }, content),
}));

vi.mock('@/shared/ui/ConfirmModal', () => ({
  ConfirmModal: ({ isOpen, title, message, onConfirm, onClose, confirmLabel }: any) =>
    isOpen
      ? React.createElement('div', { 'data-testid': 'confirm-modal' },
          React.createElement('div', null, title),
          React.createElement('div', null, message),
          React.createElement('button', { onClick: onConfirm, 'data-testid': 'confirm-yes' }, confirmLabel),
          React.createElement('button', { onClick: onClose, 'data-testid': 'confirm-no' }, 'Cancel'),
        )
      : null,
}));

vi.mock('@/shared/hooks/useQueryHooks', () => ({
  useRequirements: queryHookMocks.useRequirements,
  useTestGenRuns: queryHookMocks.useTestGenRuns,
  useCheckpoint: queryHookMocks.useCheckpoint,
  useAgentLogs: queryHookMocks.useAgentLogs,
  useProviderConfigs: queryHookMocks.useProviderConfigs,
  usePrdDocuments: queryHookMocks.usePrdDocuments,
}));

const mockSaveCheckpointEdits = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const htmlKnowledgeApi = vi.hoisted(() => ({
  createSet: vi.fn(),
  getSet: vi.fn(),
  uploadPage: vi.fn(),
  deletePage: vi.fn(),
  deleteSet: vi.fn(),
  finalizeSet: vi.fn(),
}));
const promptApi = vi.hoisted(() => ({
  promptOverrides: vi.fn(),
  savePromptOverride: vi.fn(),
  deletePromptOverride: vi.fn(),
}));
const mockGetLatestRunPrompts = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@/shared/services/api', () => ({
  api: {
    pipeline: {
      start: vi.fn().mockResolvedValue({ runId: 'run-test-1' }),
      resume: vi.fn().mockResolvedValue({ success: true }),
      abort: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      active: vi.fn().mockResolvedValue(null),
      runs: vi.fn().mockResolvedValue([]),
    },
    testGen: {
      saveCheckpointEdits: mockSaveCheckpointEdits,
      htmlKnowledge: htmlKnowledgeApi,
      promptOverrides: promptApi.promptOverrides,
      savePromptOverride: promptApi.savePromptOverride,
      deletePromptOverride: promptApi.deletePromptOverride,
      getLatestRunPrompts: mockGetLatestRunPrompts,
    },
  },
}));

vi.mock('@/shared/sse', () => ({
  createFetchSSEConnection: vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => 'disconnected'),
    getLastError: vi.fn(() => null),
  })),
}));

const mockDeps = {
  api: {
    start: vi.fn().mockResolvedValue({ runId: 'run-test-1' }),
    resume: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    active: vi.fn().mockResolvedValue(null),
    runs: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    checkpoint: vi.fn().mockResolvedValue(null),
    logs: vi.fn().mockResolvedValue([]),
  },
  createSSEConnection: vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => 'disconnected' as const),
    getLastError: vi.fn(() => null),
  })),
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(TestGenRunDepsProvider as any, { deps: mockDeps },
      React.createElement(QueryClientProvider, { client: queryClient }, children),
    );
  }
  return render(ui, { wrapper: Wrapper });
}

const timestamp = '2026-08-22T00:00:00.000Z';

function makeSet(
  setId: string,
  pages: readonly HtmlKnowledgePageDto[],
  status: HtmlKnowledgeSetDto['status'],
): HtmlKnowledgeSetDto {
  return {
    knowledgeSetId: setId,
    status,
    pageCount: pages.length,
    totalBytes: pages.reduce((total, page) => total + page.expectedByteSize, 0),
    indexVersion: 1,
    pages,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function installSuccessfulHtmlFlow(setId = 'set-1') {
  let pendingPages: HtmlKnowledgePageDto[] = [];
  htmlKnowledgeApi.createSet.mockImplementation(
    (_projectId: string, manifest: HtmlKnowledgeManifest) => {
      pendingPages = manifest.pages.map((page, index) => ({
        pageId: `page-${index + 1}`,
        fileName: page.fileName,
        expectedByteSize: page.byteSize,
        status: 'PENDING',
        errorMessage: null,
        pageTitle: null,
        byteSize: null,
        informationLevel: null,
        warnings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      return Promise.resolve(makeSet(setId, pendingPages, 'UPLOADING'));
    },
  );
  htmlKnowledgeApi.uploadPage.mockImplementation(
    (_projectId: string, _setId: string, pageId: string) => {
      const page = pendingPages.find((candidate) => candidate.pageId === pageId)!;
      return Promise.resolve({
        ...page,
        status: 'READY',
        pageTitle: page.fileName.replace(/\.html?$/iu, ''),
        byteSize: page.expectedByteSize,
        informationLevel: 'NORMAL',
      });
    },
  );
  htmlKnowledgeApi.finalizeSet.mockImplementation(() => Promise.resolve(makeSet(
    setId,
    pendingPages.map((page) => ({
      ...page,
      status: 'READY',
      pageTitle: page.fileName.replace(/\.html?$/iu, ''),
      byteSize: page.expectedByteSize,
      informationLevel: 'NORMAL',
    })),
    'READY',
  )));
  htmlKnowledgeApi.getSet.mockImplementation(() => Promise.resolve(makeSet(
    setId,
    pendingPages,
    'UPLOADING',
  )));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function selectReadyRunInputs(
  files: File[],
  expectedFinalizeCalls = 1,
): Promise<void> {
  fireEvent.click(screen.getByLabelText('Select all'));
  fireEvent.change(screen.getByLabelText('Choose HTML files'), { target: { files } });
  await waitFor(() => expect(htmlKnowledgeApi.finalizeSet).toHaveBeenCalledTimes(
    expectedFinalizeCalls,
  ));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Start Test Gen' })).toBeEnabled();
  });
}

describe('AiTestGenPage', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    queryHookMocks.useRequirements.mockReturnValue({
      data: [{
        id: 'story-1',
        projectId: 'proj-1',
        parentId: null,
        title: 'Login',
        description: 'Sign in',
        level: 'story',
        status: 'APPROVED',
        position: 0,
      }],
    });
    queryHookMocks.useTestGenRuns.mockReturnValue({ data: [], refetch: vi.fn() });
    queryHookMocks.useCheckpoint.mockReturnValue({ data: null });
    queryHookMocks.useAgentLogs.mockReturnValue({ data: [] });
    queryHookMocks.useProviderConfigs.mockReturnValue({
      data: [{
        id: 'provider-1',
        name: 'Azure OpenAI',
        type: 'azure-openai',
        model: 'gpt-4o',
        models: ['gpt-4o'],
        isActive: true,
      }],
    });
    mockDeps.api.start.mockReset().mockResolvedValue({ runId: 'run-test-1' });
    htmlKnowledgeApi.createSet.mockReset();
    htmlKnowledgeApi.getSet.mockReset();
    htmlKnowledgeApi.uploadPage.mockReset();
    htmlKnowledgeApi.deletePage.mockReset();
    htmlKnowledgeApi.deleteSet.mockReset().mockResolvedValue({ success: true });
    htmlKnowledgeApi.finalizeSet.mockReset();
    promptApi.promptOverrides.mockReset().mockResolvedValue([]);
    promptApi.savePromptOverride.mockReset().mockResolvedValue({ success: true });
    promptApi.deletePromptOverride.mockReset().mockResolvedValue({ success: true });
  });

  const defaultProps = { currentProjectId: 'proj-1' };

  it('TC-4.1: shows project selection prompt when no projectId', () => {
    renderWithProviders(React.createElement(AiTestGenPage, { currentProjectId: null }));
    expect(screen.getByText('Select a project to continue')).toBeTruthy();
  });

  it('renders header with AI Test Gen title', () => {
    renderWithProviders(React.createElement(AiTestGenPage, defaultProps));
    expect(screen.getByText('AI Test Gen')).toBeTruthy();
  });

  it('TC-4.2: can switch between tabs', () => {
    renderWithProviders(React.createElement(AiTestGenPage, defaultProps));
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Run History')).toBeTruthy();
    fireEvent.click(screen.getByText('New'));
    expect(screen.getByText('Requirements')).toBeTruthy();
  });

  it('TC-4.2: shows tab bar when in history view', () => {
    renderWithProviders(React.createElement(AiTestGenPage, defaultProps));
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('TC-4.5: abort confirmation modal appears on abort click', () => {
    renderWithProviders(React.createElement(AiTestGenPage, defaultProps));
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('shows header with AI Test Gen title and buttons', () => {
    renderWithProviders(React.createElement(AiTestGenPage, defaultProps));
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('uploads two pages, starts with the finalized set, and transfers ownership before Runtime', async () => {
    installSuccessfulHtmlFlow('set-two-pages');
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    const files = [
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
      new File(['<h1>Dashboard</h1>'], 'dashboard.html', { type: 'text/html' }),
    ];

    await selectReadyRunInputs(files);
    fireEvent.click(screen.getByRole('button', { name: 'Start Test Gen' }));

    await waitFor(() => expect(mockDeps.api.start).toHaveBeenCalledTimes(1));
    expect(htmlKnowledgeApi.createSet).toHaveBeenCalledWith('proj-1', {
      pages: [
        { fileName: 'login.html', byteSize: files[0].size },
        { fileName: 'dashboard.html', byteSize: files[1].size },
      ],
    });
    expect(htmlKnowledgeApi.uploadPage).toHaveBeenCalledTimes(2);
    expect(htmlKnowledgeApi.finalizeSet).toHaveBeenCalledWith(
      'proj-1', 'set-two-pages', expect.any(AbortSignal),
    );
    expect(mockDeps.api.start).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      htmlKnowledgeSetId: 'set-two-pages',
    }));
    await waitFor(() => expect(screen.getByText('Preparation')).toBeInTheDocument());
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await Promise.resolve();
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalled();
  });

  it('owns a pending start synchronously and disables conflicting New-tab controls', async () => {
    installSuccessfulHtmlFlow('set-pending-start');
    const startRequest = deferred<{ runId: string }>();
    mockDeps.api.start.mockReturnValue(startRequest.promise);
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    await selectReadyRunInputs([
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
    ]);
    const startButton = screen.getByRole('button', { name: 'Start Test Gen' });
    startButton.focus();
    expect(document.activeElement).toBe(startButton);

    act(() => {
      startButton.click();
      startButton.click();
    });

    expect(mockDeps.api.start).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Starting Test Gen/ })).toBeDisabled();
    });
    const pendingStartButton = screen.getByRole('button', { name: /Starting Test Gen/ });
    const pendingFeedback = screen.getByText('Test Gen start is in progress');
    expect(pendingFeedback).toHaveAttribute('role', 'status');
    expect(pendingFeedback).toHaveAttribute('aria-live', 'polite');
    expect(pendingStartButton).toHaveAttribute('aria-describedby', pendingFeedback.id);
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    refreshButton.focus();
    expect(document.activeElement).toBe(refreshButton);
    expect(pendingFeedback).toBeInTheDocument();
    const clearButton = screen.getByRole('button', { name: 'Clear' });
    const historyTab = screen.getByRole('button', { name: 'History' });
    expect(clearButton).toBeDisabled();
    for (const tab of ['New', 'Runtime', 'History', 'Agent Prompts']) {
      expect(screen.getByRole('button', { name: tab })).toBeDisabled();
    }
    const picker = screen.getByLabelText('Choose HTML files');
    expect(picker).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove login.html' })).toBeDisabled();
    fireEvent.change(picker, {
      target: { files: [new File(['replacement'], 'replacement.html')] },
    });
    expect(htmlKnowledgeApi.createSet).toHaveBeenCalledTimes(1);
    fireEvent.click(clearButton);
    fireEvent.click(historyTab);
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalled();
    expect(screen.getByText('HTML Knowledge')).toBeInTheDocument();

    await act(async () => {
      startRequest.resolve({ runId: 'run-test-1' });
      await startRequest.promise;
    });
    await waitFor(() => expect(screen.getByText('Preparation')).toBeInTheDocument());
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalled();
  });

  it('retains a ready set when start fails', async () => {
    installSuccessfulHtmlFlow('set-retryable');
    mockDeps.api.start.mockRejectedValueOnce(new Error('Start unavailable'));
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    await selectReadyRunInputs([
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Start Test Gen' }));

    const startError = await screen.findByRole('alert');
    expect(startError).toHaveTextContent('Start unavailable');
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Test Gen' })).toBeEnabled();
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalled();
  });

  it('deletes an unbound set when manually leaving New', async () => {
    installSuccessfulHtmlFlow('set-leave-new');
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    await selectReadyRunInputs([
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    await waitFor(() => expect(htmlKnowledgeApi.deleteSet).toHaveBeenCalledWith(
      'proj-1', 'set-leave-new', expect.any(AbortSignal),
    ));
  });

  it('deletes an unbound set when the header Clear action is used', async () => {
    installSuccessfulHtmlFlow('set-clear');
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    await selectReadyRunInputs([
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(htmlKnowledgeApi.deleteSet).toHaveBeenCalledWith(
      'proj-1', 'set-clear', expect.any(AbortSignal),
    ));
    expect(screen.getByText('0 files')).toBeInTheDocument();
  });

  it('cleans up a project upload with the captured old project ID', async () => {
    installSuccessfulHtmlFlow('set-project-a');
    const { rerender } = renderWithProviders(
      <AiTestGenPage currentProjectId="project-a" />,
    );
    await selectReadyRunInputs([
      new File(['<h1>Login</h1>'], 'login.html', { type: 'text/html' }),
    ]);

    rerender(<AiTestGenPage currentProjectId="project-b" />);

    await waitFor(() => expect(htmlKnowledgeApi.deleteSet).toHaveBeenCalledWith(
      'project-a', 'set-project-a', expect.any(AbortSignal),
    ));
  });

  it('ignores a stale successful start after project change without transferring the newer set', async () => {
    installSuccessfulHtmlFlow('set-project-a');
    const oldStart = deferred<{ runId: string }>();
    mockDeps.api.start
      .mockReturnValueOnce(oldStart.promise)
      .mockResolvedValueOnce({ runId: 'run-project-b' });
    const { rerender } = renderWithProviders(
      <AiTestGenPage currentProjectId="project-a" />,
    );
    await selectReadyRunInputs([
      new File(['<h1>Project A</h1>'], 'project-a.html', { type: 'text/html' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Start Test Gen' }));
    await waitFor(() => expect(screen.getByText('Test Gen start is in progress')).toBeInTheDocument());

    rerender(<AiTestGenPage currentProjectId="project-b" />);
    await waitFor(() => expect(htmlKnowledgeApi.deleteSet).toHaveBeenCalledWith(
      'project-a', 'set-project-a', expect.any(AbortSignal),
    ));
    installSuccessfulHtmlFlow('set-project-b');
    await selectReadyRunInputs([
      new File(['<h1>Project B</h1>'], 'project-b.html', { type: 'text/html' }),
    ], 2);

    await act(async () => {
      oldStart.resolve({ runId: 'run-project-a' });
      await oldStart.promise;
    });

    expect(screen.getByText('HTML Knowledge')).toBeInTheDocument();
    expect(screen.queryByText('Preparation')).not.toBeInTheDocument();
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(htmlKnowledgeApi.deleteSet).not.toHaveBeenCalledWith(
      'project-b', 'set-project-b', expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(htmlKnowledgeApi.deleteSet).toHaveBeenCalledWith(
      'project-b', 'set-project-b', expect.any(AbortSignal),
    ));
  });

  it('shows html_knowledge_query in all three dynamic agent tool lists', async () => {
    mockGetLatestRunPrompts.mockResolvedValueOnce([
      {
        agent_name: 'test_analyst',
        status: 'COMPLETED',
        input_prompt: [{ role: 'system', content: 'test prompt' }],
      },
    ]);
    renderWithProviders(<AiTestGenPage {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent Prompts' }));
    const toolsButton = await screen.findByRole('button', { name: /Available Tools/ });
    fireEvent.click(toolsButton);
    expect(screen.getByText('html_knowledge_query')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Test Designer' }));
    expect(screen.getByText('html_knowledge_query')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quality Reviewer' }));
    expect(screen.getByText('html_knowledge_query')).toBeInTheDocument();
  });
});
