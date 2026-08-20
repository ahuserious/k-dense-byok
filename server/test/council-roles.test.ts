import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNCIL_FUSER_COUNT,
  DEFAULT_COUNCIL_HEAD_COUNT,
  DEFAULT_COUNCIL_JUDGE_COUNT,
  councilRecruitmentObservation,
  effectiveCouncilRecruitmentBound,
  selectCouncilHeads,
} from "../src/workflows/council-roles.ts";
import { mapWithBoundedConcurrency } from "../src/workflows/kinds/bounded-concurrency.ts";
import { runStateNodeObservations } from "../src/workflows/kinds/run-state-observations.ts";
import {
  WORKFLOW_BEHAVIOR_CAPABILITIES,
  WorkflowBehaviorRegistry,
  parseRunStateV1,
} from "../src/workflows/index.ts";
import type { WorkflowNode } from "../src/workflows/schema.ts";

describe("council roles and rescue branches", () => {
  it("defaults to 4 heads, 1 judge, and 1 fuser", () => {
    expect(DEFAULT_COUNCIL_HEAD_COUNT).toBe(4);
    expect(DEFAULT_COUNCIL_JUDGE_COUNT).toBe(1);
    expect(DEFAULT_COUNCIL_FUSER_COUNT).toBe(1);
  });

  it("binds headSelection to the running council roster", () => {
    const model = {
      requested: {
        source: "fixed" as const,
        provider: "openrouter",
        model: "vendor/a",
        auth: { kind: "api_key" as const },
        reasoning: "off" as const,
      },
      resolution: { mode: "exact" as const },
    };
    const node = {
      id: "council",
      name: "Council",
      kind: "council",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Decide.",
      members: [
        { id: "a", role: "Reviewer A", model },
        { id: "b", role: "Reviewer B", model },
      ],
      chair: model,
      rounds: 1,
      preserveMinorityReports: false,
    } as Extract<WorkflowNode, { kind: "council" }>;

    const auto = selectCouncilHeads({ ...node, headSelection: "auto" });
    expect(auto.mode).toBe("auto");
    expect(auto.source).toBe("workflow-type");
    expect(auto.members.map((member) => member.role)).toEqual(["genomics", "statistician"]);
    expect(auto.members.map((member) => member.id)).toEqual(["a", "b"]);

    const manual = selectCouncilHeads(
      { ...node, headSelection: "manual" },
      ["map-head-a", "map-head-b"],
    );
    expect(manual.mode).toBe("manual");
    expect(manual.source).toBe("authored");
    expect(manual.members.map((member) => member.role)).toEqual(["Reviewer A", "Reviewer B"]);

    const inbound = selectCouncilHeads(node, ["map-head-a", "map-head-b"]);
    expect(inbound.mode).toBe("auto");
    expect(inbound.source).toBe("inbound-reasoning-style");
    expect(inbound.members.map((member) => member.role)).toEqual(["map-head-a", "map-head-b"]);
  });

  it("caps recruitment at maxRecruits and maxSubagents", () => {
    const node = {
      kind: "council",
      maxRecruits: 3,
    } as Extract<WorkflowNode, { kind: "council" }>;
    expect(effectiveCouncilRecruitmentBound(node, 2)).toBe(2);
    expect(councilRecruitmentObservation(5, 2, "blind spot").recruited).toBe(2);
  });

  it("projects recruitment and branches onto RunState nodes", () => {
    const extras = runStateNodeObservations({
      kind: "council",
      recruitment: { recruited: 1, maxRecruits: 2, reason: "disagreement" },
      branches: [{ id: "candidate-1", status: "succeeded", label: "Candidate 1" }],
    });
    const state = parseRunStateV1(JSON.stringify({
      schemaVersion: 1,
      runId: "wrun_1",
      workflowId: "wf",
      workflowRevision: 1,
      status: "succeeded",
      nodes: [{
        id: "council",
        status: "succeeded",
        progress: { completed: 1, total: 1 },
        ...extras,
      }],
      topology: { nodes: [{ id: "council" }], edges: [] },
      updatedAt: 1,
    }));
    expect(state.nodes[0]?.recruitment).toEqual({
      recruited: 1,
      maxRecruits: 2,
      reason: "disagreement",
    });
    expect(state.nodes[0]?.branches?.[0]?.id).toBe("candidate-1");
  });

  it("runs best-of-n candidates concurrently under the parallelism bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const results = await mapWithBoundedConcurrency(4, 2, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(index);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return `candidate-${index + 1}`;
    });
    expect(results).toEqual(["candidate-1", "candidate-2", "candidate-3", "candidate-4"]);
    expect(peak).toBe(2);
    expect(seen).toHaveLength(4);
  });

  it("exposes stop-workflow for F14 and dispatches supervisor-fix-DAG", async () => {
    expect(WORKFLOW_BEHAVIOR_CAPABILITIES).toContain("stop-workflow");
    const registry = new WorkflowBehaviorRegistry();
    const repaired: string[] = [];
    registry.register("durability-watcher", ["escalate-fix-redeploy", "stop-workflow"], (dispatch) => {
      if (dispatch.capability === "escalate-fix-redeploy") {
        repaired.push(dispatch.runId);
        return { handled: true, detail: "redeployed" };
      }
      return { handled: true, detail: "stopped" };
    });
    await expect(registry.dispatch("durability-watcher", {
      capability: "escalate-fix-redeploy",
      runId: "wrun_failed",
    })).resolves.toEqual({ handled: true, detail: "redeployed" });
    expect(repaired).toEqual(["wrun_failed"]);
  });
});
