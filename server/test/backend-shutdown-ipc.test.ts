import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function waitForReady(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for backend IPC readiness: ${stderr()}`));
    }, 20_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "kady-ready"
      ) {
        finish();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(
        `Backend exited before IPC readiness (code=${String(code)}, signal=${String(signal)}): ${stderr()}`,
      ));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, stderr: () => string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for graceful backend exit: ${stderr()}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("production backend IPC lifecycle", () => {
  it("boots through the launcher's direct tsx entry and exits only after app.close", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-backend-ipc-"));
    let child: ChildProcess | undefined;
    let stderrText = "";
    try {
      child = spawn(
        process.execPath,
        [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            KADY_HOST: "127.0.0.1",
            KADY_PORT: "0",
            KADY_PROJECTS_ROOT: path.join(temporaryRoot, "projects"),
            KADY_PI_AGENT_DIR: path.join(temporaryRoot, "pi-agent"),
            KADY_SKILLS_CACHE_DIR: path.join(temporaryRoot, "skills-cache"),
            LOG_LEVEL: "silent",
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      child.stderr?.on("data", (chunk) => {
        stderrText += String(chunk).slice(0, 4_096);
      });

      await waitForReady(child, () => stderrText);
      expect(child.exitCode).toBeNull();
      await new Promise<void>((resolve, reject) => {
        child?.send({ type: "kady-shutdown" }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      expect(await waitForExit(child, () => stderrText)).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
