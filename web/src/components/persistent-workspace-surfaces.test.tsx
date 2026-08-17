import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PersistentWorkspaceSurfaces,
  usePersistentWorkspaceView,
} from "./persistent-workspace-surfaces";

function StatefulBuilderSurface() {
  const [instanceId] = useState(() => crypto.randomUUID());
  const [draftName, setDraftName] = useState("");
  return (
    <div>
      <span data-testid="builder-instance">{instanceId}</span>
      <label>
        Draft name
        <input
          aria-label="Draft name"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
        />
      </label>
    </div>
  );
}

function StatefulConsoleSurface() {
  const [instanceId] = useState(() => crypto.randomUUID());
  const [selectedRun, setSelectedRun] = useState("run-a");
  return (
    <div>
      <span data-testid="console-instance">{instanceId}</span>
      <label>
        Selected run
        <select
          aria-label="Selected run"
          value={selectedRun}
          onChange={(event) => setSelectedRun(event.target.value)}
        >
          <option value="run-a">Run A</option>
          <option value="run-b">Run B</option>
        </select>
      </label>
    </div>
  );
}

function SurfaceHarness() {
  const {
    activeView,
    mountedViews,
    setActiveView,
  } = usePersistentWorkspaceView("chat");
  return (
    <>
      <button type="button" onClick={() => setActiveView("chat")}>Chat</button>
      <button type="button" onClick={() => setActiveView("dag-builder")}>Builder</button>
      <button type="button" onClick={() => setActiveView("console")}>Console</button>
      <PersistentWorkspaceSurfaces
        activeView={activeView}
        mountedViews={mountedViews}
        surfaces={{
          workflows: <div>Workflows</div>,
          "scientific-pipelines": <div>Scientific Pipelines</div>,
          "dag-builder": <StatefulBuilderSurface />,
          console: <StatefulConsoleSurface />,
          raindrop: <div>Raindrop</div>,
        }}
      />
    </>
  );
}

describe("PersistentWorkspaceSurfaces", () => {
  it("lazily mounts Builder and Console once and preserves their local state", () => {
    render(<SurfaceHarness />);

    expect(screen.queryByTestId("builder-instance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("console-instance")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Builder" }));
    const builderInstance = screen.getByTestId("builder-instance").textContent;
    fireEvent.change(screen.getByLabelText("Draft name"), {
      target: { value: "Unsaved fusion draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    const consoleInstance = screen.getByTestId("console-instance").textContent;
    fireEvent.change(screen.getByLabelText("Selected run"), {
      target: { value: "run-b" },
    });

    const hiddenBuilder = document.querySelector(
      '[data-workspace-surface="dag-builder"]',
    );
    expect(hiddenBuilder).toHaveAttribute("aria-hidden", "true");
    expect(within(hiddenBuilder as HTMLElement).getByLabelText("Draft name"))
      .toHaveValue("Unsaved fusion draft");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Builder" }));
    expect(screen.getByTestId("builder-instance")).toHaveTextContent(
      builderInstance ?? "",
    );
    expect(screen.getByLabelText("Draft name")).toHaveValue(
      "Unsaved fusion draft",
    );

    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(screen.getByTestId("console-instance")).toHaveTextContent(
      consoleInstance ?? "",
    );
    expect(screen.getByLabelText("Selected run")).toHaveValue("run-b");
  });

  it("constrains the visible surface and its child so content cannot widen the pane", () => {
    render(<SurfaceHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Builder" }));

    const visibleSurface = document.querySelector(
      '[data-workspace-surface="dag-builder"]',
    );
    expect(visibleSurface).not.toBeNull();
    const className = (visibleSurface as HTMLElement).className;
    // Both are load-bearing: a flex item keeps min-width:auto, so without them
    // a wide descendant sizes the pane past the viewport and this wrapper's
    // overflow-hidden clips every right-aligned control with no scroller.
    expect(className).toContain("min-w-0");
    expect(className).toContain("max-w-full");
    expect(className).toContain("[&>*]:min-w-0");
    expect(className).toContain("[&>*]:max-w-full");
    expect(className).toContain("overflow-hidden");
  });
});

const fetchSpy = vi.fn(async () =>
  new Response(JSON.stringify({ healthy: true }), { status: 200 }),
);

describe("RaindropWorkshopPanel hermeticity", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/embed-config");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Lane V1's file inventory carries no raindrop-*.test.tsx, so the Workshop's
  // unconfigured-embed coverage lives with the workspace-surface tests that own
  // the same pane rather than going uncovered.
  it("states that the Workshop is unconfigured and frames nothing when the URL is unset", async () => {
    vi.doMock("@/lib/embed-config", () => ({
      PIPELINE_ENGINE_URL: "http://127.0.0.1:13091",
      RAINDROP_URL: undefined,
    }));
    const { RaindropWorkshopPanel } = await import("./raindrop-workshop-panel");

    render(<RaindropWorkshopPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Raindrop Workshop is not configured (set NEXT_PUBLIC_RAINDROP_URL)",
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("embeds only the explicitly configured Workshop origin", async () => {
    vi.doMock("@/lib/embed-config", () => ({
      PIPELINE_ENGINE_URL: "http://127.0.0.1:13091",
      RAINDROP_URL: "http://127.0.0.1:15899",
    }));
    const { RaindropWorkshopPanel } = await import("./raindrop-workshop-panel");

    render(<RaindropWorkshopPanel />);

    expect(screen.queryByTestId("raindrop-workshop-unconfigured")).toBeNull();
    // The health probe only runs for a configured Workshop, which also proves
    // the unconfigured case above skipped it rather than never mounting.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });
});
