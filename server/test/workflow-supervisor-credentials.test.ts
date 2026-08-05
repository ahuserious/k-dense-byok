import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEnvFile } from "../../env-file.mjs";

const modelRuntime = vi.hoisted(() => ({
  setRuntimeApiKey: vi.fn(async () => undefined),
  removeRuntimeApiKey: vi.fn(async () => undefined),
}));

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: () => modelRuntime,
}));

import {
  MAX_CREDENTIAL_ENV_BYTES,
  registerCredentialRoutes,
  setCredentialEnvPathForTests,
  setModalCredentialValidatorForTests,
} from "../src/api/credentials.ts";
import type { WorkflowSupervisorCredentialKey } from "../src/workflows/supervisor/credential-contract.ts";

const MANAGED_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OR_API_KEY",
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

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-credentials-"));
  envPath = path.join(temporaryRoot, ".env");
  for (const name of MANAGED_ENV_NAMES) delete process.env[name];
  modelRuntime.setRuntimeApiKey.mockClear();
  modelRuntime.removeRuntimeApiKey.mockClear();
  setCredentialEnvPathForTests(envPath);
});

afterEach(() => {
  setModalCredentialValidatorForTests(null);
  setCredentialEnvPathForTests(null);
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function credentialApp(
  reloadCredentials?: (
    keys: readonly WorkflowSupervisorCredentialKey[],
  ) => Promise<unknown>,
) {
  const app = Fastify({ logger: false });
  await registerCredentialRoutes(app, { reloadCredentials });
  return app;
}

describe("credential route workflow-supervisor reload", () => {
  it("reloads every changed provider once by unique secret-free id and excludes Modal", async () => {
    fs.writeFileSync(
      envPath,
      [
        "# preserved comment",
        "UNMANAGED_SETTING=keep-me",
        "export OR_API_KEY = stale-exported-alias",
        "OR_API_KEY = stale-spaced-alias",
        "EXA_API_KEY=old-exa-key",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    process.env.OR_API_KEY = "stale-ambient-alias";
    const originalRenameSync = fs.renameSync.bind(fs);
    let credentialFileReplacements = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === envPath) credentialFileReplacements++;
      originalRenameSync(source, destination);
    });
    const calls: WorkflowSupervisorCredentialKey[][] = [];
    const app = await credentialApp(async (keys) => {
      calls.push([...keys]);
      return [...keys];
    });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          openrouterApiKey: "openrouter-test-key",
          exaApiKey: "exa-test-key",
          perplexityApiKey: "perplexity-test-key",
          geminiApiKey: "gemini-test-key",
          modalTokenId: null,
          modalTokenSecret: null,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(calls).toEqual([["openrouter", "exa", "perplexity", "gemini"]]);
      expect(new Set(calls[0]).size).toBe(calls[0].length);
      expect(calls.flat()).not.toContain("modalTokenId");
      expect(calls.flat()).not.toContain("modalTokenSecret");
      expect(modelRuntime.setRuntimeApiKey).toHaveBeenCalledWith(
        "openrouter",
        "openrouter-test-key",
      );

      const persisted = fs.readFileSync(envPath, "utf8");
      expect(persisted).toContain("# preserved comment\n");
      expect(persisted).toContain("UNMANAGED_SETTING=keep-me\n");
      expect(persisted).toContain("OPENROUTER_API_KEY=openrouter-test-key");
      expect(persisted).toContain("OR_API_KEY=\n");
      expect(persisted).not.toContain("stale-exported-alias");
      expect(persisted).not.toContain("stale-spaced-alias");
      expect(process.env.OR_API_KEY).toBeUndefined();
      expect(credentialFileReplacements).toBe(1);
      expect(persisted).toContain("EXA_API_KEY=exa-test-key");
      expect(persisted).toContain("PERPLEXITY_API_KEY=perplexity-test-key");
      expect(persisted).toContain("GEMINI_API_KEY=gemini-test-key");
      expect(persisted).toContain("MODAL_TOKEN_ID=\n");
      expect(persisted).toContain("MODAL_TOKEN_SECRET=\n");
      if (process.platform !== "win32") {
        expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      renameSpy.mockRestore();
      await app.close();
    }
  });

  it("returns a fixed partial-success 503 when reload fails after persistence", async () => {
    const leakedError = "EXA_API_KEY=provider-secret-that-must-not-leak";
    const app = await credentialApp(async () => {
      throw new Error(leakedError);
    });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "saved-exa-test-key" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        detail:
          "Credentials were saved, but the workflow supervisor reload failed. Retry the change or restart Kady.",
        reason: "workflow_supervisor_reload_failed",
        saved: true,
      });
      expect(response.body).not.toContain(leakedError);
      expect(response.body).not.toContain("provider-secret-that-must-not-leak");
      expect(process.env.EXA_API_KEY).toBe("saved-exa-test-key");
      expect(fs.readFileSync(envPath, "utf8")).toContain(
        "EXA_API_KEY=saved-exa-test-key",
      );
    } finally {
      await app.close();
    }
  });

  it("clears the legacy OpenRouter alias across runtime reload and restart", async () => {
    fs.writeFileSync(
      envPath,
      [
        "# preserve me",
        "export OPENROUTER_API_KEY = stale-exported-canonical",
        "OR_API_KEY = stale-spaced-alias",
        "OR_API_KEY=legacy-openrouter-key",
        "UNMANAGED_SETTING=keep-me",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    process.env.OR_API_KEY = "legacy-openrouter-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { openrouterApiKey: null },
      });

      expect(response.statusCode).toBe(200);
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(process.env.OR_API_KEY).toBeUndefined();
      expect(modelRuntime.removeRuntimeApiKey).toHaveBeenCalledWith("openrouter");
      expect(reloadCredentials).toHaveBeenCalledWith(["openrouter"]);

      const persisted = fs.readFileSync(envPath, "utf8");
      expect(persisted).toContain("# preserve me\n");
      expect(persisted).toContain("UNMANAGED_SETTING=keep-me\n");
      expect(persisted).not.toContain("stale-exported-canonical");
      expect(persisted).not.toContain("stale-spaced-alias");
      expect(persisted).not.toContain("legacy-openrouter-key");
      expect(persisted).toContain("OPENROUTER_API_KEY=\n");
      expect(persisted).toContain("OR_API_KEY=\n");

      // Simulate the backend/supervisor precedence order with stale values in
      // a lower-priority legacy file. Root tombstones must block resurrection.
      const legacyEnvPath = path.join(temporaryRoot, "legacy.env");
      fs.writeFileSync(
        legacyEnvPath,
        "OPENROUTER_API_KEY=stale-canonical-key\nOR_API_KEY=stale-alias-key\n",
        { mode: 0o600 },
      );
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.OR_API_KEY;
      expect(applyEnvFile(envPath, { override: true })).toBe(true);
      expect(applyEnvFile(legacyEnvPath)).toBe(true);
      expect(process.env.OPENROUTER_API_KEY).toBe("");
      expect(process.env.OR_API_KEY).toBe("");
    } finally {
      await app.close();
    }
  });

  it("never reloads for invalid provider or Modal credentials", async () => {
    const reloadCredentials = vi.fn(async () => undefined);
    const modalValidator = vi.fn(async () => {
      throw new Error("invalid modal secret detail");
    });
    setModalCredentialValidatorForTests(modalValidator);
    const app = await credentialApp(reloadCredentials);
    try {
      const invalidProvider = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { geminiApiKey: "short" },
      });
      expect(invalidProvider.statusCode).toBe(400);

      const incompleteModal = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { modalTokenId: "modal-token-id-valid" },
      });
      expect(incompleteModal.statusCode).toBe(400);

      const rejectedModal = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          modalTokenId: "modal-token-id-valid",
          modalTokenSecret: "modal-token-secret-valid",
        },
      });
      expect(rejectedModal.statusCode).toBe(400);
      expect(rejectedModal.json()).toEqual({
        detail: "Modal credentials could not be validated.",
        reason: "modal_credentials_invalid",
      });
      expect(rejectedModal.body).not.toContain("invalid modal secret detail");
      expect(modalValidator).toHaveBeenCalledOnce();
      expect(reloadCredentials).not.toHaveBeenCalled();
      expect(fs.existsSync(envPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["newline", "abcdefgh\nPERPLEXITY_API_KEY=injected-secret"],
    ["carriage return", "abcdefgh\rPERPLEXITY_API_KEY=injected-secret"],
    ["NUL", "abcdefgh\0PERPLEXITY_API_KEY=injected-secret"],
  ])("rejects %s in a supplied value before any mutation", async (_label, maliciousValue) => {
    const originalFile = "# keep this file byte-for-byte\nEXA_API_KEY=existing-exa-key\n";
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: maliciousValue },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("injected-secret");
      expect(fs.readFileSync(envPath, "utf8")).toBe(originalFile);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("round-trips representable quotes, spaces, and hashes through the real env parser", async () => {
    const exactValues = {
      exaApiKey: "exa key # with 'single quotes'",
      perplexityApiKey: 'perplexity key # with "double quotes"',
      geminiApiKey: `gemini"double'combo`,
    };
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: exactValues,
      });
      expect(response.statusCode).toBe(200);

      delete process.env.EXA_API_KEY;
      delete process.env.PERPLEXITY_API_KEY;
      delete process.env.GEMINI_API_KEY;
      expect(applyEnvFile(envPath, { override: true })).toBe(true);
      expect(process.env.EXA_API_KEY).toBe(exactValues.exaApiKey);
      expect(process.env.PERPLEXITY_API_KEY).toBe(exactValues.perplexityApiKey);
      expect(process.env.GEMINI_API_KEY).toBe(exactValues.geminiApiKey);
    } finally {
      await app.close();
    }
  });

  it("rejects a value the env parser cannot represent before a mixed mutation", async () => {
    const originalFile = "EXA_API_KEY=existing-exa-key\n";
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          exaApiKey: "replacement-exa-key",
          perplexityApiKey: `both "quotes" # and 'apostrophes'`,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("apostrophes");
      expect(fs.readFileSync(envPath, "utf8")).toBe(originalFile);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(process.env.PERPLEXITY_API_KEY).toBeUndefined();
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("prevalidates a mixed update before changing file, env, runtime, or supervisor", async () => {
    const originalFile = [
      "# credentials",
      "OPENROUTER_API_KEY=existing-openrouter-key",
      "EXA_API_KEY=existing-exa-key",
      "UNMANAGED_SETTING=keep-me",
      "",
    ].join("\n");
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.OPENROUTER_API_KEY = "existing-openrouter-key";
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          openrouterApiKey: "replacement-openrouter-key",
          exaApiKey: "short",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(fs.readFileSync(envPath, "utf8")).toBe(originalFile);
      expect(process.env.OPENROUTER_API_KEY).toBe("existing-openrouter-key");
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(modelRuntime.setRuntimeApiKey).not.toHaveBeenCalled();
      expect(modelRuntime.removeRuntimeApiKey).not.toHaveBeenCalled();
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("leaves valid provider changes untouched when the Modal pair is invalid", async () => {
    const originalFile = "EXA_API_KEY=existing-exa-key\n";
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          exaApiKey: "replacement-exa-key",
          modalTokenId: "valid-modal-token-id",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/pair/i);
      expect(fs.readFileSync(envPath, "utf8")).toBe(originalFile);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(process.env.MODAL_TOKEN_ID).toBeUndefined();
      expect(process.env.MODAL_TOKEN_SECRET).toBeUndefined();
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("refuses a symlink .env without changing its target or live consumers", async () => {
    if (process.platform === "win32") return;
    const targetPath = path.join(temporaryRoot, "credential-target.env");
    const originalTarget = "EXA_API_KEY=existing-exa-key\n";
    fs.writeFileSync(targetPath, originalTarget, { mode: 0o600 });
    fs.symlinkSync(targetPath, envPath);
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        detail: "Credentials could not be saved safely. Check the .env file and retry.",
        reason: "credential_persistence_failed",
        saved: false,
      });
      expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, "utf8")).toBe(originalTarget);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized .env before allocation or any live mutation", async () => {
    const originalFile = Buffer.alloc(MAX_CREDENTIAL_ENV_BYTES + 1, "x");
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        detail: "Credentials could not be saved safely. Check the .env file and retry.",
        reason: "credential_persistence_failed",
        saved: false,
      });
      expect(fs.readFileSync(envPath).equals(originalFile)).toBe(true);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("preserves a same-size concurrent .env edit detected during the bounded read", async () => {
    const originalFile = "UNMANAGED_SETTING=old\nEXA_API_KEY=existing-exa-key\n";
    const concurrentFile = "UNMANAGED_SETTING=new\nEXA_API_KEY=existing-exa-key\n";
    expect(Buffer.byteLength(concurrentFile)).toBe(Buffer.byteLength(originalFile));
    fs.writeFileSync(envPath, originalFile, { mode: 0o600 });
    process.env.EXA_API_KEY = "existing-exa-key";
    const envIdentity = fs.statSync(envPath);
    const originalReadSync = fs.readSync.bind(fs);
    let concurrentEditWritten = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const bytesRead = originalReadSync(...args);
      const descriptorIdentity = fs.fstatSync(args[0]);
      if (
        !concurrentEditWritten &&
        descriptorIdentity.dev === envIdentity.dev &&
        descriptorIdentity.ino === envIdentity.ino
      ) {
        concurrentEditWritten = true;
        fs.writeFileSync(envPath, concurrentFile, { mode: 0o600 });
      }
      return bytesRead;
    });
    const reloadCredentials = vi.fn(async () => undefined);
    const app = await credentialApp(reloadCredentials);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "replacement-exa-key" },
      });

      expect(concurrentEditWritten).toBe(true);
      expect(response.statusCode).toBe(500);
      expect(fs.readFileSync(envPath, "utf8")).toBe(concurrentFile);
      expect(process.env.EXA_API_KEY).toBe("existing-exa-key");
      expect(reloadCredentials).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serializes complete credential requests while a prior reload is pending", async () => {
    let releaseFirstReload!: () => void;
    let markFirstReloadStarted!: () => void;
    const firstReloadStarted = new Promise<void>((resolve) => {
      markFirstReloadStarted = resolve;
    });
    const firstReloadGate = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    const calls: WorkflowSupervisorCredentialKey[][] = [];
    const app = await credentialApp(async (keys) => {
      calls.push([...keys]);
      if (keys.includes("exa")) {
        markFirstReloadStarted();
        await firstReloadGate;
      }
    });
    try {
      const firstResponse = app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "first-exa-test-key" },
      });
      await firstReloadStarted;

      const secondResponse = app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { perplexityApiKey: "second-perplexity-test-key" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual([["exa"]]);

      releaseFirstReload();
      expect((await firstResponse).statusCode).toBe(200);
      expect((await secondResponse).statusCode).toBe(200);
      expect(calls).toEqual([["exa"], ["perplexity"]]);
      const persisted = fs.readFileSync(envPath, "utf8");
      expect(persisted).toContain("EXA_API_KEY=first-exa-test-key");
      expect(persisted).toContain("PERPLEXITY_API_KEY=second-perplexity-test-key");
    } finally {
      releaseFirstReload();
      await app.close();
    }
  });

  it("preserves the existing successful behavior when no supervisor port is supplied", async () => {
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { perplexityApiKey: "perplexity-test-key" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().perplexity).toEqual({
        set: true,
        masked: "perp…-key",
      });
    } finally {
      await app.close();
    }
  });
});
