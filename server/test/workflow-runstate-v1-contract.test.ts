import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  RUN_STATE_V1_SCHEMA_VERSION,
  RunStateV1Schema,
  parseRunStateV1,
  serializeRunStateV1,
  type RunStateV1,
} from "../src/api/workflow-run-state.ts";

function runState(): RunStateV1 {
  return {
    schemaVersion: RUN_STATE_V1_SCHEMA_VERSION,
    runId: "run-1",
    workflowId: "science-workflow",
    workflowRevision: 3,
    status: "running",
    nodes: [
      {
        id: "research",
        status: "succeeded",
        progress: { completed: 3, total: 3, message: "Research complete" },
        executionId: "research-attempt-1",
      },
      {
        id: "synthesis",
        status: "running",
        progress: { completed: 1, total: 4 },
        executionId: "synthesis-attempt-1",
      },
    ],
    topology: {
      nodes: [{ id: "research" }, { id: "synthesis" }],
      edges: [{ id: "research-to-synthesis", from: "research", to: "synthesis" }],
    },
    backgroundAgentTrailingNode: {
      slotId: "background-agent-slot",
      agentId: "scientific-dag-rescue",
      status: "waiting",
    },
    errorRouting: {
      source: "chat-stream",
      surface: true,
      nodeId: "synthesis",
      error: { code: "CHAT_STREAM_FAILED", message: "Stream disconnected.", retryable: true },
    },
    updatedAt: 1_725_000_000_000,
  };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const ACTIVE_NODE_STATUSES = ["running", "waiting", "blocked"] as const;
const INVALID_TERMINAL_ACTIVE_COMBINATIONS = TERMINAL_RUN_STATUSES.flatMap((runStatus) =>
  ACTIVE_NODE_STATUSES.map((nodeStatus) => ({ runStatus, nodeStatus }))
);

describe("RunState v1 contract", () => {
  it("exposes a JSON schema and round-trips through the API surface", () => {
    const state = runState();
    expect(Value.Check(RunStateV1Schema, state)).toBe(true);

    const serialized = serializeRunStateV1(state);
    expect(parseRunStateV1(serialized)).toEqual(state);
    expect(parseRunStateV1(serialized)).not.toBe(state);
  });

  it("rejects progress beyond the declared total", () => {
    const state = runState();
    state.nodes[1].progress.completed = 5;
    expect(() => serializeRunStateV1(state)).toThrow(/progress for node synthesis/);
  });

  it("rejects topology edges whose endpoints are absent", () => {
    const state = runState();
    state.topology.edges[0].to = "missing";
    expect(() => serializeRunStateV1(state)).toThrow(/unknown node/);
  });

  it("rejects duplicate state-node ids", () => {
    const state = runState();
    state.nodes.push(structuredClone(state.nodes[0]));
    expect(() => serializeRunStateV1(state)).toThrow(/nodes: duplicate node id research/);
  });

  it("rejects duplicate topology-edge ids", () => {
    const state = runState();
    state.topology.edges.push(structuredClone(state.topology.edges[0]));
    expect(() => serializeRunStateV1(state)).toThrow(/topology: duplicate edge id/);
  });

  it("rejects state nodes absent from topology", () => {
    const state = runState();
    state.topology.nodes = state.topology.nodes.filter((node) => node.id !== "synthesis");
    expect(() => serializeRunStateV1(state)).toThrow(/state node is absent from topology/);
  });

  it("rejects a dangling error-routing node reference", () => {
    const state = runState();
    state.errorRouting!.nodeId = "missing";
    expect(() => serializeRunStateV1(state)).toThrow(
      /error routing: node reference is absent from topology/,
    );
  });

  it("rejects a dangling background-agent trailing-node reference", () => {
    const state = runState();
    state.backgroundAgentTrailingNode!.nodeId = "missing";
    expect(() => serializeRunStateV1(state)).toThrow(
      /background-agent trailing node: node reference is absent from topology/,
    );
  });

  it.each(INVALID_TERMINAL_ACTIVE_COMBINATIONS)(
    "rejects $runStatus runs containing $nodeStatus nodes during serialization and parsing",
    ({ runStatus, nodeStatus }) => {
      const state = runState();
      state.status = runStatus;
      state.nodes[1].status = nodeStatus;
      delete state.backgroundAgentTrailingNode;

      expect(() => serializeRunStateV1(state)).toThrow(
        new RegExp(`status coherence: run ${runStatus}.*status ${nodeStatus}`),
      );
      expect(() => parseRunStateV1(JSON.stringify(state))).toThrow(
        new RegExp(`status coherence: run ${runStatus}.*status ${nodeStatus}`),
      );
    },
  );

  it.each([
    {
      runStatus: "queued" as const,
      nodeStatuses: ["pending", "pending"] as const,
      trailingStatus: "pending" as const,
    },
    {
      runStatus: "succeeded" as const,
      nodeStatuses: ["succeeded", "skipped"] as const,
      trailingStatus: "skipped" as const,
    },
    {
      runStatus: "cancelled" as const,
      nodeStatuses: ["succeeded", "cancelled"] as const,
      trailingStatus: "interrupted" as const,
    },
  ])("accepts a coherent $runStatus projection", ({
    runStatus,
    nodeStatuses,
    trailingStatus,
  }) => {
    const state = runState();
    state.status = runStatus;
    state.nodes[0].status = nodeStatuses[0];
    state.nodes[1].status = nodeStatuses[1];
    state.backgroundAgentTrailingNode!.status = trailingStatus;

    expect(parseRunStateV1(serializeRunStateV1(state))).toEqual(state);
  });

  it("accepts a failed run with failed and skipped nodes", () => {
    const state = runState();
    state.status = "failed";
    state.nodes[0].status = "failed";
    state.nodes[1].status = "skipped";
    state.backgroundAgentTrailingNode!.status = "cancelled";

    expect(parseRunStateV1(serializeRunStateV1(state))).toEqual(state);
  });

  it("applies terminal coherence to the background-agent trailing slot", () => {
    const state = runState();
    state.status = "failed";
    state.nodes[0].status = "failed";
    state.nodes[1].status = "skipped";
    state.backgroundAgentTrailingNode!.status = "waiting";

    expect(() => serializeRunStateV1(state)).toThrow(
      /status coherence: run failed.*background-agent trailing slot.*status waiting/,
    );
    expect(() => parseRunStateV1(JSON.stringify(state))).toThrow(
      /status coherence: run failed.*background-agent trailing slot.*status waiting/,
    );
  });

  it("rejects malformed serialized input", () => {
    expect(() => parseRunStateV1("not json")).toThrow("Invalid RunState v1 JSON.");
    expect(() => parseRunStateV1('{"schemaVersion":2}')).toThrow(/Invalid RunState v1/);
  });
});
