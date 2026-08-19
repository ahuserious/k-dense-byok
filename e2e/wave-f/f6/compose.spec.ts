// Lane F6 — Gate U for rows 19, 22, 25 and 33.
//
// These drive REAL user paths: the Builder tab's Compose disclosure, and the
// Scientific Pipelines run path. They are Gate U evidence ONLY.
// `e2e/fixtures.ts:35` mocks the backend for the whole suite, so nothing here
// is evidence that the server does anything — Gate B for these rows is proven
// against the lane's live preview in W/reports/f6-evidence.md.
//
// The two DISABLED controls are asserted as hard as the live ones. Row 19's
// "as reference" and row 25's two absent stages are the honest-state half of
// this lane's work (master brief §3 Gate B, §6.7), and a control that quietly
// went live later would be the exact regression this wave exists to prevent.

import type { Page, Request, Route } from "@playwright/test";

import {
  createTypedWorkflowFromTemplate,
  expect,
  selectWorkspaceTab,
  test,
} from "../../fixtures";

// Derived from the preview's own ports, never hard-coded — a spec pinned to
// :18000 would stop intercepting on a lane preview and drive whatever really
// answers there (N-10).
const BACKEND_PORT = process.env.KADY_PORT ?? "18000";
const BACKEND = new RegExp(
  `^(?:${[
    ...new Set([
      `http://127.0.0.1:${BACKEND_PORT}`,
      `http://localhost:${BACKEND_PORT}`,
      ...(process.env.NEXT_PUBLIC_ADK_API_URL
        ? [new URL(process.env.NEXT_PUBLIC_ADK_API_URL).origin]
        : []),
    ]),
  ]
    .map((origin) => origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})/`,
);

function backendPath(request: Request): string | null {
  const url = request.url();
  if (!BACKEND.test(url)) return null;
  return new URL(url).pathname;
}

async function routeJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

test.describe("F6 · builder compose surface", () => {
  test("row 19: the Compose disclosure lists saved workflows as addable palette items", async ({
    workspacePage,
  }) => {
    await selectWorkspaceTab(workspacePage, "Builder");
    const toggle = workspacePage.getByTestId("compose-toggle");

    // Collapsed by default, and it says so to assistive tech.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspacePage.getByTestId("compose-panel")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const palette = workspacePage.getByTestId("saved-workflow-palette");
    await expect(palette).toBeVisible();
    // The fixture's `/dag-workflows` returns exactly this saved workflow.
    await expect(workspacePage.getByTestId("saved-workflow-add-e2e-workflow")).toBeVisible();
    await expect(workspacePage.getByTestId("saved-workflow-add-e2e-workflow")).toContainText(
      "E2E Workflow",
    );
    await expect(workspacePage.getByTestId("saved-workflow-add-e2e-workflow")).toContainText("rev 1");
  });

  test("rows 19+22: a saved workflow is added as a phase by KEYBOARD alone", async ({
    workspacePage,
  }) => {
    // Row 19 says "draggable palette nodes". A drag is a keyboard trap on its
    // own, so the whole path is walked here with no pointer gesture at all: the
    // control is a real <button>, focus lands on it, and Enter activates it.
    await selectWorkspaceTab(workspacePage, "Builder");

    // A phase is added TO something, so load a workflow first.
    // Scoped to the picker's own listbox: the assistant rail's <select> also
    // publishes an "E2E Workflow · rev 1" option, so an unscoped role query is
    // ambiguous under strict mode.
    await workspacePage
      .getByRole("listbox", { name: "Workflow sources" })
      .getByRole("option")
      .filter({ hasText: "E2E Workflow" })
      .first()
      .click();
    await expect(workspacePage.getByTestId("loaded-workflow-name")).not.toHaveText(
      "No workflow loaded",
    );

    await workspacePage.getByTestId("compose-toggle").click();
    const item = workspacePage.getByTestId("saved-workflow-add-e2e-workflow");

    await expect(item).toBeEnabled();
    await item.focus();
    await expect(item).toBeFocused();
    await workspacePage.keyboard.press("Enter");

    // The phase really landed on the document the author is editing.
    await expect(workspacePage.getByTestId("builder-host-status")).toContainText("as a phase", {
      timeout: 15_000,
    });
  });

  test("row 19: 'as reference' is disabled and states why, rather than looking live", async ({
    workspacePage,
  }) => {
    await selectWorkspaceTab(workspacePage, "Builder");
    await workspacePage.getByTestId("compose-toggle").click();

    const reference = workspacePage.getByTestId("saved-workflow-reference-e2e-workflow");
    await expect(reference).toBeVisible();
    await expect(reference).toBeDisabled();

    // The reason is on screen, not only in a title attribute.
    const reason = workspacePage.getByTestId("saved-workflow-reference-reason");
    await expect(reason).toBeVisible();
    await expect(reason).toContainText("no workflow-reference node kind");
    await expect(reason).toContainText("snapshot");
  });

  test("row 22: with nothing loaded, 'add as phase' is disabled and says why", async ({
    workspacePage,
  }) => {
    await selectWorkspaceTab(workspacePage, "Builder");
    await workspacePage.getByTestId("compose-toggle").click();

    // With nothing loaded the add control is disabled AND says why — it must not
    // silently do nothing when pressed.
    const item = workspacePage.getByTestId("saved-workflow-add-e2e-workflow");
    await expect(item).toBeDisabled();
    await expect(workspacePage.getByTestId("saved-workflow-palette")).toContainText(
      "Load a workflow first",
    );
  });

  test("row 25: fusion boost shows all four stages, two of them disabled with a reason", async ({
    workspacePage,
  }) => {
    await selectWorkspaceTab(workspacePage, "Builder");
    await workspacePage.getByTestId("compose-toggle").click();

    await expect(workspacePage.getByTestId("fusion-boost-options")).toBeVisible();

    // All four stages are VISIBLE — an unavailable stage is disabled, never hidden.
    for (const stage of ["planning", "elevation-to-dag", "hypothesis", "verification-gate"]) {
      await expect(workspacePage.getByTestId(`fusion-boost-stage-${stage}`)).toBeVisible();
    }

    // The two that cannot bind name the lane they are waiting on.
    await expect(workspacePage.getByTestId("fusion-boost-stage-elevation-to-dag")).toBeDisabled();
    await expect(workspacePage.getByTestId("fusion-boost-reason-elevation-to-dag")).toContainText(
      "elevate-to-DAG node kind",
    );
    await expect(workspacePage.getByTestId("fusion-boost-reason-elevation-to-dag")).toContainText(
      "lane F5",
    );
    await expect(workspacePage.getByTestId("fusion-boost-stage-hypothesis")).toBeDisabled();
    await expect(workspacePage.getByTestId("fusion-boost-reason-hypothesis")).toContainText(
      "hypothesis node kind",
    );
  });

  test("row 25: the master toggle gates the stages, and starts off", async ({ workspacePage }) => {
    await selectWorkspaceTab(workspacePage, "Builder");
    await workspacePage.getByTestId("compose-toggle").click();

    const enabled = workspacePage.getByTestId("fusion-boost-enabled");
    await expect(enabled).not.toBeChecked();

    // With no document loaded the whole group is disabled and says why, rather
    // than accepting a value that has nowhere to go.
    await expect(enabled).toBeDisabled();
    await expect(workspacePage.getByTestId("fusion-boost-options")).toContainText(
      "Load a workflow first",
    );
    await expect(workspacePage.getByTestId("fusion-boost-stage-planning")).toBeDisabled();
  });
});

test.describe("F6 · best-of-n branches", () => {
  /**
   * Serve a run whose graph holds one `best-of-n` node, with candidate slots in
   * three DIFFERENT states. A view driven by `candidateCount` alone would render
   * them identically and fail the assertions below — which is the point.
   */
  async function installBestOfNRun(page: Page) {
    const runId = `wrun_${"f".repeat(32)}`;
    await page.route(BACKEND, async (route, request) => {
      const path = backendPath(request);
      const method = request.method();

      if (path?.endsWith("/runs") && method === "POST") {
        return routeJson(
          route,
          {
            manifest: { id: runId, workflowId: "ml-model-selection-review", workflowRevision: 1 },
            state: { runId, status: "running", executions: {} },
          },
          202,
        );
      }

      if (path === `/dag-workflow-runs/${runId}` && method === "GET") {
        return routeJson(route, {
          manifest: {
            id: runId,
            graph: {
              nodes: [
                {
                  id: "pick",
                  name: "Pick the best",
                  kind: "best-of-n",
                  candidateCount: 4,
                  goal: "Choose the strongest approach.",
                },
              ],
            },
          },
          state: {
            runId,
            status: "running",
            executions: {
              "dagx_1": {
                executionId: "dagx_1",
                nodeId: "pick",
                status: "running",
                modelCallSlots: {
                  "candidate-1": { id: "candidate-1", request: {}, receipt: { request: {} } },
                  "candidate-2": { id: "candidate-2", request: {} },
                },
              },
            },
          },
        });
      }

      if (path === `/dag-workflow-runs/${runId}/events` && method === "GET") {
        return routeJson(route, { events: [], lastSeq: 0, hasMore: false, diagnostics: [] });
      }

      return route.fallback();
    });
    return runId;
  }

  test("row 33: launching a run renders one branch per candidate, from real slot state", async ({
    workspacePage,
  }) => {
    await installBestOfNRun(workspacePage);
    const { details } = await createTypedWorkflowFromTemplate(
      workspacePage,
      "ml-model-selection-review",
    );

    await details.getByRole("button", { name: "Run typed workflow" }).click();

    const branches = workspacePage.getByTestId("best-of-n-branches");
    await expect(branches).toBeVisible({ timeout: 20_000 });

    // Four branches for candidateCount: 4.
    for (const index of [1, 2, 3, 4]) {
      await expect(workspacePage.getByTestId(`best-of-n-branch-${String(index)}`)).toBeVisible();
    }
    await expect(branches).toContainText("4 candidates");
  });

  test("row 33: each branch shows ITS OWN slot's state, not one shared status", async ({
    workspacePage,
  }) => {
    await installBestOfNRun(workspacePage);
    const { details } = await createTypedWorkflowFromTemplate(
      workspacePage,
      "ml-model-selection-review",
    );
    await details.getByRole("button", { name: "Run typed workflow" }).click();
    await expect(workspacePage.getByTestId("best-of-n-branches")).toBeVisible({ timeout: 20_000 });

    // candidate-1 has a receipt, candidate-2 is declared without one, and
    // candidates 3 and 4 have not been reached by the sequential executor.
    await expect(workspacePage.getByTestId("best-of-n-branch-1")).toHaveAttribute(
      "data-branch-state",
      "resolved",
    );
    await expect(workspacePage.getByTestId("best-of-n-branch-2")).toHaveAttribute(
      "data-branch-state",
      "in-flight",
    );
    await expect(workspacePage.getByTestId("best-of-n-branch-3")).toHaveAttribute(
      "data-branch-state",
      "not-started",
    );
    // State is readable as WORDS, never colour alone (§6.6).
    await expect(workspacePage.getByTestId("best-of-n-branch-1")).toContainText("resolved");
    await expect(workspacePage.getByTestId("best-of-n-branch-3")).toContainText("not started");
  });

  test("row 33: the view states that candidates run sequentially, and names no winner yet", async ({
    workspacePage,
  }) => {
    await installBestOfNRun(workspacePage);
    const { details } = await createTypedWorkflowFromTemplate(
      workspacePage,
      "ml-model-selection-review",
    );
    await details.getByRole("button", { name: "Run typed workflow" }).click();

    const branches = workspacePage.getByTestId("best-of-n-branches");
    await expect(branches).toBeVisible({ timeout: 20_000 });

    // The executor is a sequential `for` loop with `await` inside, so the view
    // must not imply concurrency.
    await expect(branches).toContainText("one at a time");
    // No evaluator verdict has arrived, so no candidate is marked the winner.
    await expect(branches).toContainText("No candidate has been chosen yet");
    await expect(branches).not.toContainText("★ winner");
  });
});
