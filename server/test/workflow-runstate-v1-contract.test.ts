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

  it("rejects malformed serialized input", () => {
    expect(() => parseRunStateV1("not json")).toThrow("Invalid RunState v1 JSON.");
    expect(() => parseRunStateV1('{"schemaVersion":2}')).toThrow(/Invalid RunState v1/);
  });
});
