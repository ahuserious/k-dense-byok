/**
 * Cross-writer exact-content protection for the credential `.env` file.
 *
 * The PUT /credentials persistence path snapshots the file, plans the change,
 * and replaces the file with a temp-write + rename. A second writer landing
 * between the snapshot validation and the rename would be silently
 * overwritten (lost update). These tests pin the `.env.lock` protocol that
 * closes that window for cooperating writers and turns a detected concurrent
 * change into an explicit, retryable conflict — never a silent loss.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelRuntime = vi.hoisted(() => ({
  setRuntimeApiKey: vi.fn(async () => undefined),
  removeRuntimeApiKey: vi.fn(async () => undefined),
}));

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: () => modelRuntime,
}));

import {
  registerCredentialRoutes,
  setCredentialAfterSnapshotHookForTests,
  setCredentialBeforeRenameHookForTests,
  setCredentialEnvPathForTests,
  setModalCredentialValidatorForTests,
} from "../src/api/credentials.ts";

const MANAGED_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OR_API_KEY",
  "NVIDIA_API_KEY",
  "EXA_API_KEY",
  "PERPLEXITY_API_KEY",
  "GEMINI_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
] as const;

const originalEnvironment = new Map(
  MANAGED_ENV_NAMES.map((name) => [name, process.env[name]] as const),
);
let temporaryRoot: string;
let envPath: string;
let lockPath: string;

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-credential-env-lock-"));
  envPath = path.join(temporaryRoot, ".env");
  lockPath = `${envPath}.lock`;
  for (const name of MANAGED_ENV_NAMES) delete process.env[name];
  modelRuntime.setRuntimeApiKey.mockClear();
  modelRuntime.removeRuntimeApiKey.mockClear();
  setCredentialEnvPathForTests(envPath);
});

afterEach(() => {
  setCredentialAfterSnapshotHookForTests(null);
  setCredentialBeforeRenameHookForTests(null);
  setModalCredentialValidatorForTests(null);
  setCredentialEnvPathForTests(null);
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function credentialApp() {
  const app = Fastify({ logger: false });
  await registerCredentialRoutes(app);
  return app;
}

describe("credential env cross-writer lock", () => {
  it("never silently drops a second writer that lands in the rename window", async () => {
    const originalFile = "UNMANAGED_SETTING=aaaa\nEXA_API_KEY=existing-exa-key\n";
    // Same byte length, different bytes: defeats every size-based check.
    const crossProcessFile = "UNMANAGED_SETTING=bbbb\nEXA_API_KEY=existing-exa-key\n";
    expect(Buffer.byteLength(crossProcessFile)).toBe(Buffer.byteLength(originalFile));
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";

    let secondWriterRan = false;
    let secondWriterWrote = false;
    let secondWriterRefusal: NodeJS.ErrnoException | null = null;
    setCredentialBeforeRenameHookForTests(() => {
      if (secondWriterRan) return;
      secondWriterRan = true;
      // Simulate a cooperating cross-process writer: it follows the same
      // `.env.lock` protocol, so it may write only if it can create the lock.
      try {
        const descriptor = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        fs.closeSync(descriptor);
        fs.writeFileSync(envPath, crossProcessFile, { mode: 0o600 });
        fs.unlinkSync(lockPath);
        secondWriterWrote = true;
      } catch (error) {
        secondWriterRefusal = error as NodeJS.ErrnoException;
      }
    });

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(secondWriterRan).toBe(true);
      const persisted = fs.readFileSync(envPath, "utf8");
      if (secondWriterWrote) {
        // The second writer was allowed through, so its bytes must survive.
        expect(persisted).toContain("UNMANAGED_SETTING=bbbb");
      } else {
        // The lock refused the second writer while our rename was pending.
        expect(secondWriterRefusal?.code).toBe("EEXIST");
        expect(response.statusCode).toBe(200);
        expect(persisted).toContain("EXA_API_KEY=replacement-exa-key");
      }
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects a mutation with a retryable 409 when the file changes between snapshot and lock", async () => {
    const originalFile = "UNMANAGED_SETTING=aaaa\nEXA_API_KEY=existing-exa-key\n";
    // Same byte length again so only the content hash can be authoritative.
    const externalFile = "UNMANAGED_SETTING=cccc\nEXA_API_KEY=existing-exa-key\n";
    expect(Buffer.byteLength(externalFile)).toBe(Buffer.byteLength(originalFile));
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    let externalWriteRan = false;
    setCredentialAfterSnapshotHookForTests(() => {
      if (externalWriteRan) return;
      externalWriteRan = true;
      fs.writeFileSync(envPath, externalFile, { mode: 0o600 });
    });

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(externalWriteRan).toBe(true);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        detail:
          "The .env file was changed by another process while saving. Retry the change.",
        reason: "credential_conflict",
        saved: false,
      });
      // The external writer's bytes survive; the live env is untouched.
      expect(fs.readFileSync(envPath, "utf8")).toBe(externalFile);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("proceeds when timestamps change but the content hash still matches", async () => {
    const originalFile = "UNMANAGED_SETTING=aaaa\nEXA_API_KEY=existing-exa-key\n";
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    let touchRan = false;
    setCredentialAfterSnapshotHookForTests(() => {
      if (touchRan) return;
      touchRan = true;
      // Identical bytes, fresh inode and timestamps: content is unchanged.
      fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    });

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(touchRan).toBe(true);
      expect(response.statusCode).toBe(200);
      expect(fs.readFileSync(envPath, "utf8")).toContain("EXA_API_KEY=replacement-exa-key");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  // 50 iterations x 4 concurrent writers = 200 real credential writes, each taking the on-disk lock
  // and renaming the env file. The duration scales with how busy the machine is, not with whether
  // the behaviour is correct, so this timed out at the default 5 s on a host running many parallel
  // suites while passing in isolation. The iteration count IS the assertion here — lowering it would
  // weaken what the test proves about concurrent same-length writes — so the budget moves instead.
  it("loses no accepted update across concurrent same-length mutations", async () => {
    const iterations = 50;
    const writers = [
      { field: "exaApiKey", envName: "EXA_API_KEY", prefix: "exa" },
      { field: "perplexityApiKey", envName: "PERPLEXITY_API_KEY", prefix: "ppx" },
      { field: "geminiApiKey", envName: "GEMINI_API_KEY", prefix: "gem" },
      { field: "nvidiaApiKey", envName: "NVIDIA_API_KEY", prefix: "nvd" },
    ] as const;
    const app = await credentialApp();
    try {
      for (let iteration = 0; iteration < iterations; iteration++) {
        // Same-length payloads within and across iterations.
        const suffix = String(iteration).padStart(4, "0");
        const responses = await Promise.all(
          writers.map((writer) =>
            app.inject({
              method: "PUT",
              url: "/credentials",
              payload: { [writer.field]: `${writer.prefix}-fuzz-key-${suffix}` },
            }),
          ),
        );
        const persisted = fs.readFileSync(envPath, "utf8");
        for (const [index, response] of responses.entries()) {
          const writer = writers[index];
          if (response.statusCode === 200) {
            expect(persisted).toContain(
              `${writer.envName}=${writer.prefix}-fuzz-key-${suffix}`,
            );
          } else {
            // A refused write must be an explicit conflict/storage rejection.
            expect([409, 500]).toContain(response.statusCode);
            expect(["credential_conflict", "credential_persistence_failed"]).toContain(
              response.json().reason,
            );
          }
        }
        expect(fs.existsSync(lockPath)).toBe(false);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  it("recovers a lock abandoned by a provably dead process within the bound", async () => {
    // Spawn-and-reap a child so its pid is provably dead (kill(pid, 0) → ESRCH).
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    const staleOwner = {
      version: 1,
      token: "a".repeat(64),
      pid: reaped.pid,
      startedAt: 0,
      hostname: os.hostname(),
      createdAt: Date.now() - 60_000,
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(response.statusCode).toBe(200);
      expect(fs.readFileSync(envPath, "utf8")).toContain("EXA_API_KEY=replacement-exa-key");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("never steals a live owner's lock; the mutation fails closed instead", async () => {
    const liveOwner = {
      version: 1,
      token: "b".repeat(64),
      pid: process.pid,
      startedAt: 0,
      hostname: os.hostname(),
      createdAt: Date.now(),
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(liveOwner)}\n`, { mode: 0o600 });
    fs.writeFileSync(envPath, "EXA_API_KEY=existing-exa-key\n", { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().reason).toBe("credential_persistence_failed");
      // The live owner's lock and the file are untouched.
      expect(fs.readFileSync(lockPath, "utf8")).toContain("b".repeat(64));
      expect(fs.readFileSync(envPath, "utf8")).toBe("EXA_API_KEY=existing-exa-key\n");
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
    } finally {
      await app.close();
    }
  // The live-owner path deliberately waits out the lock-acquisition bound, so its 10 s budget was
  // exactly its expected duration and left no headroom on a loaded machine.
  }, 30_000);

  it("releases the lock and leaves no temp files when the rename itself fails", async () => {
    fs.writeFileSync(envPath, "EXA_API_KEY=existing-exa-key\n", { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
    });
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(response.statusCode).toBe(500);
      expect(fs.existsSync(lockPath)).toBe(false);
      const leftovers = fs
        .readdirSync(temporaryRoot)
        .filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
      expect(fs.readFileSync(envPath, "utf8")).toBe("EXA_API_KEY=existing-exa-key\n");
    } finally {
      renameSpy.mockRestore();
      await app.close();
    }
  });

  it("refuses a symlinked .env.lock without following it", async () => {
    if (process.platform === "win32") return;
    const lockTarget = path.join(temporaryRoot, "unrelated-lock-target");
    fs.writeFileSync(lockTarget, "unrelated bytes\n", { mode: 0o600 });
    fs.symlinkSync(lockTarget, lockPath);
    fs.writeFileSync(envPath, "EXA_API_KEY=existing-exa-key\n", { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";

    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });
      expect(response.statusCode).toBe(500);
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(lockTarget, "utf8")).toBe("unrelated bytes\n");
      expect(fs.readFileSync(envPath, "utf8")).toBe("EXA_API_KEY=existing-exa-key\n");
    } finally {
      await app.close();
    }
  });
});
