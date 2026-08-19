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
