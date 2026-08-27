import { describe, expect, it } from "vitest";

import {
  addDefaultNode,
  addWorkflowEdge,
  createDefaultWorkflowGraph,
} from "@/lib/dag-workflow-builder";
import { SAVED_WORKFLOW_DRAG_MIME } from "@/components/pipeline/saved-workflow-palette";
import {
  ABANDON_SAVED_WORKFLOW_INSERT_TYPE,
  ackMatchesLiveAttempt,
  applySavedWorkflowInsertToHostDocument,
  buildInsertSavedWorkflowPayload,
  formatInsertedSavedWorkflowStatus,
  insertedCountFromAck,
  iframeRelativeDropPoint,
  INSERT_SAVED_WORKFLOW_REFUSAL_REASONS,
  INSERT_SAVED_WORKFLOW_TYPE,
  insertSavedWorkflowRefusalReason,
  nextSavedWorkflowInsertAttemptToken,
  parseSavedWorkflowDragRaw,
  parseSavedWorkflowInsertAcceptedAck,
  parseSavedWorkflowInsertCancelledAck,
  parseSavedWorkflowInsertedAck,
  SAVED_WORKFLOW_INSERT_ACCEPTED_TYPE,
  SAVED_WORKFLOW_INSERT_CANCELLED_REASON,
  SAVED_WORKFLOW_INSERT_CONFIRM_STATUS,
  SAVED_WORKFLOW_INSERT_IN_PROGRESS_STATUS,
  SAVED_WORKFLOW_INSERT_TIMEOUT_STATUS,
  SAVED_WORKFLOW_INSERTING_STATUS,
} from "@/lib/insert-saved-workflow-host";

function twoAgentWorkflow(id: string, name: string) {
  const base = createDefaultWorkflowGraph(id, name);
  const added = addDefaultNode(base, "agent");
  const demoted = {
    ...added.graph,
    nodes: added.graph.nodes.map((node) => (
      node.id === "start" ? { ...node, terminal: false } : node
    )),
  };
  const edged = addWorkflowEdge(demoted, {
    from: "start",
    to: added.nodeId,
    condition: "always",
  });
  if (edged.error) throw new Error(edged.error);
  return edged.graph;
}

describe("BLD-24b · host insert-saved-workflow payload", () => {
  it("parses the palette's bare workflow id and a JSON payload", () => {
    expect(SAVED_WORKFLOW_DRAG_MIME).toBe("application/kady-saved-workflow");
    expect(parseSavedWorkflowDragRaw("child-workflow")).toBe("child-workflow");
    expect(parseSavedWorkflowDragRaw(JSON.stringify({
      workflowId: "child-workflow",
      revision: 4,
    }))).toBe("child-workflow");
    expect(parseSavedWorkflowDragRaw("")).toBeNull();
  });

  it("computes dropPoint relative to the iframe box", () => {
    expect(iframeRelativeDropPoint({ left: 100, top: 40 }, 340, 220)).toEqual({ x: 240, y: 180 });
  });

  it("builds the B9 insert-saved-workflow payload with nodes, edges, and dropPoint", () => {
    const graph = twoAgentWorkflow("child-workflow", "Child workflow");
    const payload = buildInsertSavedWorkflowPayload(
      {
        id: "child-workflow",
        revision: 4,
        graphSha256: "b".repeat(64),
        graph,
      },
      { x: 240, y: 180 },
      "swi-test-1",
      { nodes: [] },
    );

    expect(INSERT_SAVED_WORKFLOW_TYPE).toBe("insert-saved-workflow");
    expect(payload).toMatchObject({
      workflowId: "child-workflow",
      revision: 4,
      graphSha256: "b".repeat(64),
      dropPoint: { x: 240, y: 180 },
      attemptToken: "swi-test-1",
    });
    // BF-56: the host always declares a settlement (empty when current has no
    // terminals). Absent is reserved for the standalone engine path.
    expect(payload.settlement).toEqual({ connectsFromNodeIds: [] });
    expect(payload.nodes.map((node) => node.id).sort()).toEqual(["agent", "start"]);
    expect(payload.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "start", to: "agent" }),
      ]),
    );
    expect(payload.nodes.length).toBe(2);
  });

  it("declares terminal nodes as the settlement connectsFrom set (BF-56)", () => {
    const host = twoAgentWorkflow("host-workflow", "Host");
    const saved = twoAgentWorkflow("child-workflow", "Child");
    const payload = buildInsertSavedWorkflowPayload(
      {
        id: "child-workflow",
        revision: 1,
        graphSha256: "b".repeat(64),
        graph: saved,
      },
      { x: 10, y: 20 },
      "swi-settle-1",
      host,
    );
    const terminals = host.nodes.filter((node) => node.terminal === true).map((node) => node.id);
    expect(payload.settlement.connectsFromNodeIds).toEqual(terminals);
    expect(payload.settlement.connectsFromNodeIds.length).toBeGreaterThan(0);
  });

  it("stitches the saved workflow onto the host document so Save stays reachable", () => {
    const host = createDefaultWorkflowGraph("host-workflow", "Host");
    const saved = twoAgentWorkflow("child-workflow", "Child");
    const next = applySavedWorkflowInsertToHostDocument(host, "h".repeat(64), {
      id: "child-workflow",
      graphSha256: "c".repeat(64),
      graph: saved,
    });

    expect(host.nodes).toHaveLength(1);
    expect(saved.nodes).toHaveLength(2);
    expect(next.nodes).toHaveLength(3);
    expect(next.entryNodeId).toBe("start");
    expect(next.nodes.some((node) => node.id.startsWith("child-workflow-"))).toBe(true);
  });

  it("raises a tight host model-call cap so the inserted graph remains saveable", () => {
    const host = createDefaultWorkflowGraph("host-workflow", "Host");
    host.limits.maxModelCalls = 2;
    const saved = twoAgentWorkflow("child-workflow", "Child");
    const next = applySavedWorkflowInsertToHostDocument(host, "h".repeat(64), {
      id: "child-workflow",
      graphSha256: "c".repeat(64),
      graph: saved,
    });
    expect(next.nodes).toHaveLength(3);
    expect(next.limits.maxModelCalls).toBeGreaterThanOrEqual(next.nodes.length * 2);
  });

  it("parses accepted, inserted, and cancelled acks", () => {
    expect(SAVED_WORKFLOW_INSERTING_STATUS).toBe("Inserting…");
    expect(SAVED_WORKFLOW_INSERT_CONFIRM_STATUS).toBe("Confirm the insertion in the canvas");
    expect(SAVED_WORKFLOW_INSERT_TIMEOUT_STATUS).toMatch(/timed out/);
    expect(SAVED_WORKFLOW_INSERT_IN_PROGRESS_STATUS).toMatch(/already waiting/);
    expect(SAVED_WORKFLOW_INSERT_ACCEPTED_TYPE).toBe("builder.savedWorkflowInsertAccepted");
    expect(formatInsertedSavedWorkflowStatus(2)).toBe("Inserted 2 nodes");
    expect(insertedCountFromAck({
      workflowId: "child-workflow",
      nodeCount: 3,
      nodeIds: ["saved-a", "saved-b"],
      attemptToken: "swi-1-aaaa",
    })).toBe(2);
    expect(insertedCountFromAck({
      workflowId: "child-workflow",
      nodeCount: 7,
      nodeIds: [],
      attemptToken: "swi-1-aaaa",
    })).toBe(7);
    expect(parseSavedWorkflowInsertAcceptedAck({
      workflowId: "child-workflow",
      nodeCount: 2,
      attemptToken: "swi-1-aaaa",
    })).toEqual({ workflowId: "child-workflow", nodeCount: 2, attemptToken: "swi-1-aaaa" });
    expect(parseSavedWorkflowInsertedAck({
      workflowId: "child-workflow",
      nodeCount: 2,
      nodeIds: ["saved-a", "saved-b"],
      mode: "append",
      attemptToken: "swi-1-aaaa",
    })).toEqual({
      workflowId: "child-workflow",
      nodeCount: 2,
      nodeIds: ["saved-a", "saved-b"],
      attemptToken: "swi-1-aaaa",
    });
    expect(parseSavedWorkflowInsertCancelledAck({
      workflowId: "child-workflow",
      attemptToken: "swi-1-aaaa",
    })).toEqual({
      workflowId: "child-workflow",
      reason: SAVED_WORKFLOW_INSERT_CANCELLED_REASON,
      attemptToken: "swi-1-aaaa",
    });
    expect(parseSavedWorkflowInsertAcceptedAck({ nodeCount: 2 })).toBeNull();
    expect(parseSavedWorkflowInsertedAck({ nodeCount: 2 })).toBeNull();
    expect(parseSavedWorkflowInsertCancelledAck({})).toBeNull();
  });

  // BF-33. `workflowId` says WHICH WORKFLOW, not WHICH ATTEMPT.
  it("mints a distinct attempt token per drop and refuses an ack without one", () => {
    const first = nextSavedWorkflowInsertAttemptToken();
    const second = nextSavedWorkflowInsertAttemptToken();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^swi-\d+-[a-z0-9]+$/);

    // A tokenless reply is not a reply to any attempt this host posted.
    expect(parseSavedWorkflowInsertedAck({
      workflowId: "child-workflow",
      nodeCount: 3,
      nodeIds: ["saved-a", "saved-b"],
    })).toBeNull();
    expect(parseSavedWorkflowInsertAcceptedAck({
      workflowId: "child-workflow",
      nodeCount: 2,
    })).toBeNull();
    expect(parseSavedWorkflowInsertCancelledAck({
      workflowId: "child-workflow",
    })).toBeNull();
    expect(parseSavedWorkflowInsertedAck({
      workflowId: "child-workflow",
      nodeCount: 3,
      nodeIds: [],
      attemptToken: "",
    })).toBeNull();
  });

  it("matches an ack against the LIVE attempt, not merely the same workflow", () => {
    const live = { workflowId: "child-workflow", attemptToken: nextSavedWorkflowInsertAttemptToken() };
    expect(ackMatchesLiveAttempt(live, {
      workflowId: "child-workflow",
      attemptToken: live.attemptToken,
    })).toBe(true);
    // Same saved workflow, earlier attempt — the exact BF-33 frame.
    expect(ackMatchesLiveAttempt(live, {
      workflowId: "child-workflow",
      attemptToken: "swi-1-stale",
    })).toBe(false);
    expect(ackMatchesLiveAttempt(live, {
      workflowId: "other-workflow",
      attemptToken: live.attemptToken,
    })).toBe(false);
    expect(ackMatchesLiveAttempt(null, {
      workflowId: "child-workflow",
      attemptToken: live.attemptToken,
    })).toBe(false);
  });

  it("names the host→frame command that ends an attempt", () => {
    expect(ABANDON_SAVED_WORKFLOW_INSERT_TYPE).toBe("abandon-saved-workflow-insert");
  });

  it.each(INSERT_SAVED_WORKFLOW_REFUSAL_REASONS)(
    "classifies refusal reason %s",
    (reason) => {
      const validNodes = [
        { id: "saved-a" },
        { id: "saved-b" },
      ];
      const base = {
        workflowId: "child-workflow",
        revision: 1,
        graphSha256: "c".repeat(64),
      };
      const canvas = new Set(["host-only"]);
      const payloadByReason: Record<typeof INSERT_SAVED_WORKFLOW_REFUSAL_REASONS[number], unknown> = {
        "malformed-payload": { workflowId: "child-workflow" },
        "payload-duplicate-node-id": {
          ...base,
          nodes: [{ id: "saved-a" }, { id: "saved-a" }],
          edges: [],
        },
        "payload-duplicate-edge-id": {
          ...base,
          nodes: validNodes,
          edges: [
            { id: "dup", from: "saved-a", to: "saved-b" },
            { id: "dup", from: "saved-a", to: "saved-b" },
          ],
        },
        "payload-dangling-edge": {
          ...base,
          nodes: validNodes,
          edges: [{ id: "ghost", from: "saved-a", to: "ghost" }],
        },
        "payload-cross-canvas-edge": {
          ...base,
          nodes: validNodes,
          edges: [{ id: "cross", from: "host-only", to: "saved-a" }],
        },
      };
      expect(insertSavedWorkflowRefusalReason(
        payloadByReason[reason],
        reason === "payload-cross-canvas-edge" ? canvas : undefined,
      )).toBe(reason);
      expect(parseSavedWorkflowInsertCancelledAck({
        workflowId: "child-workflow",
        reason,
        attemptToken: "swi-9-refusal",
      })).toEqual({ workflowId: "child-workflow", reason, attemptToken: "swi-9-refusal" });
    },
  );
});
