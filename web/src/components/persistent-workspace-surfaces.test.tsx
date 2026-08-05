import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

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
      <button type="button" onClick={() => setActiveView("dag-builder")}>DAG Builder</button>
      <button type="button" onClick={() => setActiveView("console")}>Console</button>
      <PersistentWorkspaceSurfaces
        activeView={activeView}
        mountedViews={mountedViews}
        surfaces={{
          workflows: <div>Workflows</div>,
          "dag-workflows": <div>DAG Workflows</div>,
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

    fireEvent.click(screen.getByRole("button", { name: "DAG Builder" }));
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
    fireEvent.click(screen.getByRole("button", { name: "DAG Builder" }));
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
});
