import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const isWin = process.platform === "win32";

/** One bounded deadline for readiness and owned-tree reaping. The old fixed
 *  20s timers only proved a timer expired; every shutdown assertion below is
 *  PID-based (waitForOwnedTree semantics from start.mjs) under this bound. */
const DEADLINE_MS = 20_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** kill(pid, 0) probe: only ESRCH proves the process is gone (EPERM = alive). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** Mirror of start.mjs ownedTreeGone: probe the child's whole process group
 *  (the backend is spawned detached as its own group leader, exactly like the
 *  launcher's directBackend spawn), so descendants count as survivors. */
function groupAlive(pgid: number): boolean {
  if (isWin) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

interface OwnedProbe {
  label: string;
  alive: () => boolean;
}

/** waitForOwnedTree semantics: poll until every owned probe reports gone.
 *  On deadline, fail naming the survivors — never for a bare timeout. */
async function waitForOwnedTreeGone(probes: OwnedProbe[], stderr: () => string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const survivors = probes.filter((probe) => probe.alive());
    if (survivors.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Owned tree survivors after ${String(DEADLINE_MS)}ms: ` +
          `${survivors.map((survivor) => survivor.label).join(", ")}: ${stderr()}`,
      );
    }
    await sleep(POLL_MS);
  }
}

function waitForReady(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for backend IPC readiness: ${stderr()}`));
    }, DEADLINE_MS);
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
      reject(new Error(`Timed out waiting for backend exit: ${stderr()}`));
    }, DEADLINE_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** The backend spawns its workflow supervisor detached (own process group),
 *  so group probes on the backend can never see it. Its pid is durable in
 *  <agentDir>/workflow-supervisor/<digest>/supervisor.json. */
async function findSupervisorPid(agentDir: string, stderr: () => string): Promise<number> {
  const root = path.join(agentDir, "workflow-supervisor");
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const stateFile = path.join(root, entry, "supervisor.json");
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { pid?: unknown };
          if (Number.isSafeInteger(state.pid) && (state.pid as number) >= 1) {
            return state.pid as number;
          }
        } catch {
          // State file absent or mid-write; keep polling until the deadline.
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out locating supervisor.json under ${root}: ${stderr()}`);
    }
    await sleep(POLL_MS);
  }
}

interface BootedBackend {
  child: ChildProcess;
  temporaryRoot: string;
  agentDir: string;
  stderr: () => string;
  ownedProbes: () => OwnedProbe[];
  noteSupervisorPid: (pid: number) => void;
}

function bootBackend(prefix: string, extraEnv: Record<string, string> = {}): BootedBackend {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(temporaryRoot, "pi-agent");
  let stderrText = "";
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KADY_HOST: "127.0.0.1",
        KADY_PORT: "0",
        KADY_PROJECTS_ROOT: path.join(temporaryRoot, "projects"),
        KADY_PI_AGENT_DIR: agentDir,
        // An inherited PI_CODING_AGENT_DIR overrides KADY_PI_AGENT_DIR
        // (server/src/env.ts), which would silently move the supervisor
        // state — and the orphan — outside this test's temp root.
        PI_CODING_AGENT_DIR: agentDir,
        KADY_SKILLS_CACHE_DIR: path.join(temporaryRoot, "skills-cache"),
        // The boot-time skill fetch otherwise shallow-clones the real skills
        // repo, and an in-flight clone child is not reaped on shutdown (it
        // survives in the backend's process group with PPID 1) — a
        // pre-existing leak outside this unit's scope. A repo that cannot
        // exist makes the fetch fail in one round-trip instead.
        KADY_SKILLS_REPO: "kady-u5-nonexistent-org/kady-u5-nonexistent-repo",
        LOG_LEVEL: "silent",
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Own process group, like the launcher's directBackend spawn, so the
      // owned-tree probe covers the backend and any group-local descendants.
      detached: !isWin,
    },
  );
  child.stderr?.on("data", (chunk) => {
    stderrText += String(chunk).slice(0, 4_096);
  });

  let supervisorPid: number | undefined;
  const ownedProbes = (): OwnedProbe[] => {
    const probes: OwnedProbe[] = [];
    if (typeof child.pid === "number") {
      probes.push(
        isWin
          ? {
              label: `backend pid ${String(child.pid)}`,
              alive: () => child.exitCode === null && child.signalCode === null,
            }
          : {
              label: `backend group ${String(child.pid)}`,
              alive: () => groupAlive(child.pid!),
            },
      );
    }
    if (supervisorPid !== undefined) {
      probes.push({
        label: `workflow supervisor pid ${String(supervisorPid)}`,
        alive: () => processAlive(supervisorPid!),
      });
    }
    return probes;
  };

  return {
    child,
    temporaryRoot,
    agentDir,
    stderr: () => stderrText,
    ownedProbes,
    noteSupervisorPid: (pid: number) => {
      supervisorPid = pid;
    },
  };
}

/** Reap every owned pid — and only owned pids — then prove the tree is gone. */
async function teardownOwnedTree(booted: BootedBackend): Promise<void> {
  const { child } = booted;
  if (typeof child.pid === "number") {
    if (isWin) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
  }
  for (const probe of booted.ownedProbes()) {
    if (probe.label.startsWith("workflow supervisor pid") && probe.alive()) {
      const pid = Number(probe.label.split(" ").at(-1));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Supervisor already gone.
      }
    }
  }
  await waitForOwnedTreeGone(booted.ownedProbes(), booted.stderr);
}

describe("production backend IPC lifecycle", () => {
  it("boots through the launcher's direct tsx entry and exits only after app.close", async () => {
    const booted = bootBackend("kady-backend-ipc-");
    const { child, stderr } = booted;
    try {
      await waitForReady(child, stderr);
      booted.noteSupervisorPid(await findSupervisorPid(booted.agentDir, stderr));
      expect(child.exitCode).toBeNull();
      await new Promise<void>((resolve, reject) => {
        child.send({ type: "kady-shutdown" }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      expect(await waitForExit(child, stderr)).toBe(0);
      // Graceful close runs workflowSupervisor.shutdown("backend-shutdown"):
      // the exit code alone is not proof — the owned tree must be gone.
      await waitForOwnedTreeGone(booted.ownedProbes(), stderr);
    } finally {
      await teardownOwnedTree(booted);
      fs.rmSync(booted.temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits with a failure code when the workflow supervisor cannot start", async () => {
    // Both the installed signal handlers and the launcher's IPC channel keep
    // libuv referenced. Without releasing them a failed bootstrap sat forever
    // on an empty event loop, so the launcher read a startup failure as a hang.
    const booted = bootBackend("kady-backend-ipc-fail-", {
      // No socket of this length can be bound on any supported platform.
      KADY_WORKFLOW_SUPERVISOR_SOCKET: `/${"s".repeat(200)}.sock`,
    });
    const { child, stderr } = booted;
    try {
      expect(await waitForExit(child, stderr)).toBe(1);
      expect(stderr()).toContain("Kady backend initialization failed");
      await waitForOwnedTreeGone(booted.ownedProbes(), stderr);
    } finally {
      await teardownOwnedTree(booted);
      fs.rmSync(booted.temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("reaps the detached workflow supervisor when graceful shutdown never runs", async () => {
    // U5 regression. The supervisor is spawned detached in its own process
    // group precisely so it survives a backend crash; a teardown that only
    // kills the direct backend process therefore leaks it, and an assertion
    // that only watches the backend's exit event (or a fixed sleep) can never
    // notice. This test forces the failed-shutdown path and requires the
    // owned-tree reap to account for the supervisor by pid.
    const booted = bootBackend("kady-backend-ipc-orphan-");
    const { child, stderr } = booted;
    try {
      await waitForReady(child, stderr);
      const supervisorPid = await findSupervisorPid(booted.agentDir, stderr);
      booted.noteSupervisorPid(supervisorPid);
      expect(processAlive(supervisorPid)).toBe(true);

      // Force a failed shutdown: the graceful IPC path never runs.
      child.kill("SIGKILL");
      await waitForExit(child, stderr);

      // Reap the full owned tree and prove it is gone, pid by pid. With the
      // legacy direct-child-only cleanup this fails naming the surviving
      // supervisor pid — the exact orphan the old test was blind to.
      await teardownOwnedTree(booted);
    } finally {
      await teardownOwnedTree(booted);
      fs.rmSync(booted.temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
