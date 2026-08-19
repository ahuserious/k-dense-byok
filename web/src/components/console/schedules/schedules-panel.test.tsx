import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchedulesPanel } from "./schedules-panel";

/**
 * The panel's contract, from the Console's side:
 *   - it shows the SERVER's next fire time, never one it computed itself;
 *   - a malformed-but-200 body degrades to an error line instead of throwing in
 *     render phase (defect #62 — the failure that took the app down);
 *   - a control that cannot act says why, disabled, rather than looking live;
 *   - every state is a word, not only a colour.
 */

const NEXT_FIRE = "2026-08-19T09:00:00.000Z";

function scheduleBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched_11111111111111111111111111111111",
    workflow_id: "nightly-sweep",
    name: "Nightly sweep",
    expression: "cron:0 9 * * *",
    timezone: "Australia/Sydney",
    enabled: true,
    overlap_policy: "skip",
    input: { goal: "Summarise yesterday" },
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
    next_fire_at: NEXT_FIRE,
    last_fire_at: null,
    last_fire_reason: null,
    last_run_id: null,
    last_run_status: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function routeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond();
    }
    throw new Error(`Unrouted request: ${url}`);
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchedulesPanel", () => {
  it("renders the server's next fire time and a state that is a word, not a colour", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/schedules": () =>
          jsonResponse({ storage_version: 1, scheduler_running: true, schedules: [scheduleBody()] }),
        "/dag-workflows": () => jsonResponse({ workflows: [{ id: "nightly-sweep", name: "Nightly sweep" }] }),
      }),
    );

    render(<SchedulesPanel />);

    expect(await screen.findByText("Nightly sweep")).toBeInTheDocument();
    expect(screen.getByText("cron:0 9 * * *")).toBeInTheDocument();
    // The state is legible as text — "enabled" is a word, not just a colour.
    expect(screen.getByTestId("schedule-state-sched_11111111111111111111111111111111"))
      .toHaveTextContent("enabled");
    // The next fire time is the SERVER's value, rendered in the reader's locale.
    const expected = new Date(NEXT_FIRE).toLocaleString();
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))))
      .toBeInTheDocument();
  });

  it("degrades to an error line when the server sends a malformed but successful body", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        // 200 OK, wrong shape: `schedules` is not an array. Before #62's lesson
        // this class of body threw during render and took the app down.
        "/schedules": () => jsonResponse({ scheduler_running: true, schedules: { nope: true } }),
        "/dag-workflows": () => jsonResponse({ workflows: [] }),
      }),
    );

    render(<SchedulesPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unexpected shape/i);
    // The surface is still there: a bad response degrades, it does not blank.
    expect(screen.getByLabelText("Schedules")).toBeInTheDocument();
  });

  it("renders a schedule whose fields are individually malformed as an error, not as a half-row", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/schedules": () =>
          jsonResponse({
            scheduler_running: true,
            schedules: [scheduleBody({ enabled: "yes", next_fire_at: 12345 })],
          }),
        "/dag-workflows": () => jsonResponse({ workflows: [] }),
      }),
    );

    render(<SchedulesPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/enabled flag/i);
  });

  it("says the ticker is stopped instead of implying schedules will fire", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/schedules": () =>
          jsonResponse({ scheduler_running: false, schedules: [scheduleBody()] }),
        "/dag-workflows": () => jsonResponse({ workflows: [] }),
      }),
    );

    render(<SchedulesPanel />);
    expect(await screen.findByText(/ticker stopped/i)).toBeInTheDocument();
  });

  it("disables the workflow picker with an honest reason when no workflow exists", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/schedules": () => jsonResponse({ scheduler_running: true, schedules: [] }),
        "/dag-workflows": () => jsonResponse({ workflows: [] }),
      }),
    );

    render(<SchedulesPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New schedule" }));

    const picker = screen.getByLabelText("Workflow");
    expect(picker).toBeDisabled();
    expect(screen.getByText(/No workflows exist in this project yet/i)).toBeInTheDocument();
  });

  it("creates a schedule through the keyboard alone", async () => {
    const created: string[] = [];
    let listed = [scheduleBody()];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/dag-workflows")) {
          return jsonResponse({ workflows: [{ id: "nightly-sweep", name: "Nightly sweep" }] });
        }
        if (url.includes("/schedules") && init?.method === "POST") {
          created.push(String(init.body));
          return jsonResponse({ schedule: scheduleBody({ name: "Keyboard schedule" }) }, 201);
        }
        return jsonResponse({ scheduler_running: true, schedules: listed });
      }),
    );

    render(<SchedulesPanel />);
    const user = userEvent.setup();

    // Tab to the "New schedule" button and open the form with the keyboard.
    await screen.findByRole("button", { name: "New schedule" });
    await user.tab();
    expect(screen.getByRole("button", { name: "New schedule" })).toHaveFocus();
    await user.keyboard("{Enter}");

    await user.selectOptions(screen.getByLabelText("Workflow"), "nightly-sweep");
    await user.click(screen.getByLabelText("Name"));
    await user.keyboard("Keyboard schedule");
    const whenField = screen.getByLabelText("When");
    await user.clear(whenField);
    await user.keyboard("every:5m");
    listed = [scheduleBody({ name: "Keyboard schedule" })];
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(created).toHaveLength(1));
    const payload = JSON.parse(created[0]) as Record<string, unknown>;
    expect(payload.workflowId).toBe("nightly-sweep");
    expect(payload.name).toBe("Keyboard schedule");
    expect(payload.expression).toBe("every:5m");
  });

  it("surfaces the server's reason when a demanded run does not happen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/dag-workflows")) return jsonResponse({ workflows: [] });
        if (url.includes("/run-now")) {
          return jsonResponse(
            {
              dispatched: false,
              fire: {
                fire_id: "sfire_1",
                schedule_id: scheduleBody().id,
                window_key: "manual-2026-08-18T00:00:00.000Z",
                window_at: "2026-08-18T00:00:00.000Z",
                fired_at: "2026-08-18T00:00:00.000Z",
                request_id: null,
                run_id: null,
                reason: "controller-absent",
                detail: "Workflow execution is not enabled in this server process.",
                run_status: null,
              },
            },
            200,
          );
        }
        if (init?.method === "POST") return jsonResponse({ schedule: scheduleBody() });
        return jsonResponse({ scheduler_running: true, schedules: [scheduleBody()] });
      }),
    );

    render(<SchedulesPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run now" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /execution is not enabled in this server process/i,
    );
  });

  it("asks before deleting rather than deleting on the first click", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/dag-workflows")) return jsonResponse({ workflows: [] });
        if (init?.method === "DELETE") return jsonResponse(null, 204);
        return jsonResponse({ scheduler_running: true, schedules: [scheduleBody()] });
      }),
    );

    render(<SchedulesPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("DELETE"))).toBe(true));
  });
});
