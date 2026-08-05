import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SUPERVISOR_STATE_FILE,
  readWorkflowSupervisorRuntimeState,
  workflowSupervisorFallbackSocketDirectory,
  workflowSupervisorProcessMayBeAlive,
  type WorkflowSupervisorRuntimePaths,
} from "../src/workflows/supervisor/runtime.ts";

function waitForReady(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for supervisor readiness: ${stderr()}`));
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "kady-workflow-supervisor-ready"
      ) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `Supervisor exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr()}`,
      ));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, stderr: () => string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for supervisor exit: ${stderr()}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe.skipIf(process.platform === "win32")(
  "workflow supervisor detached entrypoint",
  () => {
    it("publishes private runtime state and removes only its own state/socket after SIGTERM", async () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-entry-"));
      const stateDirectory = path.join(temporaryRoot, "state");
      const socketPath = path.join(temporaryRoot, "supervisor.sock");
      let child: ChildProcess | undefined;
      let stderrText = "";
      const launchToken = "c".repeat(64);
      try {
        child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/workflows/supervisor/entry.ts",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              KADY_WORKFLOW_SUPERVISOR_DIR: stateDirectory,
              KADY_WORKFLOW_SUPERVISOR_SOCKET: socketPath,
              KADY_WORKFLOW_SUPERVISOR_TOKEN: launchToken,
              KADY_PI_AGENT_DIR: path.join(temporaryRoot, "pi-agent"),
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        child.stderr?.on("data", (chunk) => {
          stderrText += String(chunk).slice(0, 8_192);
        });
        await waitForReady(child, () => stderrText);

        const paths: WorkflowSupervisorRuntimePaths = {
          stateDir: stateDirectory,
          stateFile: path.join(stateDirectory, WORKFLOW_SUPERVISOR_STATE_FILE),
          launchLock: path.join(stateDirectory, "launch.lock"),
          socketPath,
          stdoutLog: path.join(stateDirectory, "supervisor.stdout.log"),
          stderrLog: path.join(stateDirectory, "supervisor.stderr.log"),
        };

        const runtimeState = readWorkflowSupervisorRuntimeState(paths);
        expect(runtimeState).toEqual(expect.objectContaining({
          socketPath,
          protocolVersion: 1,
          token: launchToken,
        }));
        expect(runtimeState).toBeDefined();
        expect(workflowSupervisorProcessMayBeAlive(runtimeState!.pid)).toBe(true);
        expect(fs.statSync(paths.stateFile).mode & 0o077).toBe(0);
        expect(fs.statSync(socketPath).mode & 0o077).toBe(0);

        const exited = waitForExit(child, () => stderrText);
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
        expect(fs.existsSync(paths.stateFile)).toBe(false);
        expect(fs.existsSync(socketPath)).toBe(false);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }, 30_000);

    it("becomes ready from a state directory deeper than sun_path", async () => {
      // A Pi agent directory under the OS temp root already leaves too few of
      // sun_path's ~104 bytes for an in-state-directory socket. Binding one
      // anyway fails with EINVAL, which killed the detached supervisor before
      // it could publish readiness.
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-entry-deep-"));
      const stateDirectory = path.join(temporaryRoot, "d".repeat(120), "state");
      let child: ChildProcess | undefined;
      let stderrText = "";
      let socketPath: string | undefined;
      try {
        child = spawn(
          process.execPath,
          ["--import", "tsx", "src/workflows/supervisor/entry.ts"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              KADY_WORKFLOW_SUPERVISOR_DIR: stateDirectory,
              KADY_WORKFLOW_SUPERVISOR_SOCKET: "",
              KADY_WORKFLOW_SUPERVISOR_TOKEN: "d".repeat(64),
              KADY_PI_AGENT_DIR: path.join(temporaryRoot, "pi-agent"),
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        child.stderr?.on("data", (chunk) => {
          stderrText += String(chunk).slice(0, 8_192);
        });
        await waitForReady(child, () => stderrText);

        const runtimeState = readWorkflowSupervisorRuntimeState({
          stateDir: stateDirectory,
          stateFile: path.join(stateDirectory, WORKFLOW_SUPERVISOR_STATE_FILE),
          launchLock: path.join(stateDirectory, "launch.lock"),
          socketPath: "",
          stdoutLog: path.join(stateDirectory, "supervisor.stdout.log"),
          stderrLog: path.join(stateDirectory, "supervisor.stderr.log"),
        });
        expect(runtimeState).toBeDefined();
        socketPath = runtimeState!.socketPath;
        expect(path.dirname(socketPath)).toBe(
          workflowSupervisorFallbackSocketDirectory(stateDirectory),
        );
        expect(fs.statSync(socketPath).mode & 0o077).toBe(0);

        const exited = waitForExit(child, () => stderrText);
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
        expect(fs.existsSync(socketPath)).toBe(false);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        if (socketPath) {
          fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
        }
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }, 30_000);

    it("never includes a malformed launch token or raw startup exception in logs", async () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-entry-log-"));
      const secretMarker = "provider-secret-must-not-appear";
      let child: ChildProcess | undefined;
      let stderrText = "";
      try {
        child = spawn(
          process.execPath,
          ["--import", "tsx", "src/workflows/supervisor/entry.ts"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              KADY_WORKFLOW_SUPERVISOR_DIR: path.join(temporaryRoot, "state"),
              KADY_WORKFLOW_SUPERVISOR_SOCKET: path.join(temporaryRoot, "supervisor.sock"),
              KADY_WORKFLOW_SUPERVISOR_TOKEN: secretMarker,
              KADY_PI_AGENT_DIR: path.join(temporaryRoot, "pi-agent"),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        child.stderr?.on("data", (chunk) => {
          stderrText += String(chunk).slice(0, 8_192);
        });

        expect(await waitForExit(child, () => stderrText)).toBe(1);
        expect(stderrText).toContain("Workflow supervisor failed to start.");
        expect(stderrText).not.toContain(secretMarker);
        expect(stderrText).not.toContain("launch token is malformed");
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
