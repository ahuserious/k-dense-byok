/**
 * The Claude Code relay (matrix rows 7 and 16), unit-level.
 *
 * The end-to-end proof that a `harness: "claude-code"` node reaches this adapter
 * through the *production* supervised seam lives in
 * `supervisor-node-control-transport.test.ts`. What is pinned here is everything
 * that decides what the operating system is actually handed: the resolution
 * order, the override, the argv and stdin, and the fail-closed states.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BIN_PATH_ENV_VAR,
  CLAUDE_BINARY_NAME,
  buildClaudeCodeInvocation,
  claudeNativeInstallerPath,
  createClaudeCodeRelaySession,
  openClaudeCodeRelay,
  resolveClaudeCodeBinary,
  stripNodeControlEnvelope,
  unbindableClaudeCodeControls,
  type ClaudeCodeProcessResult,
  type RunClaudeCodeProcessInput,
} from "../src/workflows/claude-code-relay.ts";
import { WorkflowHarnessDispatchError } from "../src/workflows/harness-registry.ts";
import type { OwnedDelegationRequest } from "../pi-packages/dag-fusion-drive/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f2-claude-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executableFile(directory: string, name = CLAUDE_BINARY_NAME): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

const SELECTION = {
  harness: "claude-code",
  label: "Claude Code CLI",
  adapter: "claude-code-relay",
  executable: CLAUDE_BINARY_NAME,
} as const;

function relayRequest(overrides: Partial<OwnedDelegationRequest> = {}) {
  return {
    requestId: "dagcall_1",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "dagx_1:agent",
    agent: "dag-workflow-readonly-executor",
    task: "Summarise the supplied evidence.",
    context: "fresh",
    cwd: "/tmp",
    model: "claude-opus-5",
    thinking: "high",
    timeoutMs: 30_000,
    turnBudget: { maxTurns: 4, graceTurns: 0 },
    toolBudget: { soft: 4, hard: 8, block: "*" },
    artifacts: false,
    result: { kind: "text" },
    ...overrides,
  } as unknown as OwnedDelegationRequest;
}

describe("claude code binary resolution", () => {
  it("puts the user's override ahead of every other source", () => {
    const directory = temporaryDirectory();
    const override = executableFile(directory, "my-claude");
    const other = executableFile(temporaryDirectory());
    const resolution = resolveClaudeCodeBinary({
      settings: { binaryPath: override },
      env: { [CLAUDE_BIN_PATH_ENV_VAR]: other },
      findExecutable: () => other,
    });
    expect(resolution).toEqual({
      state: "resolved",
      binaryPath: override,
      source: "override",
    });
  });

  it("expands an override that names the containing directory", () => {
    const directory = temporaryDirectory();
    executableFile(directory);
    const resolution = resolveClaudeCodeBinary({
      settings: { binaryPath: directory },
      env: {},
      findExecutable: () => null,
    });
    expect(resolution).toEqual({
      state: "resolved",
      binaryPath: path.join(directory, CLAUDE_BINARY_NAME),
      source: "override",
    });
  });

  it("rejects an unusable override instead of falling back to another binary", () => {
    const fallback = executableFile(temporaryDirectory());
    const resolution = resolveClaudeCodeBinary({
      settings: { binaryPath: path.join(temporaryDirectory(), "absent") },
      env: { [CLAUDE_BIN_PATH_ENV_VAR]: fallback },
      findExecutable: () => fallback,
    });
    expect(resolution.state).toBe("rejected");
    if (resolution.state !== "rejected") return;
    expect(resolution.source).toBe("override");
    // The path in this message is the caller's own, which #71 permits.
    expect(resolution.detail).toContain("absent");
    expect(resolution.detail).toContain("Point this setting at");
  });

  it("falls through override → env → native installer → PATH", () => {
    const environmentBinary = executableFile(temporaryDirectory());
    expect(
      resolveClaudeCodeBinary({
        settings: {},
        env: { [CLAUDE_BIN_PATH_ENV_VAR]: environmentBinary },
        findExecutable: () => null,
      }),
    ).toEqual({ state: "resolved", binaryPath: environmentBinary, source: "env" });

    const nativeInstaller = claudeNativeInstallerPath();
    expect(
      resolveClaudeCodeBinary({
        settings: {},
        env: {},
        findExecutable: () => null,
        classifyPath: (candidate) =>
          candidate === nativeInstaller ? "file" : "missing",
      }),
    ).toEqual({
      state: "resolved",
      binaryPath: nativeInstaller,
      source: "native-installer",
    });

    const onPath = "/usr/local/bin/claude";
    expect(
      resolveClaudeCodeBinary({
        settings: {},
        env: {},
        classifyPath: () => "missing",
        findExecutable: (command) => (command === "claude" ? onPath : null),
      }),
    ).toEqual({ state: "resolved", binaryPath: onPath, source: "path" });
  });

  it("reports an honest not-found state, never a silent fallback", () => {
    const resolution = resolveClaudeCodeBinary({
      settings: {},
      env: {},
      classifyPath: () => "missing",
      findExecutable: () => null,
    });
    expect(resolution.state).toBe("not-found");
    if (resolution.state !== "not-found") return;
    expect(resolution.detail).toContain("install.sh");
    expect(resolution.detail).toContain("Settings");
  });

  it("fails the relay closed when nothing resolves", () => {
    let thrown: unknown;
    try {
      openClaudeCodeRelay({
        selection: SELECTION,
        settings: {},
        resolve: () => ({ state: "not-found", detail: "Claude Code was not found." }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
    expect((thrown as WorkflowHarnessDispatchError).code)
      .toBe("WORKFLOW_HARNESS_NOT_INSTALLED");
  });
});

describe("claude code relay invocation", () => {
  it("invokes print mode and carries the system-prompt override into argv", () => {
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest(),
      binaryPath: "/opt/claude/claude",
      binarySource: "override",
      systemPrompt: "You are Kady's relayed reviewer.",
      structuredOutput: false,
    });
    expect(invocation.argv[0]).toBe("-p");
    expect(invocation.argv).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-opus-5",
      "--system-prompt",
      "You are Kady's relayed reviewer.",
    ]);
    expect(invocation.stdin).toBe("Summarise the supplied evidence.");
    expect(invocation.adapter).toBe("claude-code-relay");
    expect(invocation.launchContractDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits the system-prompt flag entirely when no override is set", () => {
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest(),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
      structuredOutput: false,
    });
    expect(invocation.argv).not.toContain("--system-prompt");
  });

  it("keeps the Pi-only node-control envelope out of the Claude prompt", () => {
    const encoded = Buffer.from(
      JSON.stringify({ version: 1, harness: "claude-code" }),
      "utf8",
    ).toString("base64url");
    const stripped = stripNodeControlEnvelope(
      `KADY_NODE_CONTROL_V1:${encoded}\nKady node execution context\n\nDo the work.`,
    );
    expect(stripped.prompt).toBe("Kady node execution context\n\nDo the work.");
    expect(stripped.nodeControl).toEqual({ version: 1, harness: "claude-code" });
  });

  it("refuses sampling controls the CLI cannot express rather than dropping them", () => {
    expect(unbindableClaudeCodeControls(undefined)).toEqual([]);
    expect(
      unbindableClaudeCodeControls({
        providerRequest: { temperature: 1, top_p: 1, sampling: {} },
      }),
    ).toEqual([]);
    expect(
      unbindableClaudeCodeControls({
        providerRequest: { temperature: 0.2, top_p: 0.9, sampling: { seed: 7 } },
      }),
    ).toEqual([
      "hyperparameters.temperature",
      "hyperparameters.top_p",
      "hyperparameters.sampling.seed",
    ]);
  });

  it("fails a node whose bindings the CLI cannot honour, before spawning", async () => {
    let spawned = 0;
    const runProcess = async (): Promise<ClaudeCodeProcessResult> => {
      spawned += 1;
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath: "/opt/claude/claude", source: "path" },
      systemPrompt: undefined,
      runProcess,
    });
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        harness: "claude-code",
        providerRequest: { temperature: 0.2, top_p: 1, sampling: {} },
      }),
      "utf8",
    ).toString("base64url");
    const reconciled: string[] = [];
    await expect(
      session.host.delegate(
        relayRequest({ task: `KADY_NODE_CONTROL_V1:${encoded}\nDo the work.` }),
        {
          limits: { maxTokens: 1_000, maxCostUsd: 1 },
          reconcileUsage: (settlement) => {
            reconciled.push(settlement.reason);
          },
        },
      ),
    ).rejects.toThrow(WorkflowHarnessDispatchError);
    expect(spawned).toBe(0);
    // The pre-reserved node budget is still settled; it is refused, not leaked.
    expect(reconciled).toEqual(["protocol-error"]);
  });

  it("records the relay path and the launch digest on the receipt", async () => {
    const seen: RunClaudeCodeProcessInput[] = [];
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: {
        state: "resolved",
        binaryPath: "/opt/claude/claude",
        source: "override",
      },
      systemPrompt: "Be terse.",
      runProcess: async (input) => {
        seen.push(input);
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "All good.",
            total_cost_usd: 0.01,
            num_turns: 2,
            usage: { input_tokens: 12, output_tokens: 3 },
          }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    const receipt = await session.host.delegate(relayRequest(), {
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    expect(receipt.response.status).toBe("completed");
    expect(receipt.resolved?.agent).toBe("claude-code-relay");
    expect(receipt.resolved?.launchContractDigest)
      .toBe(session.invocations[0]?.launchContractDigest);
    expect(session.invocations[0]?.binaryPath).toBe("/opt/claude/claude");
    expect(session.invocations[0]?.binarySource).toBe("override");
    expect(seen[0]?.binaryPath).toBe("/opt/claude/claude");
    expect(seen[0]?.argv).toContain("--system-prompt");
    expect(receipt.usage?.totalTokens).toBe(15);
  });

  it("reports a non-zero exit and a timeout as terminal failures, not successes", async () => {
    const failing = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath: "/opt/claude/claude", source: "path" },
      systemPrompt: undefined,
      runProcess: async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false }),
    });
    const failed = await failing.host.delegate(relayRequest(), {
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    expect(failed.response.status).toBe("failed");

    const timing = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath: "/opt/claude/claude", source: "path" },
      systemPrompt: undefined,
      runProcess: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    const timedOut = await timing.host.delegate(relayRequest(), {
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    expect(timedOut.response.status).toBe("timed_out");
  });

  it("reports unparseable structured output as structured_output_failed", async () => {
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath: "/opt/claude/claude", source: "path" },
      systemPrompt: undefined,
      runProcess: async () => ({
        code: 0,
        stdout: JSON.stringify({ result: "not json at all" }),
        stderr: "",
        timedOut: false,
      }),
    });
    const receipt = await session.host.delegate(
      relayRequest({ result: { kind: "structured", schema: {} } } as never),
      { limits: { maxTokens: 1_000, maxCostUsd: 1 }, reconcileUsage: () => undefined },
    );
    expect(receipt.response.status).toBe("structured_output_failed");
  });
});
