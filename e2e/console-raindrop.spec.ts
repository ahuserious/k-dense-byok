import {
  RAINDROP_ANALYST_QUESTION,
  RAINDROP_ANALYST_RESPONSE,
  REFRESHED_WORKFLOW_RUN_ID,
  WORKFLOW_RUN_ID,
  expect,
  selectWorkspaceTab,
  test,
  type RunStatus,
} from "./fixtures";

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

  test("run_started renders before node_started in persisted order", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    const eventRows = workspacePage.getByLabel("Authoritative workflow events").locator("ol > li");
    const renderedEvents = await eventRows.allTextContents();
    const runStartedIndex = renderedEvents.findIndex((row) => row.includes("run_started"));
    const nodeStartedIndex = renderedEvents.findIndex((row) => row.includes("node_started"));
    expect(runStartedIndex).toBeGreaterThanOrEqual(0);
    expect(nodeStartedIndex).toBeGreaterThan(runStartedIndex);
    expect(renderedEvents[runStartedIndex]).toContain("#1");
    expect(renderedEvents[nodeStartedIndex]).toContain("#2");
  });

  test("Cancel invokes the runner control", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await workspacePage.getByRole("button", { name: "Cancel" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("Cancel requested");
  });

  test("Resume invokes the runner control", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "interrupted");
    await workspacePage.getByRole("button", { name: "Resume" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("Resume requested");
  });

  test("failed run exposes proposal-only Rescue", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "failed");
    await workspacePage.getByRole("button", { name: "Rescue as new run" }).click();
    await expect(workspacePage.getByRole("status")).toHaveText(
      `Created rescue run ${WORKFLOW_RUN_ID} with status running.`,
    );
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

});

test.describe("thin Console inventory smoke — excluded from the substantive count", () => {
  test("workflow run list is accessible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Workflow runs")).toContainText("e2e-workflow");
  });

  test("authoritative event stream is accessible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Authoritative workflow events")).toBeVisible();
  });

  test("run budget commitments are visible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Run budget commitments")).toBeVisible();
  });

  test("running run exposes Cancel", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("interrupted run exposes Resume", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "interrupted");
    await expect(workspacePage.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  for (const column of ["Role", "Task", "Status", "Model", "Cost", "When"] as const) {
    test(`agent feed exposes ${column} column`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, "Console");
      await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
      await expect(workspacePage.getByRole("columnheader", { name: column })).toBeVisible();
    });
  }

  test("Console contains no retired Telegram origin label", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Console");
    await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
    const consoleTable = workspacePage.getByRole("table");
    await expect(consoleTable).toBeVisible();
    await expect(consoleTable).not.toContainText("Telegram");
  });
});

test.describe("Raindrop saved-log interactions", () => {
  test("Refresh reloads the feed and reveals a newly discovered run", async ({ workspacePage, apiState }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByTitle(REFRESHED_WORKFLOW_RUN_ID)).toHaveCount(0);
    const refresh = workspacePage.getByRole("button", { name: "Refresh" });
    await expect(refresh).toBeEnabled();
    const requestsBeforeRefresh = apiState.runListRequests;
    apiState.showRefreshedRun = true;
    await refresh.click();
    await expect.poll(() => apiState.runListRequests).toBeGreaterThan(requestsBeforeRefresh);
    await expect(workspacePage.getByTitle(REFRESHED_WORKFLOW_RUN_ID)).toBeVisible();
    await expect(workspacePage.getByLabel("Autosaved Raindrop logs")).toContainText("2 DAG runs");
  });

  test("selecting the DAG run marks it current and exposes its exact record", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    const run = workspacePage.getByTitle(WORKFLOW_RUN_ID);
    await run.click();
    await expect(run).toHaveAttribute("aria-current", "true");
    await expect(run).toContainText("e2e-workflow");
    await expect(run).toContainText("running");
    await expect(workspacePage.getByText(
      "Selected log projection is validated and complete within its recorded bounds.",
    )).toBeVisible();
  });

  test("session selection validates the session-specific bounded projection", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    const session = workspacePage.getByTitle("session-e2e");
    await session.click();
    await expect(session).toHaveAttribute("aria-current", "true");
    await expect(workspacePage.getByText(
      "Selected log projection is validated and complete within its recorded bounds.",
    )).toBeVisible();
  });

  test("Raindrop analyst answers from the selected run binding", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await workspacePage.getByTitle(WORKFLOW_RUN_ID).click();
    const analyst = workspacePage.getByRole("region", { name: "Raindrop analyst" });
    const composer = analyst.getByRole("textbox", { name: "Message Raindrop analyst" });
    await expect(composer).toBeEnabled();
    await composer.fill(RAINDROP_ANALYST_QUESTION);
    const send = analyst.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    const launcher = workspacePage.getByRole("button", { name: "Components studio" });
    const [launcherRect, sendRect] = await Promise.all([
      launcher.boundingBox(),
      send.boundingBox(),
    ]);
    expect(launcherRect).not.toBeNull();
    expect(sendRect).not.toBeNull();
    expect(
      launcherRect!.x + launcherRect!.width <= sendRect!.x ||
      sendRect!.x + sendRect!.width <= launcherRect!.x ||
      launcherRect!.y + launcherRect!.height <= sendRect!.y ||
      sendRect!.y + sendRect!.height <= launcherRect!.y,
    ).toBe(true);
    await send.click();
    await expect(analyst.getByText(RAINDROP_ANALYST_QUESTION, { exact: true })).toBeVisible();
    await expect(analyst.getByText(RAINDROP_ANALYST_RESPONSE, { exact: true })).toBeVisible();
  });
});

test.describe("thin inventory smoke — excluded from the substantive count", () => {
  test("Raindrop labels its saved-log and no-tools analyst surfaces", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByRole("heading", { name: "Raindrop" })).toBeVisible();
    await expect(workspacePage.getByText(/Autosaved DAG runs and chat sessions/)).toBeVisible();
    await expect(workspacePage.getByLabel("Autosaved Raindrop logs")).toBeVisible();
    await expect(workspacePage.getByText(/separate no-tools Pi log analyst/)).toBeVisible();
  });
});
