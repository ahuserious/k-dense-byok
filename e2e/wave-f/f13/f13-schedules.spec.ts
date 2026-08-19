/**
 * Lane F13 — row 52, Gate U: a user who has never read the source can find and
 * operate schedules from the running app.
 *
 * These items drive the REAL user path — Console tab → Agents & Loops → the
 * schedules table — with mouse AND keyboard, and assert on what the user sees:
 * the schedule listed with its next fire time, the state changing when it is
 * paused, the fire history, and the honest reason when a control cannot act.
 *
 * The schedules API is stubbed IN THIS FILE (the shared fixture predates this
 * lane and treats an unknown backend path as an unexpected request). Handlers
 * registered here take priority over the fixture's catch-all, so the fixture
 * never sees a /schedules call.
 */
import { expect, selectWorkspaceTab, test } from "../../fixtures";
import type { Page, Route } from "@playwright/test";

const SCHEDULE_ID = "sched_1111111111111111111111111111aaaa".slice(0, 38);
const NEXT_FIRE = "2026-08-19T09:00:00.000Z";

interface ScheduleState {
  enabled: boolean;
  deleted: boolean;
  created: unknown[];
  cancelledRuns: number;
  runNowRefused: boolean;
}

function scheduleBody(state: ScheduleState) {
  return {
    id: SCHEDULE_ID,
    workflow_id: "e2e-workflow",
    name: "Nightly evidence sweep",
    expression: "cron:0 9 * * *",
    timezone: "Australia/Sydney",
    enabled: state.enabled,
    overlap_policy: "skip",
    input: { goal: "Summarise yesterday" },
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
    next_fire_at: NEXT_FIRE,
    last_fire_at: "2026-08-18T09:00:00.000Z",
    last_fire_reason: "dispatched",
    last_run_id: "wrun_11111111111111111111111111111111",
    last_run_status: "succeeded",
  };
}

function fireBody(reason: string, detail: string, runId: string | null) {
  return {
    fire_id: `sfire_${reason}`,
    schedule_id: SCHEDULE_ID,
    window_key: "2026-08-18T09:00",
    window_at: "2026-08-18T09:00:00.000Z",
    fired_at: "2026-08-18T09:00:01.000Z",
    request_id: runId ? `schedule:${SCHEDULE_ID}:2026-08-18T09:00` : null,
    run_id: runId,
    reason,
    detail,
    run_status: runId ? "succeeded" : null,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Install the schedules stub. Must run before the Console is opened. */
async function installScheduleRoutes(page: Page): Promise<ScheduleState> {
  const state: ScheduleState = {
    enabled: true,
    deleted: false,
    created: [],
    cancelledRuns: 0,
    runNowRefused: false,
  };
  await page.route("**/schedules**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (path.endsWith("/fires")) {
      return json(route, {
        fires: [
          fireBody("dispatched", "The schedule started a run for this window.", "wrun_11111111111111111111111111111111"),
          fireBody(
            "overlap-skipped",
            'The previous run of this schedule is still going and the overlap policy is "skip", so this window did not start a second run.',
            null,
          ),
        ],
      });
    }
    if (path.endsWith("/run-now")) {
      return state.runNowRefused
        ? json(
            route,
            {
              dispatched: false,
              fire: fireBody(
                "controller-absent",
                "Workflow execution is not enabled in this server process, so no run was created for this window.",
                null,
              ),
            },
            200,
          )
        : json(route, { dispatched: true, fire: fireBody("dispatched", "The schedule started a run for this window.", "wrun_11111111111111111111111111111111") }, 202);
    }
    if (path.endsWith("/stop")) {
      state.enabled = false;
      state.cancelledRuns = 1;
      return json(route, {
        schedule: scheduleBody(state),
        cancelled_run_ids: ["wrun_11111111111111111111111111111111"],
        refused_run_ids: [],
      });
    }
    if (path.endsWith("/disable") || path.endsWith("/enable")) {
      state.enabled = path.endsWith("/enable");
      return json(route, { schedule: scheduleBody(state) });
    }
    if (method === "DELETE") {
      state.deleted = true;
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "POST") {
      state.created.push(JSON.parse(request.postData() ?? "{}"));
      return json(route, { schedule: scheduleBody(state) }, 201);
    }
    return json(route, {
      storage_version: 1,
      scheduler_running: true,
      schedules: state.deleted ? [] : [scheduleBody(state)],
    });
  });
  return state;
}

async function openSchedules(page: Page) {
  await selectWorkspaceTab(page, "Console");
  await page.getByRole("button", { name: "Agents & Loops" }).click();
  const panel = page.getByRole("region", { name: "Schedules" });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("F13 schedules in the Console", () => {
  test("lists a schedule with the server's next fire time", async ({ workspacePage }) => {
    await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    await expect(panel.getByText("Nightly evidence sweep")).toBeVisible();
    await expect(panel.getByText("cron:0 9 * * *")).toBeVisible();
    await expect(panel.getByText("Australia/Sydney")).toBeVisible();
    // The next-fire time comes from the server, rendered in the reader's locale.
    await expect(panel.getByRole("cell", {
      name: new RegExp(new Date(NEXT_FIRE).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })).toBeVisible();
    // State is a word, not only a colour.
    await expect(panel.getByTestId(`schedule-state-${SCHEDULE_ID}`)).toContainText("enabled");
  });

  test("pauses a schedule and shows the state change", async ({ workspacePage }) => {
    await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    await panel.getByRole("button", { name: "Pause" }).click();
    await expect(panel.getByTestId(`schedule-state-${SCHEDULE_ID}`)).toContainText("paused");
    await expect(panel.getByRole("cell", { name: "paused", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test("creates a schedule from the keyboard alone", async ({ workspacePage }) => {
    const state = await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    const newButton = panel.getByRole("button", { name: "New schedule" });
    await newButton.focus();
    await expect(newButton).toBeFocused();
    await workspacePage.keyboard.press("Enter");

    const form = panel.getByRole("form", { name: "New schedule" });
    await expect(form).toBeVisible();
    await form.getByLabel("Workflow").selectOption("e2e-workflow");
    await form.getByLabel("Name").fill("Keyboard schedule");
    await form.getByLabel("When").fill("every:10m");
    await form.getByRole("button", { name: "Create schedule" }).press("Enter");

    await expect.poll(() => state.created.length).toBe(1);
    expect(state.created[0]).toMatchObject({
      workflowId: "e2e-workflow",
      name: "Keyboard schedule",
      expression: "every:10m",
      overlapPolicy: "skip",
    });
  });

  test("shows the fire history with the reason a window did not run", async ({ workspacePage }) => {
    await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    await panel.getByRole("button", { name: "History" }).click();
    const history = panel.getByLabel("Fire history for Nightly evidence sweep");
    await expect(history).toBeVisible();
    await expect(history.getByText("started a run")).toBeVisible();
    await expect(history.getByText("skipped, previous run still going")).toBeVisible();
    await expect(history.getByText(/overlap policy is "skip"/)).toBeVisible();
  });

  test("stops a runaway: pauses the schedule and reports the cancelled run", async ({ workspacePage }) => {
    await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    await panel.getByRole("button", { name: "Stop everything" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("1 run(s) cancelled");
    await expect(panel.getByTestId(`schedule-state-${SCHEDULE_ID}`)).toContainText("paused");
  });

  test("reports honestly when a demanded run cannot happen", async ({ workspacePage }) => {
    const state = await installScheduleRoutes(workspacePage);
    state.runNowRefused = true;
    const panel = await openSchedules(workspacePage);

    await panel.getByRole("button", { name: "Run now" }).click();
    await expect(workspacePage.getByRole("status")).toContainText(
      "Workflow execution is not enabled in this server process",
    );
  });

  test("asks before deleting, then removes the schedule", async ({ workspacePage }) => {
    const state = await installScheduleRoutes(workspacePage);
    const panel = await openSchedules(workspacePage);

    await panel.getByRole("button", { name: "Delete" }).click();
    expect(state.deleted).toBe(false);
    await panel.getByRole("button", { name: "Confirm delete" }).click();
    await expect.poll(() => state.deleted).toBe(true);
    await expect(panel.getByText(/No schedules yet/)).toBeVisible();
  });
});
