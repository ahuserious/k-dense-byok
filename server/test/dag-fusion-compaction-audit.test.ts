import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  DAG_FUSION_COMPACTION_AUDIT_MAX_BYTES,
  DagFusionCompactionAuditReadError,
  dagFusionCompactionAuditPath,
  installDagFusionCompactionAudit,
  readTrustedDagFusionCompactionAudit,
} from "../pi-packages/dag-fusion-drive/compaction-audit.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-compaction-audit-"));
  temporaryRoots.push(root);
  return root;
}

function fakePi(): {
  pi: Pick<ExtensionAPI, "on">;
  handlers: Map<string, (event: unknown) => unknown>;
} {
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    pi: {
      on(event: string, handler: (event: unknown) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as Pick<ExtensionAPI, "on">,
    handlers,
  };
}

function beforeEvent(overrides: Record<string, unknown> = {}): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-top-secret",
      messagesToSummarize: [{ role: "user", content: "transcript-top-secret" }],
      turnPrefixMessages: [{ role: "assistant", content: "prefix-top-secret" }],
      isSplitTurn: false,
      tokensBefore: 12_345,
      previousSummary: "previous-summary-top-secret",
      fileOps: {
        read: new Set(["secret/read.txt"]),
        written: new Set(["secret/written.txt"]),
        edited: new Set(["secret/edited.txt"]),
      },
      settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 8_192 },
      ...(overrides.preparation as object | undefined),
    },
    branchEntries: [{ type: "message", message: "branch-top-secret" }] as never[],
    customInstructions: "custom-instructions-top-secret",
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  } as SessionBeforeCompactEvent;
}

function afterEvent(overrides: Record<string, unknown> = {}): SessionCompactEvent {
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-entry",
      parentId: "parent-entry",
      timestamp: new Date().toISOString(),
      summary: "new-summary-top-secret",
      firstKeptEntryId: "entry-top-secret",
      tokensBefore: 12_345,
      ...(overrides.compactionEntry as object | undefined),
    },
    fromExtension: false,
    reason: "threshold",
    willRetry: false,
    ...overrides,
  } as SessionCompactEvent;
}

function childAudit(root: string, runId = "child-run-1") {
  const { pi, handlers } = fakePi();
  expect(installDagFusionCompactionAudit(pi, {
    env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUN_ID: runId },
    sandboxRoot: root,
  })).toBe(true);
  return {
    before: handlers.get("session_before_compact")!,
    after: handlers.get("session_compact")!,
    path: dagFusionCompactionAuditPath(root, runId),
    runId,
  };
}

describe("dag-fusion-drive child compaction audit", () => {
  it("records valid pre/post checks without persisting transcript or summary contents", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);

    expect(audit.before(beforeEvent())).toBeUndefined();
    expect(audit.after(afterEvent())).toBeUndefined();

    expect(readTrustedDagFusionCompactionAudit(root, audit.runId)).toEqual({
      occurred: true,
      checks: [
        { attempt: 1, phase: "pre", passed: true },
        { attempt: 1, phase: "post", passed: true },
      ],
    });
    const raw = fs.readFileSync(audit.path, "utf8");
    for (const secret of [
      "entry-top-secret",
      "transcript-top-secret",
      "prefix-top-secret",
      "branch-top-secret",
      "previous-summary-top-secret",
      "custom-instructions-top-secret",
      "new-summary-top-secret",
      "secret/read.txt",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("cancels and attests an invalid pre-compaction shape", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);
    const event = beforeEvent({
      preparation: { ...beforeEvent().preparation, firstKeptEntryId: "" },
    });

    expect(audit.before(event)).toEqual({ cancel: true });
    expect(readTrustedDagFusionCompactionAudit(root, audit.runId)).toEqual({
      occurred: true,
      checks: [{
        attempt: 1,
        phase: "pre",
        passed: false,
        errorCode: "PRE_LIMIT_EXCEEDED",
      }],
    });
  });

  it("fails a mismatched post-compaction attestation", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);
    audit.before(beforeEvent());
    audit.after(afterEvent({
      compactionEntry: { ...afterEvent().compactionEntry, tokensBefore: 12_346 },
    }));

    expect(readTrustedDagFusionCompactionAudit(root, audit.runId).checks).toEqual([
      { attempt: 1, phase: "pre", passed: true },
      { attempt: 1, phase: "post", passed: false, errorCode: "POST_MISMATCH" },
    ]);
  });

  it("fails an invalid post-compaction structure", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);
    audit.before(beforeEvent());
    audit.after(afterEvent({
      compactionEntry: { ...afterEvent().compactionEntry, summary: "" },
    }));

    expect(readTrustedDagFusionCompactionAudit(root, audit.runId).checks).toEqual([
      { attempt: 1, phase: "pre", passed: true },
      {
        attempt: 1,
        phase: "post",
        passed: false,
        errorCode: "POST_LIMIT_EXCEEDED",
      },
    ]);
  });

  it("synthesizes a failed post-check when a valid pre-check never completes", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);
    audit.before(beforeEvent());

    expect(readTrustedDagFusionCompactionAudit(root, audit.runId).checks).toEqual([
      { attempt: 1, phase: "pre", passed: true },
      { attempt: 1, phase: "post", passed: false, errorCode: "POST_MISSING" },
    ]);
  });

  it("creates only a header and reports no checks when no compaction occurred", () => {
    const root = temporaryRoot();
    const audit = childAudit(root);
    expect(readTrustedDagFusionCompactionAudit(root, audit.runId)).toEqual({
      occurred: false,
      checks: [],
    });
  });

  it("does nothing outside the exact pi-subagents child environment", () => {
    const root = temporaryRoot();
    const { pi, handlers } = fakePi();
    expect(installDagFusionCompactionAudit(pi, {
      env: { PI_SUBAGENT_CHILD: "true", PI_SUBAGENT_RUN_ID: "not-a-child" },
      sandboxRoot: root,
    })).toBe(false);
    expect(handlers.size).toBe(0);
    expect(fs.existsSync(path.join(root, ".kady"))).toBe(false);
  });

  it("rejects symlinked audit directories and oversized sidecars", () => {
    const symlinkRoot = temporaryRoot();
    const outside = temporaryRoot();
    fs.symlinkSync(outside, path.join(symlinkRoot, ".kady"));
    const { pi } = fakePi();
    expect(() => installDagFusionCompactionAudit(pi, {
      env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUN_ID: "unsafe-run" },
      sandboxRoot: symlinkRoot,
    })).toThrowError(DagFusionCompactionAuditReadError);
    expect(fs.readdirSync(outside)).toEqual([]);

    const sizeRoot = temporaryRoot();
    const audit = childAudit(sizeRoot, "oversized-run");
    fs.appendFileSync(audit.path, "x".repeat(DAG_FUSION_COMPACTION_AUDIT_MAX_BYTES));
    expect(() => readTrustedDagFusionCompactionAudit(sizeRoot, audit.runId)).toThrowError(
      expect.objectContaining({ code: "AUDIT_TOO_LARGE" }),
    );
  });

  it.runIf(process.platform !== "win32")("rejects a sidecar readable by group or other users", () => {
    const root = temporaryRoot();
    const audit = childAudit(root, "permissive-run");
    fs.chmodSync(audit.path, 0o644);

    expect(() => readTrustedDagFusionCompactionAudit(root, audit.runId)).toThrowError(
      expect.objectContaining({ code: "AUDIT_PATH_UNSAFE" }),
    );
  });
});
