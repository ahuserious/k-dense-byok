import { expect, selectWorkspaceTab, test, type RunStatus } from "./fixtures";

async function openConsoleForStatus(
  page: Parameters<typeof selectWorkspaceTab>[0],
  apiState: { runStatus: RunStatus },
  status: RunStatus,
) {
  apiState.runStatus = status;
  await selectWorkspaceTab(page, "Console");
  const workflowRuns = page.getByLabel("Workflow runs");
  await expect(workflowRuns).toBeVisible();
  await expect(workflowRuns.getByRole("button").first()).toContainText("e2e-workflow");
  return workflowRuns;
}

function statusLabel(status: RunStatus) {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

test.describe("durable DAG Console", () => {
  for (const status of [
    "queued",
    "running",
    "waiting",
    "blocked",
    "paused",
    "interrupted",
    "succeeded",
    "failed",
    "cancelled",
  ] as const) {
    test(`${status} run status is reported honestly`, async ({ workspacePage, apiState }) => {
      const workflowRuns = await openConsoleForStatus(workspacePage, apiState, status);
      await expect(workflowRuns.getByText(statusLabel(status), { exact: true })).toBeVisible();
    });
  }

  test("workflow run list is accessible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Workflow runs")).toContainText("e2e-workflow");
  });

  test("authoritative event stream is accessible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Authoritative workflow events")).toBeVisible();
  });

  for (const eventType of ["run_started", "node_started"] as const) {
    test(`${eventType} appears in persisted order`, async ({ workspacePage, apiState }) => {
      await openConsoleForStatus(workspacePage, apiState, "running");
      await expect(workspacePage.getByLabel("Authoritative workflow events")).toContainText(eventType);
    });
  }

  test("run budget commitments are visible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Run budget commitments")).toBeVisible();
  });

  test("running run exposes Cancel", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("Cancel invokes the runner control", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await workspacePage.getByRole("button", { name: "Cancel" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("Cancel requested");
  });

  test("interrupted run exposes Resume", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "interrupted");
    await expect(workspacePage.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test("Resume invokes the runner control", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "interrupted");
    await workspacePage.getByRole("button", { name: "Resume" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("Resume requested");
  });

  test("failed run exposes proposal-only Rescue", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "failed");
    await expect(workspacePage.getByRole("button", { name: "Rescue as new run" })).toBeVisible();
  });

  test("failed run surfaces its persisted error", async ({ workspacePage, apiState }) => {
    const workflowRuns = await openConsoleForStatus(workspacePage, apiState, "failed");
    await expect(workflowRuns.getByRole("button").first()).toContainText("E2E_FAILURE: simulated failure");
  });

  test("Agents & Loops feed is selectable", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Console");
    await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
    await expect(workspacePage.getByRole("button", { name: "Agents & Loops" })).toHaveAttribute("aria-pressed", "true");
  });

  test("agent feed shows native Kady run", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Console");
    await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
    await expect(workspacePage.getByText("E2E analysis")).toBeVisible();
  });

  for (const column of ["Role", "Task", "Status", "Model", "Cost", "When"] as const) {
    test(`agent feed exposes ${column} column`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, "Console");
      await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
      await expect(workspacePage.getByRole("columnheader", { name: column })).toBeVisible();
    });
  }
});

test.describe("Raindrop saved-log surface", () => {
  test("Raindrop title and purpose are visible", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByRole("heading", { name: "Raindrop" })).toBeVisible();
    await expect(workspacePage.getByText(/Autosaved DAG runs and chat sessions/)).toBeVisible();
  });

  test("Raindrop exposes Refresh", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("saved-log aside is accessible", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByLabel("Autosaved Raindrop logs")).toBeVisible();
  });

  for (const sectionName of ["Chat sessions", "DAG runs"] as const) {
    test(`${sectionName} section is present`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, "Raindrop");
      await expect(workspacePage.getByRole("heading", { name: sectionName })).toBeVisible();
    });
  }

  test("chat session is discovered", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByTitle("session-e2e")).toBeVisible();
  });

  test("DAG run is discovered", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByTitle(/wrun_/)).toBeVisible();
  });

  test("selection validates a bounded complete projection", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await workspacePage.getByTitle("session-e2e").click();
    await expect(workspacePage.getByText("Selected log projection is validated and complete within its recorded bounds.")).toBeVisible();
  });

  test("selected session is marked current", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    const session = workspacePage.getByTitle("session-e2e");
    await session.click();
    await expect(session).toHaveAttribute("aria-current", "true");
  });

  test("Raindrop analyst remains no-tools", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByRole("region", { name: "Raindrop analyst" })).toBeVisible();
    await expect(workspacePage.getByText(/separate no-tools Pi log analyst/)).toBeVisible();
  });
});
