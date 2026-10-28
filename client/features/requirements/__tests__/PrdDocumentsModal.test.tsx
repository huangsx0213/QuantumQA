import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { api } from '@/shared/services/api';
import { PrdDocumentsModal } from '../PrdDocumentsModal';
import type { PrdDocument, PrdDocumentVersion } from '../../../../shared/contracts/index';

vi.mock('@/shared/services/api', () => ({
  api: {
    requirements: {
      listPrdDocuments: vi.fn(),
      getPrdDocumentVersions: vi.fn(),
      deletePrdDocument: vi.fn(),
      deletePrdDocumentVersion: vi.fn(),
    },
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('PrdDocumentsModal', () => {
  const mockDoc: PrdDocument = {
    id: 'doc-1',
    projectId: 'proj-1',
    title: 'Core Checkout PRD',
    fileType: 'markdown',
    currentVersionId: 'ver-2',
    currentVersionTag: 'v2.0',
    itemCount: 15,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockVersions: PrdDocumentVersion[] = [
    {
      id: 'ver-2',
      documentId: 'doc-1',
      versionNumber: 2,
      versionTag: 'v2.0',
      fileName: 'checkout_v2.md',
      fileSize: 4096,
      storagePath: 'storage/checkout_v2.md',
      parsedSummary: 'Updated checkout with promo codes',
      itemCount: 15,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'ver-1',
      documentId: 'doc-1',
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'checkout_v1.md',
      fileSize: 2048,
      storagePath: 'storage/checkout_v1.md',
      parsedSummary: 'Initial checkout feature',
      itemCount: 10,
      createdAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    vi.mocked(api.requirements.listPrdDocuments).mockReset();
    vi.mocked(api.requirements.getPrdDocumentVersions).mockReset();
    vi.mocked(api.requirements.deletePrdDocument).mockReset();
    vi.mocked(api.requirements.deletePrdDocumentVersion).mockReset();

    vi.mocked(api.requirements.listPrdDocuments).mockResolvedValue([mockDoc]);
    vi.mocked(api.requirements.getPrdDocumentVersions).mockResolvedValue(mockVersions);
    vi.mocked(api.requirements.deletePrdDocument).mockResolvedValue({ deletedRequirementsCount: 15 });
    vi.mocked(api.requirements.deletePrdDocumentVersion).mockResolvedValue({ deletedRequirementsCount: 15 });
  });

  it('renders document library with documents', async () => {
    render(
      <Wrapper>
        <PrdDocumentsModal projectId="proj-1" isOpen={true} onClose={() => {}} />
      </Wrapper>
    );

    expect(await screen.findByText('Core Checkout PRD')).toBeInTheDocument();
    expect(screen.getByText('v2.0')).toBeInTheDocument();
    expect(screen.getByText(/15 requirements/i)).toBeInTheDocument();
  });

  it('expands version list and displays individual versions', async () => {
    render(
      <Wrapper>
        <PrdDocumentsModal projectId="proj-1" isOpen={true} onClose={() => {}} />
      </Wrapper>
    );

    await screen.findByText('Core Checkout PRD');

    // Click versions toggle button
    const versionsBtn = screen.getByRole('button', { name: /toggle version history/i });
    fireEvent.click(versionsBtn);

    // Expect versions to be rendered
    expect(await screen.findByText('checkout_v2.md')).toBeInTheDocument();
    expect(screen.getByText('checkout_v1.md')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('opens delete version modal with cascade checkbox and confirms deletion', async () => {
    render(
      <Wrapper>
        <PrdDocumentsModal projectId="proj-1" isOpen={true} onClose={() => {}} />
      </Wrapper>
    );

    await screen.findByText('Core Checkout PRD');
    fireEvent.click(screen.getByRole('button', { name: /toggle version history/i }));
    await screen.findByText('checkout_v2.md');

    // Click delete version button for v2.0
    const deleteVersionBtn = screen.getByRole('button', { name: /delete version v2\.0/i });
    fireEvent.click(deleteVersionBtn);

    // Confirmation dialog should be visible with cascade checkbox checked by default
    expect(screen.getByText('Delete Version v2.0')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /also delete all 15 generated requirements/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();

    // Confirm deletion
    const confirmBtn = screen.getByRole('button', { name: /confirm delete version/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.requirements.deletePrdDocumentVersion).toHaveBeenCalledWith('proj-1', 'doc-1', 'ver-2', true);
    });
  });

  it('allows unlinking requirements when unchecking cascade box on version delete', async () => {
    render(
      <Wrapper>
        <PrdDocumentsModal projectId="proj-1" isOpen={true} onClose={() => {}} />
      </Wrapper>
    );

    await screen.findByText('Core Checkout PRD');
    fireEvent.click(screen.getByRole('button', { name: /toggle version history/i }));
    await screen.findByText('checkout_v1.md');

    const deleteVersionBtn = screen.getByRole('button', { name: /delete version v1\.0/i });
    fireEvent.click(deleteVersionBtn);

    // Uncheck cascade box
    const checkbox = screen.getByRole('checkbox', { name: /also delete all 10 generated requirements/i });
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // Confirm deletion
    const confirmBtn = screen.getByRole('button', { name: /confirm delete version/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.requirements.deletePrdDocumentVersion).toHaveBeenCalledWith('proj-1', 'doc-1', 'ver-1', false);
    });
  });

  it('opens delete document modal with cascade option and confirms deletion', async () => {
    render(
      <Wrapper>
        <PrdDocumentsModal projectId="proj-1" isOpen={true} onClose={() => {}} />
      </Wrapper>
    );

    await screen.findByText('Core Checkout PRD');
    const deleteDocBtn = screen.getByRole('button', { name: /delete document/i });
    fireEvent.click(deleteDocBtn);

    expect(screen.getByText('Delete PRD Document')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /also delete all 15 generated requirements/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();

    // Check cascade box
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    const confirmBtn = screen.getByRole('button', { name: /confirm delete document/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.requirements.deletePrdDocument).toHaveBeenCalledWith('proj-1', 'doc-1', true);
    });
  });

  it('triggers onUploadNewVersion when clicking New Version button on card', async () => {
    const onUploadNewVersion = vi.fn();
    const onClose = vi.fn();

    render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdDocumentsModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose,
          onUploadNewVersion,
        })
      )
    );

    expect(await screen.findByText('Core Checkout PRD')).toBeInTheDocument();

    const newVersionButtons = screen.getAllByRole('button', { name: /New Version/i });
    expect(newVersionButtons.length).toBeGreaterThan(0);

    fireEvent.click(newVersionButtons[0]);

    expect(onClose).toHaveBeenCalled();
    expect(onUploadNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'doc-1',
        title: 'Core Checkout PRD',
      })
    );
  });

  it('triggers onUploadNewVersion from inside the expanded version history', async () => {
    const onUploadNewVersion = vi.fn();
    const onClose = vi.fn();

    render(
      React.createElement(
        Wrapper,
        null,
        React.createElement(PrdDocumentsModal, {
          projectId: 'proj-1',
          isOpen: true,
          onClose,
          onUploadNewVersion,
        })
      )
    );

    expect(await screen.findByText('Core Checkout PRD')).toBeInTheDocument();

    // Expand versions
    const toggleButtons = screen.getAllByRole('button', { name: /Toggle version history/i });
    fireEvent.click(toggleButtons[0]);

    // Find "Upload New Version" button inside expanded list
    const uploadNewVersionBtn = await screen.findByRole('button', { name: /Upload New Version/i });
    expect(uploadNewVersionBtn).toBeInTheDocument();

    fireEvent.click(uploadNewVersionBtn);

    expect(onClose).toHaveBeenCalled();
    expect(onUploadNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'doc-1',
        title: 'Core Checkout PRD',
      })
    );
  });
});

