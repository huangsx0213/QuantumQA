import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { RecorderConfigPanel } from '../RecorderConfigPanel';

function makeNlCase() {
  return {
    id: 'nl-1',
    title: 'Login flow',
    status: 'APPROVED',
    generatedSuiteId: null as string | null,
    preconditions: ['https://app.example.com/login'],
    testData: [],
    steps: [{ sequence: 1, action: 'Type username', expected: 'value shown' }],
  } as any;
}

function makeProviderConfigs() {
  return [
    { id: 'pc-1', name: 'Test Provider', type: 'azure-openai', models: ['gpt-4o'] },
  ] as any[];
}

function renderPanel(overrides: Partial<Parameters<typeof RecorderConfigPanel>[0]> = {}, opts: { preselect?: boolean } = {}) {
  const onStart = vi.fn();
  const view = render(
    <RecorderConfigPanel
      nlCases={[makeNlCase()]}
      providerConfigs={makeProviderConfigs()}
      preselectNlCaseId={opts.preselect ? 'nl-1' : null}
      onStart={onStart}
      disabled={false}
      {...overrides}
    />,
  );
  return { onStart, unmount: () => view.unmount() };
}

function seedReadyConfig(): void {
  // 满足 Start 按钮的 providerConfigId/model 前置条件（nlCaseId 用 preselect）
  localStorage.setItem('ai-recorder-config', JSON.stringify({
    model: 'gpt-4o',
    modelName: 'gpt-4o',
    providerConfigId: 'pc-1',
    executionMode: 'agent',
    startUrl: '',
    headless: false,
    maxRetries: 2,
    timeoutPerStep: 30,
  }));
}

function getModeSelect(): HTMLSelectElement {
  return screen.getByLabelText(/execution position/i) as HTMLSelectElement;
}

function getStartUrlInput(): HTMLInputElement {
  return screen.getByLabelText(/start url/i) as HTMLInputElement;
}

describe('RecorderConfigPanel execution position', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('ai-recorder-config');
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem('ai-recorder-config');
  });

  it('defaults to Agent when nothing is saved', () => {
    renderPanel();
    expect(getModeSelect().value).toBe('agent');
  });

  it('renders both options', () => {
    renderPanel();
    const options = Array.from(getModeSelect().options).map((o) => o.value);
    expect(options).toEqual(['agent', 'local']);
  });

  it('persists the choice across remounts', () => {
    const first = renderPanel();
    fireEvent.change(getModeSelect(), { target: { value: 'local' } });
    expect(JSON.parse(localStorage.getItem('ai-recorder-config') || '{}').executionMode).toBe('local');
    first.unmount();

    renderPanel();
    expect(getModeSelect().value).toBe('local');
  });

  it('includes executionMode in the start payload', () => {
    seedReadyConfig();
    const { onStart } = renderPanel({}, { preselect: true });
    fireEvent.change(getModeSelect(), { target: { value: 'local' } });

    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toMatchObject({ executionMode: 'local' });
  });

  it('sends agent mode by default in the start payload', () => {
    seedReadyConfig();
    const { onStart } = renderPanel({}, { preselect: true });
    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));

    expect(onStart.mock.calls[0][0]).toMatchObject({ executionMode: 'agent' });
  });
});

describe('RecorderConfigPanel assertion compiler toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('ai-recorder-config');
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem('ai-recorder-config');
  });

  it('defaults to off and omits nothing when untouched', () => {
    seedReadyConfig();
    const { onStart } = renderPanel({}, { preselect: true });
    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));

    const payload = onStart.mock.calls[0][0];
    expect(payload.options.enableCompilePipeline).toBe(false);
  });

  it('toggling on sends enableCompilePipeline and persists across remounts', () => {
    seedReadyConfig();
    const first = renderPanel({}, { preselect: true });
    fireEvent.click(screen.getByTestId('compile-pipeline-toggle'));
    expect(JSON.parse(localStorage.getItem('ai-recorder-config') || '{}').compilePipeline).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));
    expect(onStartMock(first)).toMatchObject({ enableCompilePipeline: true });
    first.unmount();

    renderPanel({}, { preselect: true });
    // remount 后开关仍为开（aria/样式状态经 persisted config 恢复）
    expect(JSON.parse(localStorage.getItem('ai-recorder-config') || '{}').compilePipeline).toBe(true);
  });

  function onStartMock(handle: ReturnType<typeof renderPanel>) {
    return handle.onStart.mock.calls[0][0].options;
  }
});

describe('RecorderConfigPanel start URL override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('ai-recorder-config');
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem('ai-recorder-config');
  });

  function renderWithCase(caseOverrides: Record<string, unknown> = {}) {
    const onStart = vi.fn();
    const nlCase = { ...makeNlCase(), ...caseOverrides } as any;
    const view = render(
      <RecorderConfigPanel
        nlCases={[nlCase]}
        providerConfigs={makeProviderConfigs()}
        preselectNlCaseId="nl-1"
        onStart={onStart}
        disabled={false}
      />,
    );
    return { onStart, unmount: () => view.unmount() };
  }

  it('renders the override input empty by default with no warning for a resolvable case', () => {
    renderWithCase();
    expect(getStartUrlInput().value).toBe('');
    expect(screen.queryByTestId('start-url-warning')).toBeNull();
  });

  it('persists the override to localStorage across remounts', () => {
    const first = renderWithCase();
    fireEvent.change(getStartUrlInput(), { target: { value: 'https://override.com/home' } });
    expect(JSON.parse(localStorage.getItem('ai-recorder-config') || '{}').startUrl).toBe('https://override.com/home');
    first.unmount();

    renderWithCase();
    expect(getStartUrlInput().value).toBe('https://override.com/home');
  });

  it('includes a normalized startUrl in the start payload (scheme added)', () => {
    seedReadyConfig();
    const { onStart } = renderWithCase({ preconditions: [] });
    fireEvent.change(getStartUrlInput(), { target: { value: 'staging.app.dev/signin' } });
    fireEvent.change(getModeSelect(), { target: { value: 'local' } });

    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toMatchObject({ executionMode: 'local', startUrl: 'https://staging.app.dev/signin' });
  });

  it('shows an amber warning when the selected case has no detectable URL and no override', () => {
    renderWithCase({ preconditions: [], testData: [] });
    expect(screen.getByTestId('start-url-warning')).toHaveTextContent(/no resolvable start URL/i);
  });

  it('blocks start with a clear error when the override is not a valid URL', () => {
    seedReadyConfig();
    const { onStart } = renderWithCase();
    fireEvent.change(getStartUrlInput(), { target: { value: 'not a url' } });

    fireEvent.click(screen.getByRole('button', { name: /start ai recording/i }));

    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid Start URL/i)).toBeTruthy();
  });
});
