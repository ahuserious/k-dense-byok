import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function operationKey(runId: string, nodeId: string, auditIdentity: string): string {
  return createHash("sha256")
    .update(runId, "utf8")
    .update("\0")
    .update(nodeId, "utf8")
    .update("\0")
    .update(auditIdentity, "utf8")
    .digest("hex");
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expected}; stderr=${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) {
        clearTimeout(timeout);
        resolve(stdout);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Lock worker exited ${String(code)}; stderr=${stderr}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

function lockWorker(sandboxRoot: string, mode: "hold" | "resume"): ChildProcessWithoutNullStreams {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "workflows", "compaction-watcher-operation-store.ts"),
  ).href;
  const runId = "run-lock-recovery";
  const nodeId = "node-lock-recovery";
  const auditIdentity = "a".repeat(64);
  const key = operationKey(runId, nodeId, auditIdentity);
  const script = `
    import { FileCompactionWatcherOperationStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileCompactionWatcherOperationStore(${JSON.stringify(sandboxRoot)});
    await store.runExclusive(${JSON.stringify(key)}, async (transaction) => {
      if (!transaction.current) {
        transaction.compareAndSwap(undefined, {
          runId: ${JSON.stringify(runId)},
          nodeId: ${JSON.stringify(nodeId)},
          auditIdentity: ${JSON.stringify(auditIdentity)},
          phase: "restart-failed",
          workflowRevision: 7,
          recovery: {
            runId: ${JSON.stringify(runId)},
            checkpointId: "checkpoint-lock-recovery",
            restartToken: "restart-token-lock-recovery",
            verified: true,
            sideEffectSafety: "idempotent",
          },
        });
      }
      if (${JSON.stringify(mode)} === "hold") {
        process.stdout.write("LOCKED\\n");
        await new Promise(() => {});
      } else {
        process.stdout.write("RESUMED:" + transaction.current.phase + ":" + transaction.current.workflowRevision + "\\n");
      }
    });
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
}

describe("FileCompactionWatcherOperationStore stale lock recovery", () => {
  it("reclaims a killed owner's lock and preserves the phase for safe resume", async () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-lock-recovery-"));
    roots.push(sandboxRoot);
    const holder = lockWorker(sandboxRoot, "hold");
    await waitForOutput(holder, "LOCKED");

    const exited = waitForExit(holder);
    holder.kill(process.platform === "win32" ? undefined : "SIGKILL");
    await exited;

    const restarted = lockWorker(sandboxRoot, "resume");
    await expect(waitForOutput(restarted, "RESUMED:restart-failed:7")).resolves.toContain(
      "RESUMED:restart-failed:7",
    );
    await waitForExit(restarted);
  });
});
