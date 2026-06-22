// danbot-byok — ledger-roles.test.ts
// Proves the cost ledger buckets the widened role set correctly (checklist 44): agent,
// subagent, council, workflow, and verify rows all sum into totalUsd, with council,
// workflow, and verify each split into their OWN bucket (agentUsd is agent-only) so an
// unhandled role never silently inflates the agent figure. Also proves a `costStatus:
// 'estimated'` row (e.g. an OpenRouter Fusion floor estimate) is tracked in estimatedUsd.
// This is the guard that adding the new roles + costStatus didn't break budget totals.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolvePaths } from "../src/projects.ts";
import { recordRun, sessionCostSummary, type CostRole } from "../src/cost/ledger.ts";

const PROJECT = "ledger-roles-test";
const SID = "sess-ledger-roles";

function record(role: CostRole, cost: number, costStatus?: "billed" | "estimated"): void {
  recordRun({
    sessionId: SID,
    projectId: PROJECT,
    model: "test-model",
    role,
    costStatus,
    before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
    after: { costUsd: cost, input: 10, output: 5, cacheRead: 0, total: 15 },
  });
}

describe("cost ledger role buckets [44]", () => {
  it("sums every role into totalUsd; council/workflow/verify each have their own bucket", () => {
    // resolvePaths is a pure path computation (no seeding), so this test doesn't depend
    // on shared project state. recordRun mkdirs the runs dir as needed.
    const runsDir = resolvePaths(PROJECT).runsDir;
    fs.rmSync(path.join(runsDir, SID), { recursive: true, force: true });

    record("agent", 0.1);
    record("subagent", 0.02);
    record("council", 0.3);
    record("workflow", 0.05, "estimated"); // a Fusion pipeline node priced off the floor
    record("verify", 0.04);

    const summary = sessionCostSummary(SID, PROJECT);
    expect(summary.totalUsd).toBeCloseTo(0.51, 6); // every role counts toward the budget
    expect(summary.subagentUsd).toBeCloseTo(0.02, 6);
    expect(summary.councilUsd).toBeCloseTo(0.3, 6);
    expect(summary.workflowUsd).toBeCloseTo(0.05, 6); // own bucket — no longer folded into agentUsd
    expect(summary.verifyUsd).toBeCloseTo(0.04, 6);
    expect(summary.agentUsd).toBeCloseTo(0.1, 6); // agent-only now
    expect(summary.estimatedUsd).toBeCloseTo(0.05, 6); // the estimated workflow row
    expect(summary.entries).toHaveLength(5);
    expect(summary.entries.every((e) => e.costStatus !== undefined)).toBe(true);
  });
});
