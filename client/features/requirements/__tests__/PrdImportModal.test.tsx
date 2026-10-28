import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { api } from '@/shared/services/api';
import { PrdImportModal } from '../PrdImportModal';

vi.mock('@/shared/services/api', () => ({
  api: {
    requirements: {
      listPrdDocuments: vi.fn().mockResolvedValue([]),
      parsePrdPreview: vi.fn(),
      commitPrdImport: vi.fn(),
    },
    providerConfigs: {
      list: vi.fn(),
    },
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('PrdImportModal - Model Dropdown Selection', () => {
  const defaultProviders = [
    {
      id: 'prov-1',
      name: 'OpenAI Main',
      type: 'openai',
      isActive: true,
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
      id: 'prov-2',
      name: 'Claude Corp',
      type: 'anthropic',
      isActive: false,
      models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
    },
  ];

  beforeEach(() => {
    vi.mocked(api.providerConfigs.list).mockResolvedValue(defaultProviders as any);
    vi.mocked(api.requirements.listPrdDocuments).mockResolvedValue([]);
  });

  it('renders model selector dropdown with available models and custom option', async () => {
    render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdImportModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      )
    );

    // AI Provider selection
    expect(await screen.findByText(/AI Model Configuration/i)).toBeInTheDocument();

    // Model select element
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);

    // The model select should have the models from active provider
    await waitFor(() => {
      const gpt4oOption = screen.queryByRole('option', { name: 'gpt-4o' });
      expect(gpt4oOption).toBeInTheDocument();
    });

    const gpt4oMiniOption = screen.getByRole('option', { name: 'gpt-4o-mini' });
    expect(gpt4oMiniOption).toBeInTheDocument();

    const customOption = screen.getByRole('option', { name: '+ Enter custom model name...' });
    expect(customOption).toBeInTheDocument();
  });

  it('allows switching to custom model input and back to list', async () => {
    render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdImportModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      )
    );

    await screen.findByText(/AI Model Configuration/i);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'gpt-4o' })).toBeInTheDocument();
    });

    // Find the model select
    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects.find((sel) =>
      Array.from((sel as HTMLSelectElement).options).some((o) => o.value === 'gpt-4o')
    );
    expect(modelSelect).toBeDefined();

    // Select custom model option
    fireEvent.change(modelSelect!, { target: { value: '__custom__' } });

    // Custom model input should appear
    const customInput = await screen.findByPlaceholderText('e.g. gpt-4o, deepseek-chat');
    expect(customInput).toBeInTheDocument();

    // Enter a custom model name
    fireEvent.change(customInput, { target: { value: 'my-finetuned-llama' } });
    expect((customInput as HTMLInputElement).value).toBe('my-finetuned-llama');

    // Switch back to list
    const backBtn = screen.getByRole('button', { name: /Choose from list/i });
    fireEvent.click(backBtn);

    // Model select should reappear
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('e.g. gpt-4o, deepseek-chat')).not.toBeInTheDocument();
    });
  });

  it('renders upload new version UI when opened with initialDocumentToUpdate', async () => {
    const existingDoc = {
      id: 'doc-123',
      projectId: 'proj-1',
      title: 'Auth Module PRD',
      fileType: 'markdown' as const,
      currentVersionId: 'v-1',
      currentVersionTag: 'v1.0',
      itemCount: 5,
      createdAt: '2026-10-27T10:00:00Z',
      updatedAt: '2026-10-27T10:00:00Z',
    };
    vi.mocked(api.requirements.listPrdDocuments).mockResolvedValue([existingDoc]);

    render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdImportModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose: vi.fn(),
          onImported: vi.fn(),
          initialDocumentToUpdate: existingDoc,
        })
      )
    );

    // Modal title reflects update mode
    expect(await screen.findByText('Upload New PRD Version (AI-Powered)')).toBeInTheDocument();
    expect(
      screen.getByText(/Upload a new version of "Auth Module PRD"/i)
    ).toBeInTheDocument();

    // Destination mode shows update selected
    expect(screen.getByText('Update Existing PRD (New Version)')).toBeInTheDocument();

    // Dropzone presents upload new version UI
    expect(screen.getByText('Upload New Version Document (.docx, .xlsx, .md, .csv)')).toBeInTheDocument();
    expect(
      screen.getByText('Click to browse or drag & drop new version file here')
    ).toBeInTheDocument();

    // Document title input is populated
    const titleInput = screen.getByDisplayValue('Auth Module PRD');
    expect(titleInput).toBeInTheDocument();

    // Action button reflects parse & diff
    expect(screen.getByRole('button', { name: /Start AI Parsing & Diff/i })).toBeInTheDocument();
  });

  it('resets to upload dropzone config step when reopened after previous parse/commit', async () => {
    const existingDoc = {
      id: 'doc-123',
      projectId: 'proj-1',
      title: 'Auth Module PRD',
      fileType: 'markdown' as const,
      currentVersionId: 'v-1',
      currentVersionTag: 'v1.0',
      itemCount: 5,
      createdAt: '2026-10-27T10:00:00Z',
      updatedAt: '2026-10-27T10:00:00Z',
    };
    vi.mocked(api.requirements.listPrdDocuments).mockResolvedValue([existingDoc]);

    const { rerender } = render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdImportModal, {
          projectId: 'proj-1',
          isOpen: false,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      )
    );

    // Modal is initially closed
    expect(screen.queryByText('Import PRD Document (AI-Powered)')).not.toBeInTheDocument();

    // Open modal with initialDocumentToUpdate (user clicked New Version)
    rerender(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdImportModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose: vi.fn(),
          onImported: vi.fn(),
          initialDocumentToUpdate: existingDoc,
        })
      )
    );

    // Upload UI is immediately visible
    expect(await screen.findByText('Upload New PRD Version (AI-Powered)')).toBeInTheDocument();
    expect(screen.getByText('Click to browse or drag & drop new version file here')).toBeInTheDocument();
  });
});

