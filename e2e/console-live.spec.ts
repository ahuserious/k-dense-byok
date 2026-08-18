import { expect, selectWorkspaceTab, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

// Lane W4 round 1: the Console's live-graph surface, session half.
//
// The shared mocked tier answers GET /sessions/session-e2e/run/state with
// `{status:"none"}` (fixtures.ts), which is the right default for every other
// spec. These items need a session that is actually mid-run, so they install a
// narrower route mock INSIDE the spec — later page.route() registrations win in
// Playwright, and fixtures.ts stays untouched.

const SESSION_ID = "session-e2e";
const RUN_STATE_PATH = `**/sessions/${SESSION_ID}/run/state`;

type RunFrame = { seq: number; type: string } & Record<string, unknown>;

const STARTED_FRAMES: RunFrame[] = [
  { seq: 1, type: "run_start", runId: "run-e2e" },
  { seq: 2, type: "turn_start" },
  { seq: 3, type: "message_start", role: "user", content: "Cluster the RNA-seq counts." },
  { seq: 4, type: "text_delta", delta: "Inspecting the matrix." },
  {
    seq: 5,
    type: "tool_start",
    toolCallId: "call_a1",
    toolName: "bash",
    args: { command: "head -3 counts.tsv" },
  },
];

const FINISHED_FRAMES: RunFrame[] = [
  ...STARTED_FRAMES,
  {
    seq: 6,
    type: "tool_end",
    toolCallId: "call_a1",
    toolName: "bash",
    isError: false,
    result: "gene\ts1\ts2",
  },
  {
    seq: 7,
    type: "tool_start",
    toolCallId: "call_a2",
    toolName: "subagent",
    args: { agent: "statistical-reviewer", task: "Check the clustering choice." },
  },
  {
    seq: 8,
    type: "tool_end",
    toolCallId: "call_a2",
    toolName: "subagent",
    isError: false,
    result: "k=4 is defensible.",
  },
  { seq: 9, type: "turn_end" },
  { seq: 10, type: "done" },
];

function runStateBody(status: "running" | "complete", frames: RunFrame[]) {
  return {
    status,
    run: {
      runId: "run-e2e",
      prompt: "Cluster the RNA-seq counts.",
      images: [],
      baseline: { messages: [], contextUsage: null },
      frames,
      lastSeq: frames.at(-1)?.seq ?? 0,
    },
  };
}

/** Serve the session's retained run buffer, switchable mid-test. */
async function mockRunState(page: Page, state: { body: unknown }) {
  await page.route(RUN_STATE_PATH, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(state.body),
    });
  });
}

async function openLiveConsole(page: Page) {
  await selectWorkspaceTab(page, "Console");
  const rail = page.getByRole("complementary", { name: "Live work" });
  await expect(rail).toBeVisible();
  return rail;
}

test.describe("w4-console-sessions", () => {
  test("the rail lists the running typed run and the open chat session", async ({
    workspacePage,
  }) => {
    const rail = await openLiveConsole(workspacePage);

    // (a) the queued/running typed run, and (d) the session GET /sessions
    // reports as touched inside the 30-minute window.
    await expect(rail.getByRole("button", { name: /e2e-workflow/ })).toBeVisible();
    await expect(rail.getByRole("button", { name: /E2E chat/ })).toBeVisible();
    await expect(rail.getByRole("region", { name: "DAG runs" })).toBeVisible();
    await expect(rail.getByRole("region", { name: "Sessions" })).toBeVisible();

    // The authoritative typed run console stays the surface's default main area.
    await expect(workspacePage.getByLabel("Workflow runs")).toBeVisible();
  });

  test("selecting the session shows its root, turn, and tool nodes", async ({
    workspacePage,
  }) => {
    const state = { body: runStateBody("running", STARTED_FRAMES) };
    await mockRunState(workspacePage, state);

    const rail = await openLiveConsole(workspacePage);
    await rail.getByRole("button", { name: /E2E chat/ }).click();

    const graph = workspacePage.getByRole("region", { name: "Session live graph" });
    await expect(graph).toBeVisible();
    await expect(graph.locator(`[data-node-id="session:${SESSION_ID}"]`)).toBeVisible();
    await expect(graph.locator('[data-node-id="turn:1"]')).toBeVisible();
    await expect(graph.locator('[data-node-id="tool:call_a1"]')).toHaveAttribute(
      "data-node-status",
      "running",
    );
    await expect(graph.locator('[data-node-id="tool:call_a1"]')).toContainText("bash");
  });

  test("node status advances as the run's frames arrive", async ({ workspacePage }) => {
    const state = { body: runStateBody("running", STARTED_FRAMES) };
    await mockRunState(workspacePage, state);

    const rail = await openLiveConsole(workspacePage);
    await rail.getByRole("button", { name: /E2E chat/ }).click();

    const graph = workspacePage.getByRole("region", { name: "Session live graph" });
    await expect(graph.locator('[data-node-id="tool:call_a1"]')).toHaveAttribute(
      "data-node-status",
      "running",
    );

    state.body = runStateBody("complete", FINISHED_FRAMES);

    await expect(graph.locator('[data-node-id="tool:call_a1"]')).toHaveAttribute(
      "data-node-status",
      "ok",
    );
    // The delegation arrives as a subagent node, not an opaque tool row.
    await expect(
      graph.locator('[data-node-id="agent:call_a2:statistical-reviewer"]'),
    ).toBeVisible();
    await expect(graph.locator(`[data-node-id="session:${SESSION_ID}"]`)).toHaveAttribute(
      "data-node-status",
      "ok",
    );
  });

  test("the drawer lists the events behind the selected node", async ({ workspacePage }) => {
    const state = { body: runStateBody("complete", FINISHED_FRAMES) };
    await mockRunState(workspacePage, state);

    const rail = await openLiveConsole(workspacePage);
    await rail.getByRole("button", { name: /E2E chat/ }).click();

    const graph = workspacePage.getByRole("region", { name: "Session live graph" });
    await graph.locator('[data-node-id="turn:1"]').click();

    const drawer = workspacePage.getByRole("complementary", { name: "Event drawer" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("Ordered events")).toContainText("tool.ok");
  });

  test("a DAG run says the run graph waits on the typed snapshot", async ({
    workspacePage,
  }) => {
    const rail = await openLiveConsole(workspacePage);
    await rail.getByRole("button", { name: /e2e-workflow/ }).click();

    const main = workspacePage.getByRole("region", { name: "DAG run graph" });
    await expect(main).toContainText(/run graph lands with the typed run-document snapshot/i);

    // Its persisted events are already real, and Workflow Rescue is reachable.
    const drawer = workspacePage.getByRole("complementary", { name: "Event drawer" });
    await expect(drawer.getByLabel("Ordered events")).toContainText("node_started");
    await expect(drawer.getByRole("button", { name: "Workflow Rescue" })).toBeVisible();
  });
});

test.describe("w4-console-empty", () => {
  test("names the reason when nothing is running instead of spinning", async ({
    workspacePage,
  }) => {
    // Narrower mocks than the shared tier: no runs, no sessions. Registered
    // after fixtures.ts so these win, and only for this item.
    await workspacePage.route(
      (url) => url.pathname === "/dag-workflow-runs",
      async (route: Route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ runs: [] }),
        });
      },
    );
    await workspacePage.route(
      (url) => url.pathname === "/sessions",
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: "[]",
        });
      },
    );

    const rail = await openLiveConsole(workspacePage);
    await expect(rail).toContainText(/no queued or running DAG workflow runs/i);
    await expect(rail).toContainText(/last 30 minutes/i);
    // Neither section renders at all while the union is empty, so the reason is
    // the only thing on screen — no bare spinner, no empty list to squint at.
    await expect(rail.getByRole("region", { name: "DAG runs" })).toHaveCount(0);
    await expect(rail.getByRole("region", { name: "Sessions" })).toHaveCount(0);
  });
});
