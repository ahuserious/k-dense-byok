import {
  RAINDROP_ANALYST_QUESTION,
  RAINDROP_ANALYST_RESPONSE,
  REFRESHED_WORKFLOW_RUN_ID,
  RESCUE_WORKFLOW_RUN_ID,
  WORKFLOW_RUN_ID,
  expect,
  lastRequestPostData,
  requestCount,
  selectWorkspaceTab,
  test,
  type MockApiState,
  type RunStatus,
} from "./fixtures";

async function openConsoleForStatus(
  page: Parameters<typeof selectWorkspaceTab>[0],
  apiState: MockApiState,
  status: RunStatus,
) {
  apiState.runStatus = status;
  await selectWorkspaceTab(page, "Console");
  const workflowRuns = page.getByLabel("Workflow runs");
  await expect(workflowRuns).toBeVisible();
  await expect(workflowRuns.getByRole("button").first()).toContainText("e2e-workflow");
  await expect.poll(() => requestCount(apiState, "GET", `/dag-workflow-runs/${WORKFLOW_RUN_ID}`))
    .toBeGreaterThan(0);
  await expect.poll(() => requestCount(apiState, "GET", `/dag-workflow-runs/${WORKFLOW_RUN_ID}/budget`))
    .toBeGreaterThan(0);
  await expect.poll(() => requestCount(apiState, "GET", `/dag-workflow-runs/${WORKFLOW_RUN_ID}/events`))
    .toBeGreaterThan(0);
  return workflowRuns;
}

function statusLabel(status: RunStatus) {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

const RUN_CONTROL_ACTIONS = ["cancel", "resume", "rescue"] as const;

function runControlPath(action: typeof RUN_CONTROL_ACTIONS[number]) {
  return `/dag-workflow-runs/${WORKFLOW_RUN_ID}/${action}`;
}

async function expectOnlyControlPost(
  apiState: MockApiState,
  expectedAction: typeof RUN_CONTROL_ACTIONS[number],
) {
  await expect.poll(() => requestCount(apiState, "POST", runControlPath(expectedAction))).toBe(1);
  for (const action of RUN_CONTROL_ACTIONS) {
    expect(requestCount(apiState, "POST", runControlPath(action))).toBe(
      action === expectedAction ? 1 : 0,
    );
  }
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

  test("run_started renders before node_started in API event order", async ({ workspacePage, apiState }) => {
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
    await expectOnlyControlPost(apiState, "cancel");
    await expect(workspacePage.getByRole("status")).toHaveText(
      `Cancel requested for ${WORKFLOW_RUN_ID}; current status is cancelled.`,
    );
  });

  test("Resume invokes the runner control", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "interrupted");
    await workspacePage.getByRole("button", { name: "Resume" }).click();
    await expectOnlyControlPost(apiState, "resume");
    await expect(workspacePage.getByRole("status")).toHaveText(
      `Resume requested for ${WORKFLOW_RUN_ID}; current status is running.`,
    );
  });

  test("failed run exposes proposal-only Rescue", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "failed");
    await workspacePage.getByRole("button", { name: "Rescue as new run" }).click();
    await expectOnlyControlPost(apiState, "rescue");
    const rescueBody = JSON.parse(
      lastRequestPostData(apiState, "POST", runControlPath("rescue")) ?? "null",
    ) as unknown;
    expect(rescueBody).toEqual({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    await expect(workspacePage.getByRole("status")).toHaveText(
      `Created rescue run ${RESCUE_WORKFLOW_RUN_ID} with status queued.`,
    );
    await expect(workspacePage.getByText(RESCUE_WORKFLOW_RUN_ID, { exact: true }).first()).toBeVisible();
  });

  test("failed run surfaces its API error", async ({ workspacePage, apiState }) => {
    const workflowRuns = await openConsoleForStatus(workspacePage, apiState, "failed");
    await expect(workflowRuns.getByRole("button").first()).toContainText("E2E_FAILURE: simulated failure");
  });

  test("Agents & Loops feed is selectable", async ({ workspacePage, apiState }) => {
    await selectWorkspaceTab(workspacePage, "Console");
    await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
    await expect(workspacePage.getByRole("button", { name: "Agents & Loops" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => requestCount(apiState, "GET", "/console/runs")).toBeGreaterThan(0);
    await expect.poll(() => requestCount(apiState, "GET", "/console/loops")).toBeGreaterThan(0);
  });

  test("agent feed shows a native Kady agent run", async ({ workspacePage, apiState }) => {
    await selectWorkspaceTab(workspacePage, "Console");
    await workspacePage.getByRole("button", { name: "Agents & Loops" }).click();
    const agentRow = workspacePage.getByRole("row").filter({ hasText: "E2E analysis" });
    await expect(agentRow).toHaveCount(1);
    await expect(agentRow.getByText("agent", { exact: true })).toBeVisible();
    await expect.poll(() => requestCount(apiState, "GET", "/console/runs")).toBeGreaterThan(0);
  });

});

test.describe("thin Console inventory smoke — excluded from the substantive count", () => {
  test("workflow run list is accessible", async ({ workspacePage, apiState }) => {
    await openConsoleForStatus(workspacePage, apiState, "running");
    await expect(workspacePage.getByLabel("Workflow runs")).toContainText("e2e-workflow");
  });

  test("event stream region is accessible", async ({ workspacePage, apiState }) => {
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

test.describe("Raindrop log interactions", () => {
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

  test("session selection validates the session-specific bounded projection", async ({
    workspacePage,
    apiState,
  }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    const run = workspacePage.getByTitle(WORKFLOW_RUN_ID);
    const runContextRequestsBefore = requestCount(
      apiState,
      "POST",
      "/helper-sessions/raindrop/context",
    );
    await run.click();
    await expect(run).toHaveAttribute("aria-current", "true");
    await expect.poll(() => requestCount(apiState, "POST", "/helper-sessions/raindrop/context"))
      .toBeGreaterThan(runContextRequestsBefore);

    const session = workspacePage.getByTitle("session-e2e");
    const contextRequestsBefore = requestCount(apiState, "POST", "/helper-sessions/raindrop/context");
    await session.click();
    await expect(session).toHaveAttribute("aria-current", "true");
    await expect(session).toContainText("E2E chat");
    await expect(session).toContainText("session-e2e");
    await expect(session).toContainText("2 msgs");
    await expect.poll(() => requestCount(apiState, "POST", "/helper-sessions/raindrop/context"))
      .toBeGreaterThan(contextRequestsBefore);
    expect(JSON.parse(
      lastRequestPostData(apiState, "POST", "/helper-sessions/raindrop/context") ?? "null",
    )).toEqual({ kind: "session", id: "session-e2e" });
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
    // This used to compare the Send button's rectangle against the "Components
    // studio" launcher pill's. That pill was retired in lane W1 round 2 (owner:
    // "there should be no components studio"), so one of the two rectangles no
    // longer exists and the old assertion could only fail. What it was actually
    // protecting is kept, and widened past any single pill: the retired
    // launcher must stay gone, and no floating workspace chrome may sit on top
    // of the analyst's Send button — pinned by asking the browser what it would
    // actually hit at the button's own centre, which catches an overlay from
    // any source rather than only the one that used to be there.
    await expect(
      workspacePage.getByRole("button", { name: "Components studio" }),
    ).toHaveCount(0);
    await send.scrollIntoViewIfNeeded();
    const sendReceivesItsOwnCentreClick = await send.evaluate((sendButton) => {
      const rect = sendButton.getBoundingClientRect();
      const topmostElementAtCentre = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return topmostElementAtCentre !== null && sendButton.contains(topmostElementAtCentre);
    });
    expect(sendReceivesItsOwnCentreClick).toBe(true);
    await send.click();
    await expect(analyst.getByText(RAINDROP_ANALYST_QUESTION, { exact: true })).toBeVisible();
    await expect(analyst.getByText(RAINDROP_ANALYST_RESPONSE, { exact: true })).toBeVisible();
  });
});

test.describe("thin inventory smoke — excluded from the substantive count", () => {
  test("Raindrop labels its log and no-tools analyst surfaces", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Raindrop");
    await expect(workspacePage.getByRole("heading", { name: "Raindrop" })).toBeVisible();
    await expect(workspacePage.getByText(/Autosaved DAG runs and chat sessions/)).toBeVisible();
    await expect(workspacePage.getByLabel("Autosaved Raindrop logs")).toBeVisible();
    await expect(workspacePage.getByText(/separate no-tools Pi log analyst/)).toBeVisible();
  });
});
