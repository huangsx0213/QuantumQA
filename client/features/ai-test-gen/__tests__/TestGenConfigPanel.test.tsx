import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TestGenConfigPanel, type TestGenStartConfig } from '../TestGenConfigPanel';
import type {
  HtmlKnowledgeUploadController,
  HtmlKnowledgeUploadRow,
} from '../useHtmlKnowledgeUpload';
import type { Requirement } from '../../../../shared/contracts/index';

vi.mock('@/shared/ui/HelpTooltip', () => ({
  HelpTooltip: ({ content }: { content: string }) => React.createElement('span', { 'data-testid': 'help-tooltip' }, content),
}));

vi.mock('../requirements/FormatSegmentBlock', () => ({
  FormatSegmentBlock: () => React.createElement('div', { 'data-testid': 'format-segment-block' }),
}));

vi.mock('../../shared/requirements/format-parser', () => ({
  parseStoryMarkdown: () => ({ role: '', action: '', value: '', remainder: '', hasAllSegments: true }),
  parseACMarkdown: () => ({ given: '', when: '', then: '', remainder: '', hasAllSegments: true }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
    }),
  };
});

import { useProviderConfigs, usePrdDocuments } from '@/shared/hooks/useQueryHooks';

vi.mock('@/shared/hooks/useQueryHooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/hooks/useQueryHooks')>();
  return {
    ...actual,
    useProviderConfigs: vi.fn().mockReturnValue({
      data: [
        { id: 'p1', name: 'Azure OpenAI', type: 'azure-openai', model: 'gpt-4o', models: ['gpt-4o'], isActive: true },
        { id: 'p2', name: 'OpenAI Compatible', type: 'openai-compatible', model: 'gpt-4', models: ['gpt-4'], isActive: false },
      ],
    }),
    usePrdDocuments: vi.fn().mockReturnValue({
      data: [],
    }),
  };
});

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    parentId: null,
    title: 'Test Requirement',
    description: 'A test requirement',
    level: 'story',
    status: 'DRAFT',
    position: 0,
    ...overrides,
  };
}

function makeFlowStory(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: `flow-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    parentId: null,
    title: 'Test Flow',
    description: 'A test flow',
    level: 'story',
    status: 'APPROVED',
    position: 0,
    isFlow: true,
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client: queryClient }, ui));
}

function makeUploadRow(status: HtmlKnowledgeUploadRow['status']): HtmlKnowledgeUploadRow {
  return {
    pageId: `page-${status.toLowerCase()}`,
    fileName: `${status.toLowerCase()}.html`,
    byteSize: 20,
    status,
    canRetry: status === 'FAILED',
    errorMessage: status === 'FAILED' ? 'Upload failed' : null,
    pageTitle: null,
    informationLevel: null,
    warnings: [],
  };
}

function makeUploadController(
  overrides: Partial<HtmlKnowledgeUploadController> = {},
): HtmlKnowledgeUploadController {
  return {
    rows: [],
    totalBytes: 0,
    phase: 'empty',
    isBlockingStart: false,
    selectFiles: vi.fn().mockResolvedValue(undefined),
    retryPage: vi.fn().mockResolvedValue(undefined),
    retrySet: vi.fn().mockResolvedValue(undefined),
    removePage: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    releaseAfterStart: vi.fn(),
    ...overrides,
  };
}

function buildTreeSample(): Requirement[] {
  const epic = makeRequirement({ id: 'epic-1', title: 'User Management', level: 'epic' as const, parentId: null });
  const feature = makeRequirement({ id: 'feat-1', title: 'User Registration', level: 'story' as const, parentId: epic.id });
  const story1 = makeRequirement({ id: 'story-1', title: 'Email Registration', level: 'story' as const, parentId: feature.id });
  const story2 = makeRequirement({ id: 'story-2', title: 'Phone Registration', level: 'story' as const, parentId: feature.id });
  return [epic, feature, story1, story2];
}

describe('TestGenConfigPanel', () => {
  afterEach(cleanup);

  const defaultProps = {
    projectId: 'proj-1',
    requirements: [],
    flowStories: [],
    onStart: vi.fn() as (config: TestGenStartConfig) => void,
    htmlKnowledgeUpload: makeUploadController(),
    disabled: false,
  };

  it('TC-1.1: renders requirement tree with expand/collapse', () => {
    const reqs = buildTreeSample();
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps, requirements: reqs }));
    expect(screen.getByText('User Management')).toBeTruthy();
    expect(screen.getByText('Requirements')).toBeTruthy();
  });

  it('TC-1.3: Select all checkbox selects/deselects all requirements', () => {
    const reqs = buildTreeSample();
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps, requirements: reqs }));

    const checkbox = screen.getAllByLabelText('Select all')[0];
    fireEvent.click(checkbox);
    // 3 stories selected (epic is not counted as a selectable leaf)
    expect(screen.getByText('3')).toBeTruthy();

    fireEvent.click(checkbox);
    expect(screen.queryByText('3')).toBeNull();
  });

  it('TC-1.4: Flow stories appear in the requirements tree', () => {
    const epic = makeRequirement({ id: 'epic-flow', title: 'Flow Epic', level: 'epic' as const, parentId: null });
    const flows = [
      makeFlowStory({ id: 'f1', title: 'Approved Flow', status: 'APPROVED', parentId: epic.id }),
      makeFlowStory({ id: 'f2', title: 'Draft Flow', status: 'DRAFT', parentId: epic.id }),
    ];
    const allReqs = [epic, ...flows];
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps, requirements: allReqs, flowStories: flows }));
    // Epic is visible in the tree
    expect(screen.getByText('Flow Epic')).toBeTruthy();
    // Expand all to reveal flow story children
    const expandBtn = screen.getByText('Expand');
    fireEvent.click(expandBtn);
    expect(screen.getByText('Approved Flow')).toBeTruthy();
    expect(screen.getByText('Draft Flow')).toBeTruthy();
  });

  it('TC-1.4a: Toggling a flow story only adds it to flowIds (no auto-linking)', () => {
    // Structure: epic → componentStory (with AC) + flowStory (with flow AC referencing componentStory)
    const epic = makeRequirement({ id: 'epic-1', title: 'Auth Epic', level: 'epic' as const, parentId: null });
    const componentStory = makeRequirement({ id: 'story-1', title: 'Login UI', level: 'story' as const, parentId: epic.id, isFlow: false });
    const flowStory = makeFlowStory({ id: 'flow-1', title: 'Login Flow', parentId: epic.id });
    const flowAC = makeRequirement({
      id: 'flow-1-ac1',
      title: 'Happy path login',
      level: 'ac' as const,
      parentId: flowStory.id,
      flowType: 'flow',
      relatedRequirementIds: ['story-1'],
    });
    const allReqs = [epic, componentStory, flowStory, flowAC];
    const onStart = vi.fn();
    renderWithQuery(React.createElement(TestGenConfigPanel, {
      ...defaultProps,
      requirements: allReqs,
      flowStories: [flowStory],
      onStart,
    }));

    // Expand tree to see flow story
    fireEvent.click(screen.getByText('Expand'));

    // Click the flow story's checkbox (purple checkbox for flow)
    const flowRow = screen.getByText('Login Flow').closest('div');
    const flowCheckbox = flowRow!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(flowCheckbox);

    // Verify onStart receives flowIds only — component stories are NOT auto-linked
    // (the backend resolves them at orchestration time)
    const startBtn = screen.getByRole('button', { name: /Start|Generate/i });
    fireEvent.click(startBtn);

    expect(onStart).toHaveBeenCalledTimes(1);
    const call = onStart.mock.calls[0][0] as TestGenStartConfig;
    expect(call.flowIds).toContain('flow-1');
    expect(call.requirementIds).not.toContain('story-1');
  });

  it('TC-1.4b: Toggling flow off removes it from flowIds', () => {
    const epic = makeRequirement({ id: 'epic-1', title: 'Auth Epic', level: 'epic' as const, parentId: null });
    const componentStory = makeRequirement({ id: 'story-1', title: 'Login UI', level: 'story' as const, parentId: epic.id, isFlow: false });
    const flowStory = makeFlowStory({ id: 'flow-1', title: 'Login Flow', parentId: epic.id });
    const flowAC = makeRequirement({
      id: 'flow-1-ac1',
      title: 'Happy path login',
      level: 'ac' as const,
      parentId: flowStory.id,
      flowType: 'flow',
      relatedRequirementIds: ['story-1'],
    });
    const allReqs = [epic, componentStory, flowStory, flowAC];
    const onStart = vi.fn();
    renderWithQuery(React.createElement(TestGenConfigPanel, {
      ...defaultProps,
      requirements: allReqs,
      flowStories: [flowStory],
      onStart,
    }));

    fireEvent.click(screen.getByText('Expand'));

    // First: toggle flow ON — should show flow count badge only
    const flowRow = screen.getByText('Login Flow').closest('div');
    const flowCheckbox = flowRow!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(flowCheckbox);

    // Verify the purple flow badge appears (1 flow)
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1);

    // Then: toggle flow OFF
    fireEvent.click(flowCheckbox);

    // Verify the count badge is gone
    const reqBadges = screen.queryAllByText('1');
    expect(reqBadges.length).toBe(0);
  });

  it('TC-1.6: mode toggle switches Auto/Interactive', () => {
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps }));
    const autoBtn = screen.getByRole('button', { name: /Auto/ });
    const interactiveBtn = screen.getByRole('button', { name: /Interactive/ });
    expect(autoBtn).toBeTruthy();
    expect(interactiveBtn).toBeTruthy();
    fireEvent.click(interactiveBtn);
    expect(screen.getByText('Pause at each checkpoint for review')).toBeTruthy();
    fireEvent.click(autoBtn);
    expect(screen.getByText('Run all stages automatically')).toBeTruthy();
  });

  it('TC-1.7: Model dropdown auto-selects from active provider config', () => {
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps }));
    // Active provider 'Azure OpenAI' has model 'gpt-4o' — auto-selected on mount
    expect(screen.getByText('gpt-4o')).toBeTruthy();
  });

  it('TC-1.8: Start button disabled when no requirements/flows selected', () => {
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps }));
    const startButton = screen.getByRole('button', { name: 'Start Test Gen' });
    const feedback = screen.getByText('Select at least one requirement or flow');
    expect(startButton).toBeDisabled();
    expect(feedback).toHaveAttribute('role', 'status');
    expect(feedback).toHaveAttribute('aria-live', 'polite');
    expect(startButton).toHaveAttribute('aria-describedby', feedback.id);
  });

  it('TC-1.9: Start button enabled when requirements and provider selected', () => {
    const reqs = buildTreeSample();
    const onStart = vi.fn();
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps, requirements: reqs, onStart }));
    // Model auto-selects from active provider on mount; only requirements need selection
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);
    const startBtn = screen.getByText('Start Test Gen');
    expect(startBtn.closest('button')).not.toBeDisabled();
    fireEvent.click(startBtn);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0].htmlKnowledgeSetId).toBeUndefined();
  });

  it('TC-1.10: Start passes an auto-generated run name', () => {
    const reqs = buildTreeSample();
    const onStart = vi.fn();
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps, requirements: reqs, onStart }));
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);
    fireEvent.click(screen.getByText('Start Test Gen'));
    expect(onStart).toHaveBeenCalledTimes(1);
    const config = onStart.mock.calls[0][0] as TestGenStartConfig;
    expect(typeof config.name).toBe('string');
    expect(config.name.length).toBeGreaterThan(0);
  });

  it('TC-8.2: shows warning when no providers configured', () => {
    vi.mocked(useProviderConfigs).mockReturnValueOnce({ data: [] } as any);
    renderWithQuery(React.createElement(TestGenConfigPanel, { ...defaultProps }));
    expect(screen.getByText(/No models configured/)).toBeTruthy();
  });

  it('shows the missing-provider start reason after a requirement is selected', () => {
    const providerHook = vi.mocked(useProviderConfigs);
    const originalImplementation = providerHook.getMockImplementation();
    providerHook.mockReturnValue({ data: [] } as any);
    try {
      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={buildTreeSample()} />);
      fireEvent.click(screen.getAllByLabelText('Select all')[0]);

      expect(screen.getByText('Select a model to continue')).toBeInTheDocument();
    } finally {
      if (originalImplementation) providerHook.mockImplementation(originalImplementation);
    }
  });

  it.each([
    ['invalid', makeUploadController({
      rows: [makeUploadRow('FAILED')],
      totalBytes: 20,
      phase: 'invalid',
      isBlockingStart: true,
    })],
    ['pending', makeUploadController({
      rows: [makeUploadRow('PENDING')],
      totalBytes: 20,
      phase: 'preparing',
      isBlockingStart: true,
    })],
    ['failed', makeUploadController({
      rows: [makeUploadRow('FAILED')],
      totalBytes: 20,
      phase: 'failed',
      isBlockingStart: true,
    })],
  ])('blocks start while HTML knowledge is %s', (_label, htmlKnowledgeUpload) => {
    const reqs = buildTreeSample();
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={reqs}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
    />);

    fireEvent.click(screen.getAllByLabelText('Select all')[0]);

    expect(screen.getByRole('button', { name: 'Start Test Gen' })).toBeDisabled();
  });

  it('shows HTML preparation as the blocking reason for a flow-only selection', () => {
    const flow = makeFlowStory({ id: 'flow-only', title: 'Checkout Flow' });
    const htmlKnowledgeUpload = makeUploadController({
      rows: [makeUploadRow('READY')],
      totalBytes: 20,
      phase: 'preparing',
      isBlockingStart: true,
    });
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={[flow]}
      flowStories={[flow]}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
    />);
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);

    expect(screen.getByText('Wait for HTML knowledge preparation to finish')).toBeInTheDocument();
    expect(screen.queryByText('Select at least one requirement or flow')).not.toBeInTheDocument();
  });

  it('shows an HTML error reason when the upload set failed', () => {
    const htmlKnowledgeUpload = makeUploadController({
      rows: [makeUploadRow('FAILED')],
      totalBytes: 20,
      phase: 'failed',
      isBlockingStart: true,
    });
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={buildTreeSample()}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
    />);
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);

    expect(screen.getByText('Resolve HTML knowledge errors before starting')).toBeInTheDocument();
  });

  it('shows start-attempt progress and disables reset, upload, and Start controls', () => {
    const htmlKnowledgeUpload = makeUploadController({
      rows: [makeUploadRow('READY')],
      totalBytes: 20,
      phase: 'ready',
      readySetId: 'set-ready-1',
    });
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={buildTreeSample()}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
      startPending
    />);
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);

    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.getByLabelText('Choose HTML files')).toBeDisabled();
    const startButton = screen.getByRole('button', { name: /Starting Test Gen/ });
    const feedback = screen.getByText('Test Gen start is in progress');
    expect(startButton).toBeDisabled();
    expect(feedback).toHaveAttribute('role', 'status');
    expect(feedback).toHaveAttribute('aria-live', 'polite');
    expect(startButton).toHaveAttribute('aria-describedby', feedback.id);
  });

  it('allows LOW_INFORMATION HTML and includes the exact ready set ID', () => {
    const reqs = buildTreeSample();
    const onStart = vi.fn();
    const htmlKnowledgeUpload = makeUploadController({
      rows: [{
        ...makeUploadRow('READY'),
        informationLevel: 'LOW_INFORMATION',
        warnings: ['Only a root mount element was found'],
      }],
      totalBytes: 20,
      phase: 'ready',
      readySetId: 'set-ready-1',
      isBlockingStart: false,
    });
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={reqs}
      onStart={onStart}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
    />);

    fireEvent.click(screen.getAllByLabelText('Select all')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Start Test Gen' }));

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      htmlKnowledgeSetId: 'set-ready-1',
    }));
  });

  it('resets HTML knowledge together with the existing settings', () => {
    const reqs = buildTreeSample();
    const htmlKnowledgeUpload = makeUploadController({
      rows: [makeUploadRow('READY')],
      totalBytes: 20,
      phase: 'ready',
      readySetId: 'set-ready-1',
    });
    renderWithQuery(<TestGenConfigPanel
      {...defaultProps}
      requirements={reqs}
      htmlKnowledgeUpload={htmlKnowledgeUpload}
    />);
    fireEvent.click(screen.getAllByLabelText('Select all')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(htmlKnowledgeUpload.reset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Run all stages automatically')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Test Gen' })).toBeDisabled();
  });

  describe('PRD Document & Version filtering and provenance', () => {
    const mockPrdDocs = [
      {
        id: 'doc-1',
        title: 'Billing Specification',
        currentVersionTag: 'v1.1',
        versions: [
          { id: 'ver-1', versionTag: 'v1.0', versionNumber: 1, fileName: 'billing-v1.0.md' },
          { id: 'ver-2', versionTag: 'v1.1', versionNumber: 2, fileName: 'billing-v1.1.docx' },
        ],
      },
      {
        id: 'doc-2',
        title: 'Auth PRD',
        currentVersionTag: 'v1.0',
        versions: [
          { id: 'ver-3', versionTag: 'v1.0', versionNumber: 1, fileName: 'auth.docx' },
        ],
      },
    ];

    it('renders PRD Document & Version dropdown and search input when prdDocs exist', () => {
      vi.mocked(usePrdDocuments).mockReturnValue({ data: mockPrdDocs } as any);
      const reqs = buildTreeSample();
      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={reqs} />);

      expect(screen.getByPlaceholderText('Filter requirements...')).toBeInTheDocument();
      expect(screen.getByTitle('Filter requirements tree by PRD Document or Version')).toBeInTheDocument();
      expect(screen.getByText(/All Documents & Versions/)).toBeInTheDocument();
      expect(screen.getByText('All Versions of "Billing Specification" (0 items)')).toBeInTheDocument();
      expect(screen.getByText('All Versions of "Auth PRD" (0 items)')).toBeInTheDocument();
    });

    it('filters requirement tree by document and preserves parent epic hierarchy', () => {
      vi.mocked(usePrdDocuments).mockReturnValue({ data: mockPrdDocs } as any);
      const epic = makeRequirement({ id: 'epic-1', title: 'Main Epic', level: 'epic', parentId: null });
      const storyDoc1 = makeRequirement({
        id: 'story-doc-1',
        title: 'Billing Story',
        level: 'story',
        parentId: 'epic-1',
        documentId: 'doc-1',
        documentVersionId: 'ver-1',
      });
      const storyDoc2 = makeRequirement({
        id: 'story-doc-2',
        title: 'Auth Story',
        level: 'story',
        parentId: 'epic-1',
        documentId: 'doc-2',
        documentVersionId: 'ver-3',
      });

      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={[epic, storyDoc1, storyDoc2]} />);

      const select = screen.getByTitle('Filter requirements tree by PRD Document or Version');
      fireEvent.change(select, { target: { value: 'doc:doc-1' } });

      // Parent epic must remain visible
      expect(screen.getByText('Main Epic')).toBeInTheDocument();
      // Story matching doc-1 is shown
      expect(screen.getByText('Billing Story')).toBeInTheDocument();
      // Story from doc-2 should NOT be in the tree
      expect(screen.queryByText('Auth Story')).toBeNull();
    });

    it('filters requirement tree by search query', () => {
      vi.mocked(usePrdDocuments).mockReturnValue({ data: [] } as any);
      const epic = makeRequirement({ id: 'epic-1', title: 'Main Epic', level: 'epic', parentId: null });
      const story1 = makeRequirement({ id: 'story-1', title: 'Payment Processing', level: 'story', parentId: 'epic-1' });
      const story2 = makeRequirement({ id: 'story-2', title: 'User Login', level: 'story', parentId: 'epic-1' });

      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={[epic, story1, story2]} />);

      const searchInput = screen.getByPlaceholderText('Filter requirements...');
      fireEvent.change(searchInput, { target: { value: 'payment' } });

      expect(screen.getByText('Main Epic')).toBeInTheDocument();
      expect(screen.getByText('Payment Processing')).toBeInTheDocument();
      expect(screen.queryByText('User Login')).toBeNull();
    });

    it('Select all only affects visible filtered stories', () => {
      vi.mocked(usePrdDocuments).mockReturnValue({ data: mockPrdDocs } as any);
      const epic = makeRequirement({ id: 'epic-1', title: 'Main Epic', level: 'epic', parentId: null });
      const storyDoc1 = makeRequirement({
        id: 'story-doc-1',
        title: 'Billing Story',
        level: 'story',
        parentId: 'epic-1',
        documentId: 'doc-1',
      });
      const storyDoc2 = makeRequirement({
        id: 'story-doc-2',
        title: 'Auth Story',
        level: 'story',
        parentId: 'epic-1',
        documentId: 'doc-2',
      });

      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={[epic, storyDoc1, storyDoc2]} />);

      // Filter by doc-1
      const select = screen.getByTitle('Filter requirements tree by PRD Document or Version');
      fireEvent.change(select, { target: { value: 'doc:doc-1' } });

      // Click Select all (which only selects visible filtered stories)
      const selectAll = screen.getAllByLabelText('Select all')[0];
      fireEvent.click(selectAll);

      // Now switch back to "all" documents
      fireEvent.change(select, { target: { value: 'all' } });

      // Requirements count badge should show 1 selected
      expect(screen.getByText('1')).toBeInTheDocument();

      // Since epic was expanded, both stories are in the document
      expect(screen.getByText('Billing Story')).toBeInTheDocument();
      expect(screen.getByText('Auth Story')).toBeInTheDocument();

      // Test collapsing all and expanding all
      fireEvent.click(screen.getByTitle('Collapse all'));
      expect(screen.queryByText('Billing Story')).toBeNull();
      expect(screen.queryByText('Auth Story')).toBeNull();

      fireEvent.click(screen.getByTitle('Expand all'));
      expect(screen.getByText('Billing Story')).toBeInTheDocument();
      expect(screen.getByText('Auth Story')).toBeInTheDocument();
    });

    it('shows PRD Document name and version in detail view metadata when selected', () => {
      vi.mocked(usePrdDocuments).mockReturnValue({ data: mockPrdDocs } as any);
      const story = makeRequirement({
        id: 'story-1',
        title: 'Invoice Generation',
        level: 'story',
        parentId: null,
        documentId: 'doc-1',
        sourceAnchor: 'Section 3.2',
      });

      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={[story]} />);

      // Click story to view details
      fireEvent.click(screen.getByText('Invoice Generation'));

      expect(screen.getByText('Billing Specification (v1.1)')).toBeInTheDocument();
      expect(screen.getByText('Section 3.2')).toBeInTheDocument();
    });

    it('toggles individual epic with chevron button and all epics with header button', () => {
      const epic1 = makeRequirement({ id: 'epic-1', title: 'Epic 1', level: 'epic', parentId: null });
      const story1 = makeRequirement({ id: 'story-1', title: 'Story 1', level: 'story', parentId: 'epic-1' });
      const epic2 = makeRequirement({ id: 'epic-2', title: 'Epic 2', level: 'epic', parentId: null });
      const story2 = makeRequirement({ id: 'story-2', title: 'Story 2', level: 'story', parentId: 'epic-2' });

      renderWithQuery(<TestGenConfigPanel {...defaultProps} requirements={[epic1, story1, epic2, story2]} />);

      // Initially collapsed
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();

      // Click Expand button
      fireEvent.click(screen.getByText('Expand'));
      expect(screen.getByText('Story 1')).toBeInTheDocument();
      expect(screen.getByText('Story 2')).toBeInTheDocument();

      // Toggle chevron on Epic 1 to collapse only Epic 1
      const epic1Row = screen.getByText('Epic 1').closest('div')!;
      const chevron1 = epic1Row.querySelector('button')!;
      fireEvent.click(chevron1);

      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.getByText('Story 2')).toBeInTheDocument();

      // Click chevron on Epic 1 again to re-expand Epic 1
      fireEvent.click(chevron1);
      expect(screen.getByText('Story 1')).toBeInTheDocument();
      expect(screen.getByText('Story 2')).toBeInTheDocument();

      // Click Collapse button to collapse all
      fireEvent.click(screen.getByText('Collapse'));
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();
    });
  });
});
