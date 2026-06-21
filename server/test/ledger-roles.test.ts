// danbot-byok — ledger-roles.test.ts
// Proves the cost ledger buckets the widened role set correctly (checklist 44): agent,
// subagent, council, and workflow rows all sum into totalUsd, with council split into its
// own bucket and workflow folding into agentUsd (the documented current behaviour). This
// is the guard that adding the council/workflow roles didn't silently break budget totals.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolvePaths } from "../src/projects.ts";
import { recordRun, sessionCostSummary } from "../src/cost/ledger.ts";

const PROJECT = "ledger-roles-test";
const SID = "sess-ledger-roles";

function record(role: "agent" | "subagent" | "council" | "workflow", cost: number): void {
  recordRun({
    sessionId: SID,
    projectId: PROJECT,
    model: "test-model",
    role,
    before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
    after: { costUsd: cost, input: 10, output: 5, cacheRead: 0, total: 15 },
  });
}

describe("cost ledger role buckets [44]", () => {
  it("sums every role into totalUsd; council has its own bucket", () => {
    // resolvePaths is a pure path computation (no seeding), so this test doesn't depend
    // on shared project state. recordRun mkdirs the runs dir as needed.
    const runsDir = resolvePaths(PROJECT).runsDir;
    fs.rmSync(path.join(runsDir, SID), { recursive: true, force: true });

    record("agent", 0.1);
    record("subagent", 0.02);
    record("council", 0.3);
    record("workflow", 0.05);

    const summary = sessionCostSummary(SID, PROJECT);
    expect(summary.totalUsd).toBeCloseTo(0.47, 6); // every role counts toward the budget
    expect(summary.subagentUsd).toBeCloseTo(0.02, 6);
    expect(summary.councilUsd).toBeCloseTo(0.3, 6);
    expect(summary.agentUsd).toBeCloseTo(0.15, 6); // agent + workflow (workflow folds into agentUsd today)
    expect(summary.entries).toHaveLength(4);
  });
});
