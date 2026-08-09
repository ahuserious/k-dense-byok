import { describe, expect, it, vi } from "vitest";
import {
  WorkflowBehaviorRegistry,
  WorkflowBehaviorRegistryError,
} from "../src/workflows/index.ts";

describe("workflow behavior registry v1", () => {
  it("registers and dispatches a handler by typed capability", async () => {
    const registry = new WorkflowBehaviorRegistry();
    const handler = vi.fn().mockResolvedValue({ handled: true, detail: "restarted" });
    registry.register("watcher-rescue", ["restart-workflow", "lateral-pass"], handler);

    expect(registry.version).toBe(1);
    expect(registry.has("watcher-rescue")).toBe(true);
    expect(registry.capabilities("watcher-rescue")).toEqual([
      "restart-workflow",
      "lateral-pass",
    ]);
    await expect(registry.dispatch("watcher-rescue", {
      capability: "restart-workflow",
      runId: "run-1",
    })).resolves.toEqual({ handled: true, detail: "restarted" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects duplicate registrations and invalid capability lists", () => {
    const registry = new WorkflowBehaviorRegistry();
    registry.register("watcher-rescue", ["restart-workflow"], () => ({ handled: true }));

    expect(() => registry.register(
      "watcher-rescue",
      ["lateral-pass"],
      () => ({ handled: true }),
    )).toThrowError(expect.objectContaining({ code: "ALREADY_REGISTERED" }));
    expect(() => registry.register("empty", [], () => ({ handled: true }))).toThrowError(
      expect.objectContaining({ code: "INVALID_CAPABILITIES" }),
    );
  });

  it("fails closed for unknown behaviors and undeclared capabilities", async () => {
    const registry = new WorkflowBehaviorRegistry();
    registry.register("watcher-rescue", ["restart-workflow"], () => ({ handled: true }));

    await expect(registry.dispatch("missing", {
      capability: "restart-workflow",
      runId: "run-1",
    })).rejects.toMatchObject({ code: "NOT_REGISTERED" });
    await expect(registry.dispatch("watcher-rescue", {
      capability: "escalate-fix-redeploy",
      runId: "run-1",
    })).rejects.toMatchObject({ code: "CAPABILITY_NOT_REGISTERED" });
  });

  it("uses a dedicated typed error", () => {
    const registry = new WorkflowBehaviorRegistry();
    expect(() => registry.register("Bad Name", ["lateral-pass"], () => ({ handled: true })))
      .toThrow(WorkflowBehaviorRegistryError);
  });
});
