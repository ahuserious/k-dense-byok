// danbot-byok — verify.test.ts
//
// Proves the runtime 3x adversarial verifier (checklist Phase 6) using an INJECTED fake
// ChatFn, so the whole module is exercised with ZERO live model calls:
//   - 3 PASS  -> passed:true, exactly 3 chat() calls (all passes run).
//   - FAIL on pass 2 -> passed:false, SHORT-CIRCUITS at 2 calls (pass 3 never runs).
//   - verdict parsing handles both 'PASS' and 'FAIL: <reasons>' (tail-of-reply).
//   - per-pass cost is summed AND ledgered: a `verify` row lands in costs.jsonl.
//
// The cost test writes to a real (temp) project's ledger via the same resolvePaths path
// the app uses; recordRun mkdirs the runs dir, so no project seeding is needed.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { runAdversarialVerification, parseVerdict, type ChatFn } from "../src/agent/verify.ts";
import { resolvePaths } from "../src/projects.ts";
import { sessionCostSummary, type CostEntry } from "../src/cost/ledger.ts";

/**
 * Build a fake ChatFn that returns a scripted reply text per call and counts invocations.
 * Each reply carries a small fixed cost so the summed/ledgered cost is predictable.
 */
function fakeChat(replyTexts: string[], costPerCall = 0.01) {
  const calls: Array<{ model: string; messages: { role: string; content: string }[] }> = [];
  const chat: ChatFn = async (req) => {
    const text = replyTexts[calls.length] ?? "PASS";
    calls.push({ model: req.model, messages: req.messages });
    return { text, costUsd: costPerCall, tokensIn: 10, tokensOut: 5 };
  };
  return { chat, calls };
}

describe("runAdversarialVerification", () => {
  it("3 PASS -> passed:true and runs all 3 passes", async () => {
    const { chat, calls } = fakeChat(["looks good\nPASS", "fine\nPASS", "ok\nPASS"]);
    const result = await runAdversarialVerification({
      goal: "g",
      output: "o",
      projectId: "verify-test-pass",
      sessionId: "sess-verify-pass",
      chat,
    });
    expect(result.passed).toBe(true);
    expect(result.passes).toHaveLength(3);
    expect(result.passes.every((p) => p.verdict === "PASS")).toBe(true);
    expect(calls).toHaveLength(3); // all passes ran
    expect(result.costUsd).toBeCloseTo(0.03, 6); // 3 * 0.01
  });

  it("FAIL on pass 2 -> passed:false and short-circuits at 2 calls", async () => {
    // Pass 3's text would be PASS, but it must never be requested.
    const { chat, calls } = fakeChat([
      "good\nPASS",
      "missing requirement X\nFAIL: missing requirement X",
      "ok\nPASS",
    ]);
    const result = await runAdversarialVerification({
      goal: "g",
      output: "o",
      projectId: "verify-test-fail",
      sessionId: "sess-verify-fail",
      chat,
    });
    expect(result.passed).toBe(false);
    expect(result.passes).toHaveLength(2); // stopped after the FAIL
    expect(result.passes[0].verdict).toBe("PASS");
    expect(result.passes[1].verdict).toBe("FAIL");
    expect(calls).toHaveLength(2); // pass 3 never ran — short-circuited
    expect(result.costUsd).toBeCloseTo(0.02, 6); // only the 2 passes that ran
  });

  it("each pass uses a FRESH message array (no carry-over)", async () => {
    const { chat, calls } = fakeChat(["PASS", "PASS", "PASS"]);
    await runAdversarialVerification({
      goal: "g",
      output: "o",
      projectId: "verify-test-fresh",
      sessionId: "sess-verify-fresh",
      chat,
    });
    // Every call gets a clean 2-message array (system + user); none accumulates history.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.messages).toHaveLength(2);
      expect(call.messages[0].role).toBe("system");
      expect(call.messages[1].role).toBe("user");
    }
  });

  it("honors a custom pass count", async () => {
    const { chat, calls } = fakeChat(["PASS", "PASS"]);
    const result = await runAdversarialVerification({
      goal: "g",
      output: "o",
      projectId: "verify-test-count",
      sessionId: "sess-verify-count",
      passes: 2,
      chat,
    });
    expect(result.passed).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("parseVerdict", () => {
  it("reads PASS from the tail", () => {
    expect(parseVerdict("some critique\nPASS").verdict).toBe("PASS");
  });
  it("reads FAIL: <reasons> from the tail", () => {
    const parsed = parseVerdict("critique here\nFAIL: claim 3 is unsupported");
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.critique).toContain("claim 3 is unsupported");
  });
  it("tolerates markdown decoration around the verdict", () => {
    expect(parseVerdict("review\n**PASS**").verdict).toBe("PASS");
  });
  it("fails closed on a missing/unparseable verdict", () => {
    expect(parseVerdict("I think it's mostly fine but I'm not sure.").verdict).toBe("FAIL");
  });
});

describe("verify cost ledgering", () => {
  it("sums cost and writes a `verify` row per pass to costs.jsonl", async () => {
    const PROJECT = "verify-ledger-test";
    const SID = "sess-verify-ledger";
    // Clean any prior run so the assertions count only this test's rows.
    const runsDir = resolvePaths(PROJECT).runsDir;
    fs.rmSync(path.join(runsDir, SID), { recursive: true, force: true });

    const { chat } = fakeChat(["PASS", "PASS", "PASS"], 0.005);
    const result = await runAdversarialVerification({
      goal: "ship the feature",
      output: "the feature is shipped",
      projectId: PROJECT,
      sessionId: SID,
      chat,
    });

    expect(result.costUsd).toBeCloseTo(0.015, 6); // 3 * 0.005

    // The rows actually landed on disk, bucketed under role 'verify'.
    const costsFile = path.join(runsDir, SID, "costs.jsonl");
    const rows = fs
      .readFileSync(costsFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CostEntry);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.role === "verify")).toBe(true);
    expect(rows.every((r) => r.costStatus === "billed")).toBe(true);

    // And the ledger summary buckets it into verifyUsd, matching the returned sum.
    const summary = sessionCostSummary(SID, PROJECT);
    expect(summary.verifyUsd).toBeCloseTo(0.015, 6);
    expect(summary.totalUsd).toBeCloseTo(0.015, 6);
  });
});
