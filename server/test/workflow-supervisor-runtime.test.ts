import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_SUPERVISOR_MAX_SOCKET_PATH_BYTES,
  WORKFLOW_SUPERVISOR_MAX_STATE_BYTES,
  WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
  WORKFLOW_SUPERVISOR_STATE_FILE,
  type WorkflowSupervisorRuntimePaths,
  type WorkflowSupervisorRuntimeStateV1,
  assertPrivateWorkflowSupervisorSocketDirectory,
  assertPrivateWorkflowSupervisorStateDirectory,
  workflowSupervisorFallbackSocketDirectory,
  readWorkflowSupervisorRuntimeState,
  removeWorkflowSupervisorRuntimeStateIfOwned,
  workflowSupervisorProcessMayBeAlive,
  workflowSupervisorRepositoryDigest,
  workflowSupervisorRuntimePaths,
  writeWorkflowSupervisorRuntimeState,
} from "../src/workflows/supervisor/runtime.ts";

const temporaryRoots: string[] = [];
const actualLstat = fs.lstatSync.bind(fs);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-workflow-supervisor-runtime-"));
  temporaryRoots.push(root);
  return root;
}

function runtimePaths(root: string): WorkflowSupervisorRuntimePaths {
  const stateDir = path.join(root, "runtime");
  return {
    stateDir,
    stateFile: path.join(stateDir, WORKFLOW_SUPERVISOR_STATE_FILE),
    launchLock: path.join(stateDir, "launch.lock"),
    socketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\kady-workflow-supervisor-test"
      : path.join(stateDir, "supervisor.sock"),
    stdoutLog: path.join(stateDir, "supervisor.stdout.log"),
    stderrLog: path.join(stateDir, "supervisor.stderr.log"),
  };
}

function runtimeState(
  paths: WorkflowSupervisorRuntimePaths,
  overrides: Partial<WorkflowSupervisorRuntimeStateV1> = {},
): WorkflowSupervisorRuntimeStateV1 {
  return {
    version: WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
    protocolVersion: 1,
    repositoryDigest: workflowSupervisorRepositoryDigest(),
    pid: process.pid,
    token: "a".repeat(64),
    socketPath: paths.socketPath,
    startedAt: 1_725_000_000_000,
    ...overrides,
  };
}

describe("workflow supervisor runtime state", () => {
  it("derives every runtime path from absolute directory and socket overrides", () => {
    const root = temporaryRoot();
    const stateDirOverride = path.join(root, "nested", "..", "supervisor-state");
    const socketOverride = process.platform === "win32"
      ? "\\\\.\\pipe\\kady-workflow-supervisor-override"
      : path.join(root, "supervisor.sock");
    vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", stateDirOverride);
    vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", socketOverride);

    const stateDir = path.resolve(stateDirOverride);
    expect(workflowSupervisorRuntimePaths()).toEqual({
      stateDir,
      stateFile: path.join(stateDir, WORKFLOW_SUPERVISOR_STATE_FILE),
      launchLock: path.join(stateDir, "launch.lock"),
      socketPath: socketOverride,
      stdoutLog: path.join(stateDir, "supervisor.stdout.log"),
      stderrLog: path.join(stateDir, "supervisor.stderr.log"),
    });
  });

  it.skipIf(process.platform === "win32")(
    "places the default POSIX socket inside the private state directory",
    () => {
      // Deriving paths never touches the filesystem, so this uses a short
      // literal: an OS temp root leaves too few of sun_path's ~104 bytes for
      // the in-state-directory socket this case is about.
      const stateDir = "/tmp/kady-supervisor-private-state";
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", stateDir);
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", "");

      const paths = workflowSupervisorRuntimePaths();
      expect(paths.socketPath).toBe(path.join(stateDir, "supervisor.sock"));
    },
  );

  it.skipIf(process.platform === "win32")(
    "moves a socket that cannot fit in sun_path into a short private directory",
    () => {
      // Pi agent directories under the OS temp root routinely exceed the 104
      // byte sockaddr_un.sun_path budget, which makes the detached supervisor
      // die on an opaque EINVAL from listen() instead of publishing readiness.
      const stateDir = path.join(temporaryRoot(), "d".repeat(120), "private-state");
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", stateDir);
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", "");

      const paths = workflowSupervisorRuntimePaths();
      expect(paths.stateDir).toBe(stateDir);
      expect(path.dirname(paths.socketPath)).toBe(
        workflowSupervisorFallbackSocketDirectory(stateDir),
      );
      expect(Buffer.byteLength(paths.socketPath, "utf-8"))
        .toBeLessThanOrEqual(WORKFLOW_SUPERVISOR_MAX_SOCKET_PATH_BYTES);
    },
  );

  it.skipIf(process.platform === "win32")(
    "gives each state directory its own fallback socket directory",
    () => {
      const root = temporaryRoot();
      const first = workflowSupervisorFallbackSocketDirectory(path.join(root, "one"));
      const second = workflowSupervisorFallbackSocketDirectory(path.join(root, "two"));
      expect(first).not.toBe(second);
      expect(workflowSupervisorFallbackSocketDirectory(path.join(root, "one"))).toBe(first);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when no socket path can fit in sun_path",
    () => {
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", path.join(temporaryRoot(), "state"));
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", `/${"s".repeat(120)}.sock`);
      expect(() => workflowSupervisorRuntimePaths()).toThrowError(
        /socket path exceeds this platform's limit/,
      );

      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", "");
      vi.spyOn(os, "tmpdir").mockReturnValue(`/${"t".repeat(120)}`);
      expect(() => workflowSupervisorRuntimePaths()).toThrowError(
        /socket path exceeds this platform's limit/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates only a fallback socket directory it minted itself, and only privately",
    () => {
      const root = temporaryRoot();
      const stateDir = path.join(root, "state");
      const fallbackDir = workflowSupervisorFallbackSocketDirectory(stateDir);
      temporaryRoots.push(fallbackDir);
      const paths = {
        ...runtimePaths(root),
        stateDir,
        socketPath: path.join(fallbackDir, "supervisor.sock"),
      };

      assertPrivateWorkflowSupervisorSocketDirectory(paths, { create: true });
      expect(fs.statSync(fallbackDir).mode & 0o777).toBe(0o700);

      fs.chmodSync(fallbackDir, 0o755);
      expect(() => assertPrivateWorkflowSupervisorSocketDirectory(paths)).toThrowError(
        "Workflow supervisor socket directory must have mode 700.",
      );

      // An operator-chosen override keeps its own directory: neither creating
      // nor judging a path outside this runtime's control is its decision.
      const overrideDir = path.join(root, "operator-chosen");
      assertPrivateWorkflowSupervisorSocketDirectory(
        { ...paths, socketPath: path.join(overrideDir, "supervisor.sock") },
        { create: true },
      );
      expect(fs.existsSync(overrideDir)).toBe(false);
    },
  );

  it("rejects relative runtime path overrides", () => {
    vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", "relative-supervisor-state");
    expect(() => workflowSupervisorRuntimePaths()).toThrowError(
      "KADY_WORKFLOW_SUPERVISOR_DIR must be an absolute path.",
    );

    if (process.platform !== "win32") {
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_DIR", temporaryRoot());
      vi.stubEnv("KADY_WORKFLOW_SUPERVISOR_SOCKET", "relative-supervisor.sock");
      expect(() => workflowSupervisorRuntimePaths()).toThrowError(
        "KADY_WORKFLOW_SUPERVISOR_SOCKET must be absolute on this platform.",
      );
    }
  });

  it("atomically round-trips private runtime state", () => {
    const root = temporaryRoot();
    const paths = runtimePaths(root);
    const first = runtimeState(paths);
    writeWorkflowSupervisorRuntimeState(first, paths);

    expect(readWorkflowSupervisorRuntimeState(paths)).toEqual(first);
    expect(fs.readdirSync(paths.stateDir)).toEqual([WORKFLOW_SUPERVISOR_STATE_FILE]);
    expect(fs.readFileSync(paths.stateFile, "utf8")).toBe(`${JSON.stringify(first)}\n`);

    const replacement = runtimeState(paths, {
      token: "b".repeat(64),
      startedAt: first.startedAt + 1,
    });
    writeWorkflowSupervisorRuntimeState(replacement, paths);
    expect(readWorkflowSupervisorRuntimeState(paths)).toEqual(replacement);
    expect(fs.readdirSync(paths.stateDir)).toEqual([WORKFLOW_SUPERVISOR_STATE_FILE]);

    if (process.platform !== "win32") {
      expect(fs.statSync(paths.stateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(paths.stateFile).mode & 0o777).toBe(0o600);
    }
  });

  it("returns undefined when runtime state is missing", () => {
    const paths = runtimePaths(temporaryRoot());
    expect(readWorkflowSupervisorRuntimeState(paths)).toBeUndefined();
  });

  it("rejects invalid JSON and malformed runtime state", () => {
    const paths = runtimePaths(temporaryRoot());
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.stateFile, "{not-json\n", { mode: 0o600 });
    expect(() => readWorkflowSupervisorRuntimeState(paths)).toThrow();

    fs.writeFileSync(paths.stateFile, JSON.stringify({
      ...runtimeState(paths),
      token: "not-a-supervisor-token",
    }), { mode: 0o600 });
    expect(() => readWorkflowSupervisorRuntimeState(paths)).toThrowError(
      "Workflow supervisor runtime state is malformed.",
    );
  });

  it("rejects runtime state larger than the read limit", () => {
    const paths = runtimePaths(temporaryRoot());
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      paths.stateFile,
      Buffer.alloc(WORKFLOW_SUPERVISOR_MAX_STATE_BYTES + 1, 0x20),
      { mode: 0o600 },
    );

    expect(() => readWorkflowSupervisorRuntimeState(paths)).toThrowError(
      "Workflow supervisor runtime state is not a bounded regular file.",
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked runtime state file instead of following it",
    () => {
      const root = temporaryRoot();
      const paths = runtimePaths(root);
      const target = path.join(root, "outside-supervisor.json");
      fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, `${JSON.stringify(runtimeState(paths))}\n`, { mode: 0o600 });
      fs.symlinkSync(target, paths.stateFile, "file");

      expect(() => readWorkflowSupervisorRuntimeState(paths)).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects broad state-directory and runtime-file modes instead of repairing them",
    () => {
      const directoryPaths = runtimePaths(temporaryRoot());
      fs.mkdirSync(directoryPaths.stateDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(directoryPaths.stateDir, 0o755);
      expect(() => writeWorkflowSupervisorRuntimeState(
        runtimeState(directoryPaths),
        directoryPaths,
      )).toThrowError("Workflow supervisor state directory must have mode 700.");
      expect(fs.statSync(directoryPaths.stateDir).mode & 0o777).toBe(0o755);

      const filePaths = runtimePaths(temporaryRoot());
      writeWorkflowSupervisorRuntimeState(runtimeState(filePaths), filePaths);
      fs.chmodSync(filePaths.stateFile, 0o644);
      expect(() => readWorkflowSupervisorRuntimeState(filePaths)).toThrowError(
        "Workflow supervisor runtime state must have mode 600.",
      );
    },
  );

  it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
    "rejects a state directory whose owner is not the current user",
    () => {
      const paths = runtimePaths(temporaryRoot());
      fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      const actual = fs.lstatSync(paths.stateDir);
      const wrongOwner = new Proxy(actual, {
        get(target, property) {
          if (property === "uid") return process.getuid!() + 1;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const lstat = vi.spyOn(fs, "lstatSync");
      lstat.mockImplementation((filename) =>
        path.resolve(String(filename)) === path.resolve(paths.stateDir)
          ? wrongOwner
          : actualLstat(filename));

      expect(() => assertPrivateWorkflowSupervisorStateDirectory(paths)).toThrowError(
        "Workflow supervisor state directory is not owned by the current user.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rechecks inode identity immediately before removing owned runtime state",
    () => {
      const paths = runtimePaths(temporaryRoot());
      const state = runtimeState(paths);
      writeWorkflowSupervisorRuntimeState(state, paths);
      const replacement = `${paths.stateFile}.replacement`;
      fs.writeFileSync(replacement, `${JSON.stringify(state)}\n`, { mode: 0o600 });

      const originalLstat = fs.lstatSync.bind(fs);
      let stateFileLstatCalls = 0;
      vi.spyOn(fs, "lstatSync").mockImplementation((filename) => {
        if (path.resolve(String(filename)) === path.resolve(paths.stateFile)) {
          stateFileLstatCalls += 1;
          if (stateFileLstatCalls === 4) {
            fs.renameSync(replacement, paths.stateFile);
          }
        }
        return originalLstat(filename);
      });

      expect(removeWorkflowSupervisorRuntimeStateIfOwned(paths, state)).toBe(false);
      expect(fs.existsSync(paths.stateFile)).toBe(true);
    },
  );

  it("treats only a confirmed missing process as dead", () => {
    expect(workflowSupervisorProcessMayBeAlive(process.pid)).toBe(true);

    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    expect(workflowSupervisorProcessMayBeAlive(2_147_483_647)).toBe(false);

    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(workflowSupervisorProcessMayBeAlive(2_147_483_647)).toBe(true);
  });
});
