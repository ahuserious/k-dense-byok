import { expect, selectWorkspaceTab, test, WORKFLOW_RUN_ID } from "./fixtures";
import type { Page, Route } from "@playwright/test";

// Lane W4: the Console's live-graph surface, session half.
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

    // The typed workflow this session delegated to is a node in its own graph
    // (GET /sessions/:id/workflow-run-state), hanging off the session root.
    await expect(graph.locator(`[data-node-id="dag:${WORKFLOW_RUN_ID}"]`)).toHaveAttribute(
      "data-node-kind",
      "dag",
    );

    // Clicking it swaps the main area to that run: the placeholder plus the
    // run's genuine persisted events in the drawer.
    await graph.locator(`[data-node-id="dag:${WORKFLOW_RUN_ID}"]`).click();
    const runGraph = workspacePage.getByRole("region", { name: "DAG run graph" });
    await expect(runGraph).toHaveAttribute("data-run-id", WORKFLOW_RUN_ID);
    await expect(
      workspacePage.getByRole("complementary", { name: "Event drawer" }).getByLabel(
        "Ordered events",
      ),
    ).toContainText("node_started");
  });

  test("a running session is badged running and live in the rail", async ({
    workspacePage,
  }) => {
    // The rail probes GET /sessions/:id/run/state for the sessions inside the
    // poller cap, so a chat that is mid-run says so WITHOUT being selected.
    // Round 1 hard-coded every session `idle`, which is exactly the question
    // this console exists to answer.
    const state = { body: runStateBody("running", STARTED_FRAMES) };
    await mockRunState(workspacePage, state);

    const rail = await openLiveConsole(workspacePage);
    const row = rail.getByRole("button", { name: /E2E chat/ });
    await expect(row.getByText("live")).toBeVisible();
    await expect(row.getByText("running")).toBeVisible();
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
    const events = drawer.getByLabel("Ordered events");
    // The session's REAL frames, including the ones the fold models away —
    // not the projected nodes restated back at the reader.
    await expect(events.locator('[data-event-type="message_start"]')).toBeVisible();
    await expect(events.locator('[data-event-type="text_delta"]')).toBeVisible();
    await expect(events.locator('[data-event-type="tool_end"]').first()).toBeVisible();
    await expect(events).not.toContainText("tool.ok");
    // The viewport is focusable, so a keyboard reader can reach the list.
    await expect(events).toHaveAttribute("tabindex", "0");
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

test.describe("w4-console-probe-cap", () => {
  // The rail probes at most MAX_CONCURRENT_SESSION_POLLERS (8) sessions for run
  // state. Round 2 left the 9th and later chats hard-coded `idle` — a positive
  // false statement about a chat nothing had asked about — with no chip saying
  // the rail had only looked at eight.
  const CHAT_COUNT = 12;

  test("says `not checked` for the chats past the probe cap, and states the bound", async ({
    workspacePage,
  }) => {
    const now = Date.now();
    const probed = new Set<string>();
    await workspacePage.route(
      (url) => url.pathname === "/sessions",
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify(
            Array.from({ length: CHAT_COUNT }, (_, index) => ({
              id: `capped-${index}`,
              name: `Capped chat ${index}`,
              created: now - 60_000,
              modified: now - 1_000,
            })),
          ),
        });
      },
    );
    // Every one of them is genuinely running, so anything the rail says other
    // than `running` or `not checked` is wrong.
    await workspacePage.route(/\/sessions\/capped-\d+\/run\/state$/, async (route: Route) => {
      const id = /capped-(\d+)/.exec(route.request().url())?.[0] ?? "";
      probed.add(id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          status: "running",
          run: {
            runId: `run-${id}`,
            prompt: "",
            images: [],
            baseline: { messages: [], contextUsage: null },
            frames: [{ seq: 1, type: "run_start", runId: `run-${id}` }],
            lastSeq: 1,
          },
        }),
      });
    });

    const rail = await openLiveConsole(workspacePage);
    const sessions = rail.getByRole("region", { name: "Sessions" });
    await expect(sessions.locator("[data-source-key]")).toHaveCount(CHAT_COUNT);

    // Eight watched, four never asked about.
    await expect(sessions.locator('[data-status="running"]')).toHaveCount(8);
    await expect(sessions.locator('[data-status="unknown"]')).toHaveCount(4);
    // ...and the unwatched rows do not claim to be idle.
    await expect(sessions.locator('[data-status="idle"]')).toHaveCount(0);
    await expect(sessions.locator('[data-status="unknown"]').first()).toHaveText(
      "not checked",
    );

    // The bound is stated, exactly as round 1's M5 states the project bound.
    await expect(rail).toContainText(`checking 8 of ${CHAT_COUNT} chats for live status`);
    expect(probed.size).toBe(8);
  });
});

test.describe("w4-console-promote", () => {
  // "even if not a DAG initially, the LLM's logs should be able to turn into a
  // DAG here" — the verb. The preview must be reviewable and abandonable, and
  // the write must be the typed route's real create precondition.
  async function openPromoteDialog(page: Page) {
    await mockRunState(page, { body: runStateBody("complete", FINISHED_FRAMES) });
    const rail = await openLiveConsole(page);
    await rail.getByRole("button", { name: /E2E chat/ }).click();
    const graph = page.getByRole("region", { name: "Session live graph" });
    await expect(graph).toBeVisible();
    await graph.getByRole("button", { name: "Turn into a DAG" }).click();
    const dialog = page.getByTestId("promote-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test("previews the exact document, names what it cannot represent, and writes nothing until asked", async ({
    workspacePage,
  }) => {
    let definitionWrites = 0;
    await workspacePage.route(/\/dag-workflows\/[^/]+$/, async (route: Route) => {
      if (route.request().method() === "PUT") definitionWrites += 1;
      return route.fallback();
    });

    const dialog = await openPromoteDialog(workspacePage);

    // One node per conversation turn, carrying the user's real prompt.
    await expect(dialog.locator('[data-promoted-node-id="turn-1"]')).toContainText(
      "Cluster the RNA-seq counts.",
    );
    await expect(dialog).toContainText("Will create 1 node");
    // The tool call and the subagent are named, with the reason, rather than
    // dropped without a word.
    await expect(dialog.locator('[data-unrepresented-id="tool:call_a1"]')).toContainText(
      "bash",
    );
    await expect(
      dialog.locator('[data-unrepresented-id="agent:call_a2:statistical-reviewer"]'),
    ).toContainText("statistical-reviewer");
    await expect(dialog).toContainText(/cannot become a node/i);
    // The workspace and the model are stated before anything is created.
    await expect(dialog).toContainText("read-only on every node");
    await expect(dialog).toContainText("Kady Current");

    // Abandoning it writes nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(workspacePage.getByTestId("promote-dialog")).toHaveCount(0);
    expect(definitionWrites).toBe(0);
  });

  test("creates the workflow through the typed route's own create precondition", async ({
    workspacePage,
  }) => {
    const writes: { url: string; ifNoneMatch: string | undefined; body: unknown }[] = [];
    await workspacePage.route(/\/dag-workflows\/[^/]+$/, async (route: Route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      const headers = route.request().headers();
      writes.push({
        url: route.request().url(),
        ifNoneMatch: headers["if-none-match"],
        body: JSON.parse(route.request().postData() ?? "null"),
      });
      // The create half of the CAS contract, enforced here the way the real
      // route enforces it: no `If-None-Match: *`, no create.
      if (headers["if-none-match"] !== "*") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ detail: "create requires If-None-Match: *" }),
        });
      }
      const graph = JSON.parse(route.request().postData() ?? "null");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*", ETag: '"1"' },
        body: JSON.stringify({
          outcome: "created",
          definition: {
            storageVersion: 1,
            id: graph.id,
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            graphSha256: "promoted-graph-sha256",
            graph,
          },
        }),
      });
    });

    const dialog = await openPromoteDialog(workspacePage);
    await expect(dialog.getByLabel("Workflow id")).toHaveValue(`chat-${SESSION_ID}`);
    await dialog.getByRole("button", { name: "Create workflow" }).click();

    await expect(dialog).toContainText(/The typed route accepted it/i);
    await expect(dialog).toContainText(`chat-${SESSION_ID}`);
    // It names the surface the workflow is really in. The workspace tab called
    // "Builder" is the vendored pipeline-engine iframe and cannot open a typed
    // WorkflowGraphDocument, so the banner must not send the reader there.
    await expect(dialog).toContainText("Workflow registry");
    await expect(dialog).not.toContainText(/Builder/);

    expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain(`/dag-workflows/chat-${SESSION_ID}`);
    expect(writes[0].ifNoneMatch).toBe("*");
    const document = writes[0].body as {
      id: string;
      schemaVersion: string;
      entryNodeId: string;
      nodes: { id: string; kind: string; prompt: string }[];
    };
    expect(document.schemaVersion).toBe("1.0");
    // The store rejects a document whose own id differs from the URL's.
    expect(document.id).toBe(`chat-${SESSION_ID}`);
    expect(document.entryNodeId).toBe(document.nodes[0].id);
    expect(document.nodes[0].kind).toBe("agent");
    expect(document.nodes[0].prompt).toContain("Cluster the RNA-seq counts.");
  });

  test("reports a refused write instead of claiming success", async ({ workspacePage }) => {
    // A malformed-but-2xx envelope, for the same reason w4-console-empty uses
    // one: an intentional HTTP 4xx is a browser console error, and this suite
    // fails on those. The verbatim rendering of the validator's own
    // `path: message` list is covered by live-promote-dialog.test.tsx.
    await workspacePage.route(/\/dag-workflows\/[^/]+$/, async (route: Route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ outcome: "created" }),
      });
    });

    const dialog = await openPromoteDialog(workspacePage);
    await dialog.getByRole("button", { name: "Create workflow" }).click();

    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("The typed route rejected the create of");
    // The id it was refused for, named on the message so it stays true if the
    // reader retypes.
    await expect(alert).toContainText(`chat-${SESSION_ID}`);
    await expect(alert).toContainText("MALFORMED_SAVE_RESPONSE");
    await expect(alert).toContainText("Nothing was created");
    await expect(dialog).not.toContainText(/accepted it/i);

    // A refusal is not a dead end: the reader can type the different id the
    // message is asking for and send it. Asserted here rather than as a new
    // item so the suite's inventory pins do not move.
    const create = dialog.getByRole("button", { name: "Create workflow" });
    await expect(create).toBeEnabled();
    const idInput = dialog.getByLabel("Workflow id");
    await idInput.fill(`chat-${SESSION_ID}-2`);
    await expect(create).toBeEnabled();
  });
});

test.describe("w4-console-receipts", () => {
  test("renders the requested-vs-resolved model receipt, with the raw payload still available", async ({
    workspacePage,
  }) => {
    await workspacePage.route(
      (url) => url.pathname.endsWith(`/dag-workflow-runs/${WORKFLOW_RUN_ID}/events`),
      async (route: Route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            events: [
              {
                schemaVersion: 1,
                eventId: "evt-receipt",
                runId: WORKFLOW_RUN_ID,
                seq: 1,
                ts: Date.now(),
                type: "model_resolved",
                nodeId: "analyze",
                executionId: "a".repeat(32),
                data: {
                  modelCallSlotId: "primary",
                  receipt: {
                    request: {
                      requested: {
                        source: "fixed",
                        provider: "anthropic",
                        model: "claude-opus-5",
                        auth: { kind: "oauth", profile: "work" },
                        reasoning: "high",
                      },
                      resolution: {
                        mode: "explicit-fallback",
                        alternatives: [],
                        reason: "Opus may fall back to Sonnet under load.",
                      },
                    },
                    resolved: {
                      provider: "anthropic",
                      model: "claude-sonnet-5",
                      auth: { kind: "api-key" },
                      reasoning: "high",
                      runtime: "pi",
                    },
                    fallbackUsed: true,
                    resolutionReason: "Requested model was rate limited.",
                  },
                },
              },
            ],
            lastSeq: 1,
            hasMore: false,
            diagnostics: [],
          }),
        });
      },
    );

    const rail = await openLiveConsole(workspacePage);
    await rail.getByRole("button", { name: /e2e-workflow/ }).click();

    const receipts = workspacePage
      .getByRole("complementary", { name: "Event drawer" })
      .getByRole("region", { name: "Model receipts" });
    await expect(receipts).toBeVisible();
    // Requested on the left, what actually resolved on the right.
    await expect(receipts.locator("[data-receipt-requested]")).toHaveText(
      "anthropic / claude-opus-5",
    );
    await expect(receipts.locator("[data-receipt-resolved]")).toHaveText(
      "anthropic / claude-sonnet-5",
    );
    // The fallback is called a fallback, and the auth kinds are both shown.
    await expect(receipts.locator("[data-fallback-used='true']")).toBeVisible();
    await expect(receipts).toContainText("fallback taken");
    await expect(receipts.locator("[data-receipt-auth]")).toHaveText(
      "oauth · work → api-key",
    );
    await expect(receipts).toContainText("Requested model was rate limited.");
    await expect(receipts).toContainText("runtime pi");
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
