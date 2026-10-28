import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { StoryDetailView } from "../StoryDetailView";
import type { Requirement } from "../../../../shared/contracts/index";

// Mock the hooks to avoid real network calls
vi.mock("../../../shared/hooks/useQueryHooks", () => ({
  useRequirementMutations: () => ({
    update: vi.fn().mockResolvedValue(undefined),
    updateId: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  }),
  useRequirements: () => ({ data: [] }),
  usePrdDocuments: () => ({ data: [] }),
}));

function makeStory(overrides: Partial<Requirement> & { id: string }): Requirement {
  return {
    projectId: "p1",
    parentId: null,
    title: "Story Title",
    description: "As a user\nI want to do x\nSo that y",
    level: "story",
    status: "DRAFT",
    position: 0,
    ...overrides,
  } as Requirement;
}

function makeAC(overrides: Partial<Requirement> & { id: string }): Requirement {
  return {
    projectId: "p1",
    parentId: "story-1",
    title: "AC",
    description: "Given x\nWhen y\nThen z",
    level: "ac",
    flowType: "atomic",
    status: "DRAFT",
    position: 0,
    ...overrides,
  } as Requirement;
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe("StoryDetailView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders story header with title and id", () => {
    const story = makeStory({ id: "story-1", title: "User changes password" });
    render(
      React.createElement(Wrapper, null,
        React.createElement(StoryDetailView, {
          story,
          acs: [],
          projectId: "p1",
          onSaved: vi.fn(),
        })
      )
    );
    // Title is rendered as an <input value=...> — use getByDisplayValue (canonical query for form inputs)
    expect(screen.getByDisplayValue("User changes password")).toBeInTheDocument();
    // id is rendered as text inside a <span>
    expect(screen.getByText("story-1")).toBeInTheDocument();
  });

  it("renders AC summary chip with approved/total count", () => {
    const story = makeStory({ id: "story-1" });
    const acs = [
      makeAC({ id: "ac-1", status: "APPROVED" }),
      makeAC({ id: "ac-2", status: "DRAFT" }),
    ];
    render(
      React.createElement(Wrapper, null,
        React.createElement(StoryDetailView, {
          story,
          acs,
          projectId: "p1",
          onSaved: vi.fn(),
        })
      )
    );
    expect(screen.getByTestId("ac-progress")).toHaveTextContent("1/2 approved");
  });

  it("does not render priority selector (removed field)", () => {
    const story = makeStory({ id: "story-1" });
    render(
      React.createElement(Wrapper, null,
        React.createElement(StoryDetailView, {
          story,
          acs: [],
          projectId: "p1",
          onSaved: vi.fn(),
        })
      )
    );
    expect(screen.queryByText(/^Priority$/i)).not.toBeInTheDocument();
  });

  it("renders story description markdown", () => {
    const story = makeStory({ id: "story-1", description: "As a user\nI want to do x\nSo that y" });
    render(
      React.createElement(Wrapper, null,
        React.createElement(StoryDetailView, {
          story,
          acs: [],
          projectId: "p1",
          onSaved: vi.fn(),
        })
      )
    );
    expect(screen.getByText(/As a/)).toBeInTheDocument();
    expect(screen.getByText(/I want/)).toBeInTheDocument();
    expect(screen.getByText(/So that/)).toBeInTheDocument();
  });

  it("renders single-sentence continuous user story without warning", () => {
    const story = makeStory({
      id: "story-1",
      description: "As a first-time user, I want to see a clear sign-in form so that I can identify how to authenticate.",
    });
    render(
      React.createElement(Wrapper, null,
        React.createElement(StoryDetailView, {
          story,
          acs: [],
          projectId: "p1",
          onSaved: vi.fn(),
        })
      )
    );
    expect(screen.getByText("first-time user")).toBeInTheDocument();
    expect(screen.getByText("see a clear sign-in form")).toBeInTheDocument();
    expect(screen.getByText("identify how to authenticate")).toBeInTheDocument();
    expect(screen.queryByText(/segments not detected/i)).not.toBeInTheDocument();
  });
});
