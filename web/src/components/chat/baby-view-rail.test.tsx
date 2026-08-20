// danbot-byok — web/src/components/chat/baby-view-rail.test.tsx
//
// Row 18 at the component tier: that the rail opens on BOTH hover and keyboard
// focus, closes on Escape without stranding focus, and that what it draws is
// the real document's own nodes rather than a placeholder.
//
// The reads are stubbed at `globalThis.fetch` with the bodies the store
// actually serves, so the projection under test is driven by a document that
// travelled the real client path (`resolveCurrentPipeline` → the shared
// `dag-workflows` helpers → `apiFetch`).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSideRail } from "./baby-view-rail";
import { NO_PIPELINE_REASON, PIPELINE_READ_ERROR } from "@/lib/baby-view";

const GRAPH = {
  schemaVersion: "1.0",
  id: "chat-e2e-workflow",
  name: "Silhouette pipeline",
  entryNodeId: "prepare",
  limits: {
    maxIterations: 6,
    maxModelCalls: 8,
    maxParallelism: 2,
    maxSubagents: 2,
    timeoutMs: 300_000,
    maxTokens: 50_000,
    maxCostUsd: 5,
    maxRetries: 2,
  },
  evidence: {
    enabled: true,
    minimumIndependentSources: 1,
    requireArtifactReferences: false,
    onUnsupportedOutput: "fail",
  },
  nodes: [
    { id: "prepare", name: "Prepare counts", kind: "agent", terminal: false, workspace: { isolation: "read-only", writePaths: [] }, prompt: "p" },
    { id: "analyze", name: "Analyze clusters", kind: "agent", terminal: true, workspace: { isolation: "read-only", writePaths: [] }, prompt: "a" },
  ],
  edges: [{ id: "prepare-analyze", from: "prepare", to: "analyze" }],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The three GETs the resolver makes, answered as the store answers them. */
function routeFetch(overrides: {
  link?: unknown;
  list?: unknown;
  definition?: unknown;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/workflow-run-state")) {
      return jsonResponse(
        overrides.link ?? {
          state: { schemaVersion: 1, runId: "wrun_1", workflowId: "chat-e2e-workflow", status: "running" },
        },
      );
    }
    if (/\/dag-workflows\/[^/]+$/.test(url)) {
      return jsonResponse(
        overrides.definition ?? {
          storageVersion: 1,
          id: "chat-e2e-workflow",
          revision: 3,
          createdAt: 1,
          updatedAt: 2,
          graphSha256: "sha",
          graph: GRAPH,
        },
        200,
        { ETag: '"3"' },
      );
    }
    if (url.endsWith("/dag-workflows")) {
      // The registry must list the linked workflow, or the resolver correctly
      // refuses to read it. See `resolveCurrentPipeline`'s header.
      return jsonResponse(
        overrides.list ?? {
          workflows: [
            { id: "chat-e2e-workflow", revision: 3, createdAt: 1, updatedAt: 5, graphSha256: "s", schemaVersion: "1.0", name: "Silhouette pipeline", description: null, nodeCount: 2, edgeCount: 1 },
          ],
        },
      );
    }
    return jsonResponse({}, 404);
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", routeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderRail() {
  return render(<ChatSideRail projectId="default" sessionId="session-a" enabled />);
}

function trigger() {
  return screen.getByRole("button", { name: /Pipeline preview/ });
}

describe("ChatSideRail — Gate U, hover AND keyboard both open it", () => {
  it("is in the tab order and opens on focus", async () => {
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Pipeline preview" })).toBeInTheDocument();
  });

  it("opens on pointer hover", async () => {
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));

    await user.hover(trigger());
    expect(screen.getByRole("dialog", { name: "Pipeline preview" })).toBeInTheDocument();
  });

  it("closes on Escape and leaves focus on the trigger", async () => {
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));

    await user.tab();
    expect(screen.getByRole("dialog", { name: "Pipeline preview" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Pipeline preview" })).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("traps keyboard focus and cycles in both directions", async () => {
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));
    await user.tab();
    const overlay = screen.getByRole("dialog", { name: "Pipeline preview" });
    const close = within(overlay).getByRole("button", { name: "Close pipeline preview" });

    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Pipeline preview" })).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });
});

describe("ChatSideRail — Gate B, the ACTUAL current pipeline", () => {
  it("draws the linked document's own nodes and says the preview is linked to this chat", async () => {
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));
    await user.hover(trigger());

    const overlay = screen.getByRole("dialog", { name: "Pipeline preview" });
    expect(within(overlay).getByText("Silhouette pipeline")).toBeInTheDocument();
    expect(within(overlay).getByText("Linked to this chat")).toBeInTheDocument();
    // The names the 192px drawing cannot carry, carried in text.
    expect(within(overlay).getByText(/1\. Prepare counts — agent$/)).toBeInTheDocument();
    expect(within(overlay).getByText(/2\. Analyze clusters — agent, terminal$/)).toBeInTheDocument();
    // The counts, as text, with the revision the read returned.
    expect(within(overlay).getByText("2 nodes · 1 edge · rev 3")).toBeInTheDocument();
  });

  it("labels a project-recent preview differently, so provenance is never conflated", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        link: { state: null },
        list: {
          workflows: [
            { id: "chat-e2e-workflow", revision: 3, createdAt: 1, updatedAt: 9, graphSha256: "s", schemaVersion: "1.0", name: "Silhouette pipeline", description: null, nodeCount: 2, edgeCount: 1 },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));
    await user.hover(trigger());
    expect(screen.getByText("Most recent in this project")).toBeInTheDocument();
  });

  it("renders a designed empty state rather than a stub graph", async () => {
    vi.stubGlobal("fetch", routeFetch({ link: { state: null }, list: { workflows: [] } }));
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("—"));
    await user.hover(trigger());
    const overlay = screen.getByRole("dialog", { name: "Pipeline preview" });
    expect(within(overlay).getByText(NO_PIPELINE_REASON)).toBeInTheDocument();
  });

  it("survives #62 — a malformed-but-200 list body degrades, it does not throw in render", async () => {
    vi.stubGlobal("fetch", routeFetch({ link: { state: null }, list: { notWorkflows: true } }));
    const user = userEvent.setup();
    renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("—"));
    await user.hover(trigger());
    const overlay = screen.getByRole("dialog", { name: "Pipeline preview" });
    const message = within(overlay).getByText(PIPELINE_READ_ERROR);
    expect(message).toBeInTheDocument();
    expect(message.textContent ?? "").not.toMatch(/\//);
  });
});

describe("ChatSideRail — §6.5, no motion at all", () => {
  it("adds no transition or animation class in either media state", async () => {
    const user = userEvent.setup();
    const { container } = renderRail();
    await waitFor(() => expect(trigger()).toHaveTextContent("2"));
    await user.hover(trigger());

    for (const element of container.querySelectorAll("*")) {
      const classes = element.getAttribute("class") ?? "";
      expect(classes).not.toMatch(/\b(transition|animate-|duration-|ease-)/);
    }
  });

  it("does not poll while its tab is hidden", async () => {
    const fetchSpy = routeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ChatSideRail projectId="default" sessionId="session-a" enabled={false} />);
    await waitFor(() => expect(trigger()).toHaveTextContent("—"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
