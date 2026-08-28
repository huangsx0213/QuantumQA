import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ReviewAssertionsPanel, type ReviewAssertionItem } from '../ReviewAssertionsPanel';
import type { StepAssertion } from '@/shared/types';

function makeItem(overrides: Partial<ReviewAssertionItem> = {}): ReviewAssertionItem {
  return {
    assertion: {
      id: 'assert-x',
      source: 'UI_PAGE_URL',
      operator: 'CONTAINS',
      expectedValue: '/dashboard',
      message: '[ai] AI generated from expected: "lands on dashboard"',
    },
    runs: [
      { passed: true, actualValue: 'https://a.test/dashboard' },
      { passed: false, actualValue: 'https://a.test/login' },
    ],
    reason: 'flaky across confirmation runs',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ReviewAssertionsPanel', () => {
  it('renders nothing for an empty queue', () => {
    const { container } = render(
      React.createElement(ReviewAssertionsPanel, { items: [] }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows proposal summary, reason, and per-run evidence', () => {
    render(
      React.createElement(ReviewAssertionsPanel, { items: [makeItem()] }),
    );
    expect(screen.getByText(/AI Review Queue \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Not confirmed: flaky across confirmation runs/)).toBeTruthy();
    expect(screen.getByText(/run1: PASS/)).toBeTruthy();
    expect(screen.getByText(/run2: FAIL/)).toBeTruthy();
    expect(screen.getByText(/\[UI_PAGE_URL\] CONTAINS/)).toBeTruthy();
  });

  it('accept promotes the assertion and dismiss removes it', () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    const item = makeItem();

    const { rerender } = render(
      React.createElement(ReviewAssertionsPanel, { items: [item], onAccept, onDismiss }),
    );

    fireEvent.click(screen.getByTitle('Accept as executable assertion'));
    expect(onAccept).toHaveBeenCalledWith(item.assertion);

    fireEvent.click(screen.getByTitle('Discard proposal'));
    expect(onDismiss).toHaveBeenCalledWith('assert-x');

    rerender(
      React.createElement(ReviewAssertionsPanel, { items: [], onAccept, onDismiss }),
    );
    expect(screen.queryByText(/AI Review Queue/)).toBeNull();
  });
});
