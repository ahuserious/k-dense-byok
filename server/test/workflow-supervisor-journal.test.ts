import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_WORKFLOW_SUPERVISOR_RECORDS,
  MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES,
  WorkflowSupervisorJournal,
  WorkflowSupervisorJournalError,
  type PrepareWorkflowSupervisorOperationInput,
} from "../src/workflows/supervisor/journal.ts";

const REQUEST_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const RESERVATION_ID = `wbres_${"c".repeat(32)}`;

let temporaryRoot: string;
let stateDirectory: string;
let now: number;
let journal: WorkflowSupervisorJournal;

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-workflow-supervisor-"));
  stateDirectory = path.join(temporaryRoot, "journal");
  now = 1_000;
  journal = new WorkflowSupervisorJournal({ stateDirectory, now: () => now });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function prepareInput(
  operationId: string,
  overrides: Partial<PrepareWorkflowSupervisorOperationInput> = {},
): PrepareWorkflowSupervisorOperationInput {
  return {
    operationId,
    requestDigest: REQUEST_DIGEST,
    kind: "pi-subagent",
    projectId: "test-project",
    backendEpoch: "backend-epoch-1",
    ownerRunId: "wrun_11111111111111111111111111111111",
    nodeId: "research-node",
    ...overrides,
  };
}

function recordFile(operationId: string): string {
  return path.join(stateDirectory, `${operationId}.json`);
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowSupervisorJournalError);
    expect((error as WorkflowSupervisorJournalError).code).toBe(code);
  }
}

describe("workflow supervisor journal", () => {
  it("bounds durable replay records and fails closed instead of growing forever", () => {
    journal = new WorkflowSupervisorJournal({
      stateDirectory,
      now: () => now,
      maximumRecords: 2,
    });
    journal.prepare(prepareInput("bounded-one"));
    journal.prepare(prepareInput("bounded-two"));
    expectCode(() => journal.prepare(prepareInput("bounded-three")), "TOO_LARGE");
    expect(journal.prepare(prepareInput("bounded-one"))).toEqual(
      journal.snapshot("bounded-one"),
    );
    expect(DEFAULT_MAX_WORKFLOW_SUPERVISOR_RECORDS).toBeGreaterThan(2);
  });

  it("durably advances one operation while keeping prepare and receipts idempotent", () => {
    const input = prepareInput("dagcall_1111", {
      executionId: "dagx_1111",
      slotId: "research-iteration-1",
      reservationId: RESERVATION_ID,
    });
    const prepared = journal.prepare(input);
    expect(prepared).toMatchObject({ state: "prepared", preparedAt: 1_000, updatedAt: 1_000 });
    expect(journal.prepare(input)).toEqual(prepared);

    const stored = JSON.parse(fs.readFileSync(recordFile(input.operationId), "utf8"));
    expect(stored).toEqual(prepared);
    expect(stored).not.toHaveProperty("prompt");
    expect(stored).not.toHaveProperty("result");
    expect(fs.readdirSync(stateDirectory).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(recordFile(input.operationId)).mode & 0o077).toBe(0);
      expect(fs.statSync(stateDirectory).mode & 0o077).toBe(0);
    }

    expectCode(
      () => journal.prepare({ ...input, requestDigest: OTHER_DIGEST }),
      "CONFLICT",
    );

    now += 1;
    const running = journal.markRunning(input.operationId, {
      ownerId: "async-run-1",
      pid: 4242,
      processInstanceId: "runner-instance-1",
    });
    expect(running).toMatchObject({
      state: "running",
      running: { ownerId: "async-run-1", pid: 4242, startedAt: 1_001 },
    });
    expect(journal.markRunning(input.operationId, {
      ownerId: "async-run-1",
      pid: 4242,
      processInstanceId: "runner-instance-1",
    })).toEqual(running);

    now += 1;
    const settled = journal.recordSettlement(input.operationId, {
      settlementId: OTHER_DIGEST,
      status: "completed",
      usageComplete: true,
    });
    expect(settled.settlement).toEqual({
      settlementId: OTHER_DIGEST,
      status: "completed",
      usageComplete: true,
      settledAt: 1_002,
    });

    now += 1;
    const terminal = journal.markTerminal(input.operationId, {
      outcome: "completed",
      code: "TERMINAL_PROOF_OBSERVED",
      proofSha256: REQUEST_DIGEST,
    });
    expect(terminal).toMatchObject({ state: "terminal", updatedAt: 1_003 });
    expect(journal.markTerminal(input.operationId, {
      outcome: "completed",
      code: "TERMINAL_PROOF_OBSERVED",
      proofSha256: REQUEST_DIGEST,
    })).toEqual(terminal);
    expectCode(
      () => journal.markTerminal(input.operationId, {
        outcome: "failed",
        code: "DIFFERENT_TERMINAL",
      }),
      "CONFLICT",
    );

    const snapshot = journal.snapshot(input.operationId)!;
    snapshot.state = "prepared";
    expect(journal.snapshot(input.operationId)?.state).toBe("terminal");
    expect(journal.list().map((record) => record.operationId)).toEqual([input.operationId]);
  });

  it("keeps unavailable execution, slot, and reservation identities absent", () => {
    const input = prepareInput("dagcall_minimal");
    const record = journal.prepare(input);
    expect(record).not.toHaveProperty("executionId");
    expect(record).not.toHaveProperty("slotId");
    expect(record).not.toHaveProperty("reservationId");
    expect(JSON.parse(fs.readFileSync(recordFile(input.operationId), "utf8")))
      .not.toHaveProperty("reservationId");
  });

  it("keeps a prepared settlement replayable and refuses a receipt that disagrees", () => {
    const input = prepareInput("op-write-ahead");
    journal.prepare(input);
    journal.markRunning(input.operationId, { ownerId: "async-run", pid: 6001 });
    const pending = {
      settlementId: OTHER_DIGEST,
      status: "aborted" as const,
      usageComplete: true,
      budget: {
        status: "aborted",
        reason: "dag-fusion:caller-aborted:cancelled:usage-observed",
        usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 140, cost: 0.25 },
      },
    };
    journal.prepareSettlement(input.operationId, pending);
    expect(journal.snapshot(input.operationId)).toMatchObject({
      state: "running",
      pendingSettlement: pending,
    });

    // Idempotent replay of the identical intent, conflict on a different one.
    journal.prepareSettlement(input.operationId, pending);
    expect(() => journal.prepareSettlement(input.operationId, {
      ...pending,
      budget: { ...pending.budget, usage: { ...pending.budget.usage, cost: 9 } },
    })).toThrowError("already prepared a different settlement");
    expect(() => journal.recordSettlement(input.operationId, {
      settlementId: REQUEST_DIGEST,
      status: "aborted",
      usageComplete: true,
    })).toThrowError("settled differently from its prepared settlement");

    // A supervisor that died here leaves the obligation visible to the next one.
    now += 1;
    expect(journal.recoverStartup()).toMatchObject({
      quarantined: [input.operationId],
      settlementPending: [input.operationId],
    });

    journal.recordSettlement(input.operationId, {
      settlementId: pending.settlementId,
      status: pending.status,
      usageComplete: pending.usageComplete,
    });
    now += 1;
    expect(journal.recoverStartup().settlementPending).toEqual([]);
  });

  it("refuses a settlement prepared before the operation is durably running", () => {
    const input = prepareInput("op-write-ahead-early");
    journal.prepare(input);
    expect(() => journal.prepareSettlement(input.operationId, {
      settlementId: OTHER_DIGEST,
      status: "aborted",
      usageComplete: true,
      budget: { status: "aborted", reason: "dag-fusion:caller-aborted:cancelled:usage-missing" },
    })).toThrowError("cannot prepare settlement from prepared");
  });

  it("recovers prepared work as unstarted and running work as quarantined", () => {
    journal.prepare(prepareInput("op-prepared"));
    journal.prepare(prepareInput("op-running", { kind: "hosted-fusion" }));
    journal.prepare(prepareInput("op-terminal"));
    journal.prepare(prepareInput("op-quarantined"));

    journal.markRunning("op-running", { ownerId: "fusion-worker", pid: 5001 });
    journal.markRunning("op-terminal", { ownerId: "async-run-terminal", pid: 5002 });
    journal.recordSettlement("op-terminal", {
      settlementId: OTHER_DIGEST,
      status: "completed",
      usageComplete: true,
    });
    journal.markTerminal("op-terminal", { outcome: "completed", code: "OBSERVED" });
    journal.markRunning("op-quarantined", { ownerId: "async-run-quarantine", pid: 5003 });
    journal.quarantine("op-quarantined", { reasonCode: "CANCEL_ACK_TIMEOUT" });

    now += 1;
    expect(journal.recoverStartup()).toEqual({
      terminalUnstarted: ["op-prepared"],
      quarantined: ["op-running"],
      settlementPending: [],
    });
    expect(journal.snapshot("op-prepared")).toMatchObject({
      state: "terminal",
      terminal: {
        outcome: "unstarted",
        code: "STARTUP_RECOVERY_UNSTARTED",
      },
    });
    expect(journal.snapshot("op-running")).toMatchObject({
      state: "quarantined",
      quarantine: { reasonCode: "STARTUP_RECOVERY_RUNNING_UNCERTAIN" },
    });
    expect(journal.snapshot("op-terminal")?.state).toBe("terminal");
    expect(journal.snapshot("op-quarantined")?.state).toBe("quarantined");
    expect(journal.recoverStartup()).toEqual({
      terminalUnstarted: [],
      quarantined: [],
      settlementPending: [],
    });
  });

  it("never records terminal usage for work that was not durably running", () => {
    const input = prepareInput("never-started-settlement");
    journal.prepare(input);

    expectCode(
      () => journal.recordSettlement(input.operationId, {
        settlementId: OTHER_DIGEST,
        status: "completed",
        usageComplete: true,
      }),
      "CONFLICT",
    );
    expect(journal.recoverStartup()).toEqual({
      terminalUnstarted: [input.operationId],
      quarantined: [],
      settlementPending: [],
    });
    const recovered = journal.snapshot(input.operationId);
    expect(recovered).toMatchObject({
      state: "terminal",
      terminal: { outcome: "unstarted" },
    });
    expect(recovered).not.toHaveProperty("settlement");
  });

  it.skipIf(process.platform === "win32")(
    "fails a journal transition when POSIX directory fsync fails",
    () => {
      const originalFsyncSync = fs.fsyncSync;
      let directoryFsyncCalls = 0;
      const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) {
          directoryFsyncCalls += 1;
          throw Object.assign(new Error("simulated directory fsync failure"), {
            code: "EIO",
          });
        }
        originalFsyncSync(descriptor);
      });

      const input = prepareInput("directory-fsync-failure");
      expect(() => journal.prepare(input))
        .toThrow("simulated directory fsync failure");
      const callsAfterFirstFailure = directoryFsyncCalls;
      expect(callsAfterFirstFailure).toBeGreaterThan(0);

      expect(() => journal.prepare(input))
        .toThrow("simulated directory fsync failure");
      expect(directoryFsyncCalls).toBeGreaterThan(callsAfterFirstFailure);

      fsyncSpy.mockRestore();
      expect(journal.prepare(input).state).toBe("prepared");
    },
  );

  it("enforces the state machine and rejects content-bearing input", () => {
    const input = prepareInput("strict-op");
    expectCode(
      () => journal.prepare({ ...input, prompt: "secret" } as unknown as PrepareWorkflowSupervisorOperationInput),
      "INVALID_ARGUMENT",
    );
    journal.prepare(input);
    expectCode(
      () => journal.markTerminal(input.operationId, { outcome: "completed", code: "IMPOSSIBLE" }),
      "CONFLICT",
    );
    expectCode(
      () => journal.quarantine(input.operationId, { reasonCode: "NOT_RUNNING" }),
      "CONFLICT",
    );
    journal.markRunning(input.operationId, { ownerId: "owner" });
    expectCode(
      () => journal.markTerminal(input.operationId, {
        outcome: "completed",
        code: "MISSING_SETTLEMENT",
      }),
      "CONFLICT",
    );
    expectCode(
      () => journal.recordSettlement(input.operationId, {
        settlementId: OTHER_DIGEST,
        status: "completed",
        usageComplete: false,
      }),
      "INVALID_ARGUMENT",
    );
    expectCode(
      () => journal.markRunning(input.operationId, {
        ownerId: "owner",
        processInstanceId: "x".repeat(257),
      }),
      "INVALID_ARGUMENT",
    );
  });

  it("fails closed on corrupt, oversized, symlinked, and non-regular records", () => {
    const corrupt = prepareInput("corrupt-op");
    journal.prepare(corrupt);
    const parsed = JSON.parse(fs.readFileSync(recordFile(corrupt.operationId), "utf8"));
    fs.writeFileSync(recordFile(corrupt.operationId), JSON.stringify({ ...parsed, prompt: "leak" }));
    expectCode(() => journal.snapshot(corrupt.operationId), "CORRUPT");

    const oversized = prepareInput("oversized-op");
    journal.prepare(oversized);
    fs.writeFileSync(
      recordFile(oversized.operationId),
      Buffer.alloc(MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES + 1, "x"),
    );
    expectCode(() => journal.snapshot(oversized.operationId), "TOO_LARGE");

    const nonRegular = prepareInput("directory-op");
    journal.prepare(nonRegular);
    fs.unlinkSync(recordFile(nonRegular.operationId));
    fs.mkdirSync(recordFile(nonRegular.operationId));
    expectCode(() => journal.snapshot(nonRegular.operationId), "CORRUPT");
    fs.rmSync(recordFile(nonRegular.operationId), { recursive: true });

    if (process.platform !== "win32") {
      const linked = prepareInput("symlink-op");
      journal.prepare(linked);
      const target = path.join(temporaryRoot, "target.json");
      fs.writeFileSync(target, "{}", { mode: 0o600 });
      fs.unlinkSync(recordFile(linked.operationId));
      fs.symlinkSync(target, recordFile(linked.operationId));
      expectCode(() => journal.snapshot(linked.operationId), "CORRUPT");
    }
  });
});
