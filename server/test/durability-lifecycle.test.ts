import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { ContextEngineeringProduction } from
  "../src/workflows/context-watcher-production.ts";
import { MemoryDurabilityJournal } from "../src/workflows/durability-journal.ts";
import {
  MemoryDurabilitySettingsStore,
  defaultDurabilitySettings,
} from "../src/workflows/durability-settings.ts";
import type { WorkflowStore } from "../src/workflows/store.ts";

/**
 * #41: three supervisor processes have been orphaned since 2026-08-12 because a
 * failed integration test can orphan a backend. This lane must not add another
 * way to leak one. The durability watcher owns NO timer and NO process: it
 * rides the feed that already exists, so its lifecycle is the server's.
 */

const PROJECT_ID = "durability-lifecycle-test";
const productions: ContextEngineeringProduction[] = [];

afterEach(() => {
  for (const production of productions.splice(0)) production.close();
  vi.useRealTimers();
  fs.rmSync(path.join(PROJECTS_ROOT, PROJECT_ID), { recursive: true, force: true });
});

/**
 * One live run carrying an unsupported evidence check, so a sweep fires the
 * hallucination signal and its `lateral-pass` action reaches a model call —
 * the real shape of "the 5-second feed is now making provider calls".
 */
const SWEPT_RUN_ID = "wrun_dddddddddddddddddddddddddddddddd";

function sweptRunStore(): WorkflowStore {
  const run = {
    manifest: {
      id: SWEPT_RUN_ID,
      workflowId: "workflow-lifecycle",
      graphSha256: "a".repeat(64),
      sessionId: "session-lifecycle",
      input: { goal: "Finish the lifecycle run." },
      graph: { nodes: [{ id: "writer", kind: "agent" }] },
    },
    state: { status: "running", lastSeq: 5, recoverable: true, executions: {} },
  } as unknown as ReturnType<WorkflowStore["readRun"]>;
  const events = [{
    schemaVersion: 1,
    runId: SWEPT_RUN_ID,
    eventId: "lifecycle-evidence",
    seq: 5,
    ts: 1_700_000_000_000,
    type: "evidence_checked",
    executionId: "exec-1",
    nodeId: "writer",
    attempt: 1,
    branchId: "entry",
    data: { supported: false, sourceIds: [], summary: "no support" },
  }];
  return {
    listRuns: () => [run],
    readRun: () => run,
    readRunEvents: (
      _projectId: string,
      _runId: string,
      options?: { after?: number },
    ) => ({
      events: events.filter((event) => event.seq > (options?.after ?? 0)),
      lastSeq: 5,
      hasMore: false,
    }),
  } as unknown as WorkflowStore;
}

/**
 * Drain until a condition holds. A sweep does real (if in-memory) work before
 * it reaches the model call, so a fixed number of microtask ticks is a race.
 */
async function until(
  predicate: () => boolean,
  label: string,
  options: { fakeTimers?: boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    if (options.fakeTimers) await vi.advanceTimersByTimeAsync(1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${label}.`);
}

/** Settings that make a sweep fire hallucination and take the lateral pass. */
function sweepingSettings(): MemoryDurabilitySettingsStore {
  const settings = new MemoryDurabilitySettingsStore();
  settings.write(PROJECT_ID, {
    ...defaultDurabilitySettings(),
    enabled: true,
    watcherModel: { kind: "direct", ref: "openrouter/qwen/qwen3.6-27b", effort: "high" },
    rescueModel: {
      kind: "direct",
      ref: "openrouter/openai/gpt-5.6-luna-pro",
      effort: "xhigh",
    },
    signals: {
      ...defaultDurabilitySettings().signals,
      hallucination: { enabled: true, action: "lateral-pass", threshold: 1 },
    },
  });
  return settings;
}

function emptyStore(): WorkflowStore {
  return {
    listRuns: () => [],
    readRun: () => null,
    readRunEvents: () => ({ events: [], lastSeq: 0, hasMore: false }),
  } as unknown as WorkflowStore;
}

function production(journal = new MemoryDurabilityJournal()) {
  const settings = new MemoryDurabilitySettingsStore();
  settings.write(PROJECT_ID, { ...defaultDurabilitySettings(), enabled: true });
  const instance = new ContextEngineeringProduction(null, {
    store: emptyStore(),
    completeJson: vi.fn(),
    durabilitySettings: settings,
    durabilityJournal: journal,
  });
  productions.push(instance);
  return instance;
}

describe("durability lifecycle (#41)", () => {
  it("adds no timer of its own: the background feed owns exactly one interval", () => {
    vi.useFakeTimers();
    const instance = production();

    instance.startStoppedRunFeed();
    expect(vi.getTimerCount()).toBe(1);

    // Calling it twice must not stack a second interval.
    instance.startStoppedRunFeed();
    expect(vi.getTimerCount()).toBe(1);

    instance.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing the server releases every watched run", async () => {
    ensureProjectExists(PROJECT_ID);
    const journal = new MemoryDurabilityJournal();
    const instance = production(journal);

    const watcher = instance.forProject(PROJECT_ID).durability;
    await instance.observeDurability();
    instance.close();

    expect(watcher.watchedRuns()).toEqual([]);
  });

  it("survives a project whose durability state cannot be read", async () => {
    const instance = production();
    // No project directory exists; reading settings must degrade to defaults
    // rather than throw and take the feed (and with it the server) down.
    await expect(instance.observeDurability()).resolves.toEqual([]);
  });

  it("a tick that lands while a sweep is in flight is a no-op, not a second sweep", async () => {
    // #41. The durability sweep now makes real provider calls inside the
    // 5-second feed. Without this guard a slow or hung provider makes ticks
    // stack: each new tick starts another full project sweep while the previous
    // escalation is still awaiting, and the pre-existing restart scan queues
    // behind all of them.
    ensureProjectExists(PROJECT_ID);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const completeJson = vi.fn().mockImplementation(async () => {
      await held;
      return {
        summary: "The writer node produced an unsupported claim.",
        goal: "Finish the lifecycle run.",
        openTodos: ["Re-ground the claim"],
        decisions: ["Hand off to a clean window"],
        constraints: ["Keep the original goal"],
      };
    });

    const instance = new ContextEngineeringProduction(null, {
      store: sweptRunStore(),
      completeJson,
      durabilitySettings: sweepingSettings(),
      durabilityJournal: new MemoryDurabilityJournal(),
      onError: () => {},
    });
    productions.push(instance);

    // Hold one sweep open on its model call...
    const first = instance.observeDurability();
    await until(() => completeJson.mock.calls.length === 1, "the sweep's model call");

    // ...and fire two more ticks while it is still in flight.
    expect(await instance.observeDurability()).toEqual([]);
    expect(await instance.observeDurability()).toEqual([]);
    expect(instance.durabilitySweepsSkipped()).toBe(2);
    // The decisive assertion: no second sweep started a second model call.
    expect(completeJson).toHaveBeenCalledTimes(1);

    release!();
    await first;
    // Once the sweep finishes, the next tick runs normally again.
    await instance.observeDurability();
    expect(instance.durabilitySweepsSkipped()).toBe(2);
  });

  it("bounds a hung provider call instead of holding the feed open forever", async () => {
    // A model call that never settles must not park a sweep indefinitely.
    // `runtime.complete` receives an AbortSignal AND a timeoutMs; the
    // wall-clock race bounds the call even when the completion seam ignores
    // both, which is what a stub — or a non-compliant provider — does.
    ensureProjectExists(PROJECT_ID);
    vi.useFakeTimers();
    const seen: Array<{ hasSignal: boolean; timeoutMs?: number; aborted?: boolean }> = [];
    const completeJson = vi.fn().mockImplementation(
      (call: { signal?: AbortSignal; timeoutMs?: number }) =>
        new Promise(() => {
          seen.push({ hasSignal: call.signal !== undefined, timeoutMs: call.timeoutMs });
          call.signal?.addEventListener("abort", () => { seen[0].aborted = true; });
        }),
    );

    const errors: unknown[] = [];
    const instance = new ContextEngineeringProduction(null, {
      store: sweptRunStore(),
      completeJson,
      durabilitySettings: sweepingSettings(),
      durabilityJournal: new MemoryDurabilityJournal(),
      onError: (error) => errors.push(error),
    });
    productions.push(instance);

    const sweep = instance.observeDurability();
    await until(() => seen.length === 1, "the sweep's model call", { fakeTimers: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].hasSignal).toBe(true);
    expect(seen[0].timeoutMs).toBe(240_000);

    await vi.advanceTimersByTimeAsync(240_001);
    const observations = await sweep;

    // The provider call was aborted, the sweep finished, and the run was left
    // alone: the fire reports NOT dispatched with a legible reason.
    expect(seen[0].aborted).toBe(true);
    const fire = observations.flatMap((observation) => observation.fires)[0];
    expect(fire.dispatched).toBe(false);
    expect(fire.detail).toContain("did not answer within 240 seconds");
    expect(fire.detail).toContain("left exactly as it was");
  });

  it("spawns no child process", () => {
    const instance = production();
    instance.startStoppedRunFeed();
    // The watcher's only outward reach is a model call through the injected
    // completion seam; it never shells out.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "workflows", "durability-watcher.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|setInterval|setTimeout/);
    instance.close();
  });
});
