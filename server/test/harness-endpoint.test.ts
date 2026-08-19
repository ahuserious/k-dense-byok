/**
 * The endpoint lane F8's "Settings ▸ Kady CLI" surface consumes.
 *
 * F2 owns no `web/`, so this payload is the whole of what makes an honest state
 * renderable (§6.7): every harness reports adapter presence, resolvability and
 * the reason it is not selectable. Two defects are pinned directly — #71 (no
 * filesystem path in an error body) and #62 (every field always present, so a
 * client destructuring the payload cannot throw in render phase).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHarnessList,
  registerHarnessRoutes,
  validateClaudeBinaryPathOverride,
  validateClaudeSystemPromptOverride,
  type HarnessListResponse,
} from "../src/api/harness.ts";
import { WORKFLOW_HARNESS_IDS } from "../src/workflows/harness-registry.ts";
import { resolveClaudeCodeBinary } from "../src/workflows/claude-code-relay.ts";
import { readWorkflowHarnessSettings } from "../src/workflows/harness-settings.ts";

const apps: ReturnType<typeof Fastify>[] = [];
const temporaryDirectories: string[] = [];
let previousSettingsPath: string | undefined;
let settingsPathOverridden = false;

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
  if (settingsPathOverridden) {
    if (previousSettingsPath === undefined) delete process.env.KADY_HARNESS_SETTINGS_PATH;
    else process.env.KADY_HARNESS_SETTINGS_PATH = previousSettingsPath;
    settingsPathOverridden = false;
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f2-endpoint-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Point the store at a scratch file so no test touches the developer's ~/.kady. */
function isolatedSettingsFile(): string {
  const file = path.join(temporaryDirectory(), "harness-settings.json");
  previousSettingsPath = process.env.KADY_HARNESS_SETTINGS_PATH;
  settingsPathOverridden = true;
  process.env.KADY_HARNESS_SETTINGS_PATH = file;
  return file;
}

function fakeClaudeBinary(): string {
  const file = path.join(temporaryDirectory(), "claude");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

async function harnessApp() {
  const app = Fastify();
  apps.push(app);
  await registerHarnessRoutes(app);
  await app.ready();
  return app;
}

describe("GET /harnesses", () => {
  it("answers with every registry harness and a fully populated shape (#62)", () => {
    const payload = buildHarnessList({
      findExecutable: () => null,
      resolveClaudeCode: () => ({ state: "not-found", detail: "Claude Code was not found." }),
      readSettings: () => ({ version: 1, claudeCode: {} }),
    });
    expect(payload.version).toBe(1);
    expect(payload.harnesses.map((entry) => entry.id)).toEqual([...WORKFLOW_HARNESS_IDS]);
    for (const entry of payload.harnesses) {
      // Nothing is ever absent: a client reading `entry.binaryPath?.state` on a
      // partially-built payload is exactly how #62 took the app down.
      expect(Object.keys(entry).sort()).toEqual([
        "adapter",
        "availability",
        "binaryPath",
        "detail",
        "executables",
        "hasAdapter",
        "id",
        "label",
        "resolvedExecutable",
        "summary",
        "supportsBinaryPathOverride",
      ]);
      expect(typeof entry.label).toBe("string");
      expect(entry.executables.length).toBeGreaterThan(0);
    }
  });

  it("marks the three new harnesses adapterless and disabled, with a reason", () => {
    const payload = buildHarnessList({
      findExecutable: (command) => `/opt/kady/bin/${command}`,
      resolveClaudeCode: () => ({ state: "not-found", detail: "not found" }),
      readSettings: () => ({ version: 1, claudeCode: {} }),
    });
    for (const id of ["deepseek", "grok-cli", "oh-my-pi"] as const) {
      const entry = payload.harnesses.find((candidate) => candidate.id === id);
      expect(entry?.hasAdapter).toBe(false);
      expect(entry?.adapter).toBeNull();
      expect(entry?.availability).toBe("no-adapter");
      expect(entry?.detail).toBeTruthy();
      // #71: the reason a picker renders must not carry a filesystem path.
      expect(entry?.detail).not.toContain("/opt/kady/bin");
    }
  });

  it("reports pi ready and claude-code ready once its binary resolves", () => {
    const binary = fakeClaudeBinary();
    const payload = buildHarnessList({
      findExecutable: () => null,
      resolveClaudeCode: () => ({ state: "resolved", binaryPath: binary, source: "override" }),
      readSettings: () => ({ version: 1, claudeCode: { binaryPath: binary } }),
    });
    const pi = payload.harnesses.find((entry) => entry.id === "pi");
    expect(pi?.availability).toBe("ready");
    expect(pi?.binaryPath).toBeNull();

    const claude = payload.harnesses.find((entry) => entry.id === "claude-code");
    expect(claude?.availability).toBe("ready");
    expect(claude?.supportsBinaryPathOverride).toBe(true);
    expect(claude?.binaryPath).toMatchObject({
      state: "resolved",
      resolvedPath: binary,
      source: "override",
      override: binary,
    });
    // Exactly one harness offers the path editor.
    expect(
      payload.harnesses.filter((entry) => entry.supportsBinaryPathOverride).length,
    ).toBe(1);
  });

  it("reports a rejected override as disabled-and-why, not as ready", () => {
    const payload = buildHarnessList({
      findExecutable: (command) => `/usr/bin/${command}`,
      resolveClaudeCode: () => ({
        state: "rejected",
        source: "override",
        detail: '"/nope/claude" is not an executable file.',
      }),
      readSettings: () => ({ version: 1, claudeCode: { binaryPath: "/nope/claude" } }),
    });
    const claude = payload.harnesses.find((entry) => entry.id === "claude-code");
    expect(claude?.availability).toBe("rejected");
    expect(claude?.resolvedExecutable).toBeNull();
    expect(claude?.binaryPath?.state).toBe("rejected");
    expect(claude?.detail).toContain("/nope/claude");
  });

  it("serves the list over HTTP", async () => {
    isolatedSettingsFile();
    const app = await harnessApp();
    const response = await app.inject({ method: "GET", url: "/harnesses" });
    expect(response.statusCode).toBe(200);
    const payload = response.json<HarnessListResponse>();
    expect(payload.harnesses).toHaveLength(WORKFLOW_HARNESS_IDS.length);
  });
});

describe("claude code path override", () => {
  it("rejects a path that does not resolve, before persisting it", () => {
    const rejected = validateClaudeBinaryPathOverride(
      { binaryPath: "/definitely/not/here/claude" },
      resolveClaudeCodeBinary,
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("unresolvable-path");
    // The only path in the body is the one the caller supplied (#71).
    expect(rejected.body.detail).toContain("/definitely/not/here/claude");
  });

  it("rejects a missing or empty body with the next action", () => {
    for (const body of [undefined, null, {}, { binaryPath: "  " }, { binaryPath: 7 }]) {
      const rejected = validateClaudeBinaryPathOverride(body, resolveClaudeCodeBinary);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.body.error).toBe("invalid-request");
      expect(rejected.body.detail).toContain("DELETE");
    }
  });

  it("persists a resolvable override and clears it again", async () => {
    isolatedSettingsFile();
    const binary = fakeClaudeBinary();
    const app = await harnessApp();

    const saved = await app.inject({
      method: "PUT",
      url: "/harnesses/claude-code/binary-path",
      payload: { binaryPath: binary },
    });
    expect(saved.statusCode).toBe(200);
    expect(readWorkflowHarnessSettings().claudeCode.binaryPath).toBe(binary);
    const savedClaude = saved.json<HarnessListResponse>().harnesses
      .find((entry) => entry.id === "claude-code");
    expect(savedClaude?.binaryPath?.resolvedPath).toBe(binary);
    expect(savedClaude?.binaryPath?.source).toBe("override");

    const cleared = await app.inject({
      method: "DELETE",
      url: "/harnesses/claude-code/binary-path",
    });
    expect(cleared.statusCode).toBe(200);
    expect(readWorkflowHarnessSettings().claudeCode.binaryPath).toBeUndefined();
  });

  it("refuses an unusable override over HTTP with a 400 and no server path", async () => {
    isolatedSettingsFile();
    const app = await harnessApp();
    const response = await app.inject({
      method: "PUT",
      url: "/harnesses/claude-code/binary-path",
      payload: { binaryPath: "/definitely/not/here/claude" },
    });
    expect(response.statusCode).toBe(400);
    expect(readWorkflowHarnessSettings().claudeCode.binaryPath).toBeUndefined();
    const body = response.json<{ error: string; detail: string }>();
    expect(body.error).toBe("unresolvable-path");
    expect(body.detail).not.toContain(os.homedir());
  });

  it("changes which binary the relay resolves", async () => {
    isolatedSettingsFile();
    const first = fakeClaudeBinary();
    const second = fakeClaudeBinary();
    const app = await harnessApp();

    await app.inject({
      method: "PUT",
      url: "/harnesses/claude-code/binary-path",
      payload: { binaryPath: first },
    });
    expect(resolveClaudeCodeBinary()).toEqual({
      state: "resolved",
      binaryPath: first,
      source: "override",
    });

    await app.inject({
      method: "POST",
      url: "/harnesses/claude-code/binary-path",
      payload: { binaryPath: second },
    });
    expect(resolveClaudeCodeBinary()).toEqual({
      state: "resolved",
      binaryPath: second,
      source: "override",
    });
  });
});

describe("claude code system-prompt override", () => {
  it("bounds and trims the override", () => {
    expect(validateClaudeSystemPromptOverride({ systemPrompt: "  Be terse.  " }))
      .toEqual({ ok: true, systemPrompt: "Be terse." });
    const tooLong = validateClaudeSystemPromptOverride({
      systemPrompt: "x".repeat(16 * 1024 + 1),
    });
    expect(tooLong.ok).toBe(false);
    const empty = validateClaudeSystemPromptOverride({ systemPrompt: "" });
    expect(empty.ok).toBe(false);
  });

  it("persists and clears the override, and reports it in the list", async () => {
    isolatedSettingsFile();
    const app = await harnessApp();
    const saved = await app.inject({
      method: "PUT",
      url: "/harnesses/claude-code/system-prompt",
      payload: { systemPrompt: "You are Kady's relayed reviewer." },
    });
    expect(saved.statusCode).toBe(200);
    const claude = saved.json<HarnessListResponse>().harnesses
      .find((entry) => entry.id === "claude-code");
    expect(claude?.binaryPath?.systemPrompt).toBe("You are Kady's relayed reviewer.");
    expect(claude?.binaryPath?.systemPromptMaxBytes).toBe(16 * 1024);
    expect(readWorkflowHarnessSettings().claudeCode.systemPrompt)
      .toBe("You are Kady's relayed reviewer.");

    await app.inject({ method: "DELETE", url: "/harnesses/claude-code/system-prompt" });
    expect(readWorkflowHarnessSettings().claudeCode.systemPrompt).toBeUndefined();
  });
});
