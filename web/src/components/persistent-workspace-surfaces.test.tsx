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

  it("resolves min-width:0 / max-width:100% on the surface through the cascade, not just its class string", () => {
    // The `toContain` assertions above would still pass if a utility were
    // misspelled into a class Tailwind never emits, because the vitest env
    // loads no Tailwind build. This injects the CSS Tailwind generates for
    // `min-w-0` / `max-w-full` — written independently of the className under
    // test — and reads it back through getComputedStyle, so a typo'd class
    // stops matching and the test fails.
    //
    // Scope, honestly: this is a cascade assertion, not a geometry one — jsdom
    // has no layout, so widths themselves have no meaning here. And it can only
    // cover the plain utilities: jsdom's selector engine does not match the
    // escaped arbitrary-variant selector Tailwind emits for `[&>*]:min-w-0`
    // (`.\[\&\>\*\]\:min-w-0 > *` parses into the sheet but matches nothing),
    // so those two stay class-string assertions. The layout proof for all four
    // is Playwright-only: e2e/workspace.spec.ts "workspace surfaces never
    // scroll the document sideways".
    const style = document.createElement("style");
    style.textContent = [
      ".min-w-0 { min-width: 0px; }",
      ".max-w-full { max-width: 100%; }",
    ].join("\n");
    document.head.append(style);
    try {
      render(<SurfaceHarness />);
      fireEvent.click(screen.getByRole("button", { name: "Builder" }));

      const visibleSurface = document.querySelector(
        '[data-workspace-surface="dag-builder"]',
      ) as HTMLElement;
      expect(visibleSurface).not.toBeNull();
      expect(window.getComputedStyle(visibleSurface).minWidth).toBe("0px");
      expect(window.getComputedStyle(visibleSurface).maxWidth).toBe("100%");
    } finally {
      style.remove();
    }
  });
});

const fetchSpy = vi.fn(async () =>
  new Response(JSON.stringify({ healthy: true }), { status: 200 }),
);

describe("Raindrop Workshop hermeticity", () => {
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
  // coverage lives with the workspace-surface tests that own the same pane
  // rather than going uncovered.
  //
  // This asserts the state a user can actually reach. The embed itself has no
  // "not configured" branch to test: with no URL the surface never probes,
  // never offers the toggle and never mounts the embed, so a branch inside the
  // embed would have been unreachable code claiming to be a safety net.
  it("shows no Workshop toggle, frames nothing and probes nothing when the URL is unset", async () => {
    vi.doMock("@/lib/embed-config", () => ({
      PIPELINE_ENGINE_URL: "http://127.0.0.1:13091",
      RAINDROP_URL: undefined,
    }));
    const { RaindropSurface } = await import("./raindrop-surface");

    render(<RaindropSurface nativePanel={<div>Session traces</div>} />);

    await waitFor(() => expect(screen.getByText("Session traces")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Workshop" })).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("embeds only the explicitly configured Workshop origin", async () => {
    const { RaindropWorkshopPanel } = await import("./raindrop-workshop-panel");

    render(<RaindropWorkshopPanel url="http://127.0.0.1:15899" />);

    // The health probe runs for a configured Workshop, which also proves the
    // unset case above skipped it rather than never mounting.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });
});
