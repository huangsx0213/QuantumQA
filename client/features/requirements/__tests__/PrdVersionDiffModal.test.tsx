import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { api } from '@/shared/services/api';
import { PrdVersionDiffModal } from '../PrdVersionDiffModal';
import type { PrdDocument, PrdDocumentVersion, PrdVersionDiffResult } from '../../../../shared/contracts/index';

vi.mock('@/shared/services/api', () => ({
  api: {
    requirements: {
      getPrdDocumentVersions: vi.fn(),
      getPrdDocumentDiff: vi.fn(),
    },
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('PrdVersionDiffModal', () => {
  const mockDoc: PrdDocument = {
    id: 'doc-1',
    projectId: 'proj-1',
    title: 'Authentication PRD',
    fileType: 'markdown',
    currentVersionId: 'ver-2',
    currentVersionTag: 'v1.1',
    itemCount: 112,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockVersions: PrdDocumentVersion[] = [
    {
      id: 'ver-2',
      documentId: 'doc-1',
      versionNumber: 2,
      versionTag: 'v1.1',
      fileName: 'auth_v1.1.md',
      fileSize: 4096,
      storagePath: 'storage/auth_v1.1.md',
      itemCount: 112,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'ver-1',
      documentId: 'doc-1',
      versionNumber: 1,
      versionTag: 'v1.0',
      fileName: 'auth_v1.0.md',
      fileSize: 2048,
      storagePath: 'storage/auth_v1.0.md',
      itemCount: 111,
      createdAt: new Date().toISOString(),
    },
  ];

  const mockDiffResult: PrdVersionDiffResult = {
    documentId: 'doc-1',
    documentTitle: 'Authentication PRD',
    baseVersion: mockVersions[1],
    targetVersion: mockVersions[0],
    stats: {
      total: 114,
      epics: 7,
      stories: 33,
      acs: 74,
      added: 3,
      modified: 3,
      deprecated: 2,
      unchanged: 106,
    },
    items: [
      {
        id: 'epic-auth',
        title: 'Authentication Module',
        description: 'User login and security',
        level: 'epic',
        diffStatus: 'unchanged',
      },
      {
        id: 'story-login',
        title: 'User Login',
        description: 'As a user I want to log in',
        level: 'story',
        parentId: 'epic-auth',
        diffStatus: 'unchanged',
      },
      {
        id: 'ac-wrong-pass',
        title: 'Wrong password rejected',
        description: 'Given login page\nWhen user enters wrong pass\nThen show error\nAnd lockout after 5 tries',
        previousDescription: 'Given login page\nWhen user enters wrong pass\nThen show error',
        level: 'ac',
        parentId: 'story-login',
        diffStatus: 'modified',
      },
      {
        id: 'story-reset',
        title: 'Test data reset endpoint',
        description: 'As a developer I want reset endpoint',
        level: 'story',
        parentId: 'epic-auth',
        diffStatus: 'added',
      },
      {
        id: 'story-xml',
        title: 'XML content type',
        description: 'Deprecated XML response endpoint',
        level: 'story',
        parentId: 'epic-auth',
        diffStatus: 'deprecated',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.requirements.getPrdDocumentVersions).mockResolvedValue(mockVersions);
    vi.mocked(api.requirements.getPrdDocumentDiff).mockResolvedValue(mockDiffResult);
  });

  it('renders diff metrics and version comparison options', async () => {
    render(
      <Wrapper>
        <PrdVersionDiffModal
          projectId="proj-1"
          document={mockDoc}
          isOpen={true}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/Version Diff: Authentication PRD/i)).toBeInTheDocument();
    });

    // Check version options
    expect(screen.getByText('Base Version:')).toBeInTheDocument();
    expect(screen.getByText('Target Version:')).toBeInTheDocument();

    // Check metrics filter badges
    await waitFor(() => {
      expect(screen.getByText(/\+ 3 Added/i)).toBeInTheDocument();
      expect(screen.getByText(/~ 3 Modified/i)).toBeInTheDocument();
      expect(screen.getByText(/- 2 Deprecated/i)).toBeInTheDocument();
      expect(screen.getByText(/106 Unchanged/i)).toBeInTheDocument();
    });
  });

  it('displays Before vs After specification comparison for modified requirement', async () => {
    render(
      <Wrapper>
        <PrdVersionDiffModal
          projectId="proj-1"
          document={mockDoc}
          isOpen={true}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getAllByText('Wrong password rejected').length).toBeGreaterThan(0);
    });

    // Modified item is auto-selected or clicked
    fireEvent.click(screen.getAllByText('Wrong password rejected')[0]);

    await waitFor(() => {
      expect(screen.getByText(/Modified Specification/i)).toBeInTheDocument();
      expect(screen.getByText(/Previous Specification \(v1\.0\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Updated Specification \(v1\.1\)/i)).toBeInTheDocument();
    });
  });

  it('filters items when clicking diff status pills', async () => {
    render(
      <Wrapper>
        <PrdVersionDiffModal
          projectId="proj-1"
          document={mockDoc}
          isOpen={true}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/\+ 3 Added/i)).toBeInTheDocument();
    });

    // Filter to Added
    fireEvent.click(screen.getByText(/\+ 3 Added/i));

    await waitFor(() => {
      expect(screen.getByText('Test data reset endpoint')).toBeInTheDocument();
    });
  });

  it('invokes onClose when clicking close button', async () => {
    const handleClose = vi.fn();
    render(
      <Wrapper>
        <PrdVersionDiffModal
          projectId="proj-1"
          document={mockDoc}
          isOpen={true}
          onClose={handleClose}
        />
      </Wrapper>
    );

    const closeBtn = screen.getByLabelText('Close diff viewer');
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
