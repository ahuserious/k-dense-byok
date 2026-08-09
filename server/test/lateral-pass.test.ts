import { describe, expect, it, vi } from "vitest";
import { WorkflowBehaviorRegistry } from "../src/workflows/behavior-registry.ts";
import {
  DEFAULT_LATERAL_PASS_MODEL,
  LATERAL_PASS_BEHAVIOR,
  LateralPassError,
  registerLateralPassBehavior,
} from "../src/context/lateral-pass.ts";

function validPayload() {
  return {
    sourceSessionId: "session-source",
    userPrompt: "Finish the evidence-backed report.",
    goal: "Deliver the report without losing unresolved work.",
    openTodos: ["Verify citation A"],
    transcript: [
      { role: "user", content: "Prepare the report." },
      { role: "assistant", content: "Decision: use dataset B. TODO: verify citation A." },
    ],
  };
}

describe("lateral-pass behavior", () => {
  it("registers and dispatches a clean-window summary without compacting", async () => {
    const registry = new WorkflowBehaviorRegistry();
    const summarize = vi.fn().mockResolvedValue({
      summary: "Dataset B was selected; citation A remains unverified.",
      goal: "Deliver the evidence-backed report.",
      openTodos: [],
      decisions: ["Use dataset B"],
      constraints: ["Cite only verified evidence"],
    });
    const openCleanWindow = vi.fn().mockResolvedValue({ sessionId: "session-clean" });
    const registration = registerLateralPassBehavior({
      registry,
      summarize,
      openCleanWindow,
      env: {},
    });

    expect(registration.model).toBe(DEFAULT_LATERAL_PASS_MODEL);
    expect(registry.capabilities(LATERAL_PASS_BEHAVIOR)).toEqual(["lateral-pass"]);
    await expect(registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId: "run-lateral-pass",
      payload: validPayload(),
    })).resolves.toMatchObject({
      handled: true,
      sourceSessionId: "session-source",
      targetSessionId: "session-clean",
      compacted: false,
      model: DEFAULT_LATERAL_PASS_MODEL,
    });
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "session-source",
      model: DEFAULT_LATERAL_PASS_MODEL,
      openTodos: ["Verify citation A"],
    }));
    expect(openCleanWindow).toHaveBeenCalledWith({
      sourceSessionId: "session-source",
      compacted: false,
      summary: "Dataset B was selected; citation A remains unverified.",
      goal: "Deliver the report without losing unresolved work.",
      openTodos: ["Verify citation A"],
      decisions: ["Use dataset B"],
      constraints: ["Cite only verified evidence"],
    });
  });

  it("rejects malformed dispatch without a provider or session call", async () => {
    const registry = new WorkflowBehaviorRegistry();
    const summarize = vi.fn();
    const openCleanWindow = vi.fn();
    registerLateralPassBehavior({ registry, summarize, openCleanWindow, env: {} });

    await expect(registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId: "run-empty-transcript",
      payload: { ...validPayload(), transcript: [] },
    })).rejects.toBeInstanceOf(LateralPassError);
    expect(summarize).not.toHaveBeenCalled();
    expect(openCleanWindow).not.toHaveBeenCalled();
  });

  it("fails closed on a contradictory model summary before opening a window", async () => {
    const registry = new WorkflowBehaviorRegistry();
    const summarize = vi.fn().mockResolvedValue({ summary: "Only a summary" });
    const openCleanWindow = vi.fn();
    registerLateralPassBehavior({ registry, summarize, openCleanWindow, env: {} });

    await expect(registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId: "run-bad-summary",
      payload: validPayload(),
    })).rejects.toMatchObject({ code: "INVALID_MODEL_SUMMARY" });
    expect(summarize).toHaveBeenCalledOnce();
    expect(openCleanWindow).not.toHaveBeenCalled();
  });
});
