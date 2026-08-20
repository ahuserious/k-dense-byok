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
import { spawnSync } from "node:child_process";
import {
  CLAUDE_BIN_PATH_ENV_VAR,
  CLAUDE_BINARY_NAME,
  CLAUDE_CODE_REQUIRED_POLICY_FLAGS,
  CLAUDE_CODE_UNBOUND_CONTROLS,
  assertClaudeCodeCliSupportsPolicy,
  buildClaudeCodeInvocation,
  claudeCodeCliPolicySupport,
  claudeCodeModelArgument,
  claudeNativeInstallerPath,
  createClaudeCodeRelaySession,
  openClaudeCodeRelay,
  resetClaudeCodePolicySupportCache,
  resolveClaudeCodeBinary,
  stripNodeControlEnvelope,
  translateClaudeCodeToolPolicy,
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

/**
 * The node-control envelope exactly as `resolveS4NodeExecutionBindings` builds
 * it (`kady-node-executor.ts:337-340`) and `s4ControlledDelegationTask` encodes
 * it. Round 1's fixtures carried only `providerRequest`, which is why the
 * dropped tool policy was invisible to the suite.
 */
function controlledTask(
  task: string,
  overrides: Record<string, unknown> = {},
): string {
  const bindings = {
    version: 1,
    harness: "claude-code",
    providerRequest: { temperature: 1, top_p: 1, sampling: {} },
    databases: [],
    skills: { mode: "manual", configured: [], delegated: [] },
    subagents: { mode: "inherit", permitted: false },
    autonomy: "strict",
    toolPolicy: { allowedTools: ["read", "grep", "find", "ls"] },
    billingMode: "api-credits",
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(bindings), "utf8").toString("base64url");
  return `KADY_NODE_CONTROL_V1:${encoded}\n${task}`;
}

function relayRequest(overrides: Partial<OwnedDelegationRequest> = {}) {
  return {
    requestId: "dagcall_1",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "dagx_1:agent",
    agent: "dag-workflow-readonly-executor",
    task: controlledTask("Summarise the supplied evidence."),
    context: "fresh",
    cwd: "/tmp",
    model: "anthropic/claude-opus-4-1",
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

describe("claude code CLI policy support", () => {
  afterEach(() => {
    resetClaudeCodePolicySupportCache();
  });

  it("matches whole flag tokens, so --allowedTools is not --tools", () => {
    // The relay's confinement is expressed entirely in flags. A substring match
    // would report `--tools` as present in a help text that only advertises
    // `--allowedTools`, which is the exact confusion round-3 HIGH 1 was about.
    const onlyAllowed =
      "--allowedTools, --allowed-tools <tools...>  allow without prompting";
    expect(claudeCodeCliPolicySupport(onlyAllowed).missing)
      .toContain("--tools");
    const withCap = `${onlyAllowed}\n--tools <tools...>  restrict built-ins`;
    expect(claudeCodeCliPolicySupport(withCap).missing)
      .not.toContain("--tools");
    // A renamed flag must not pass by prefix either.
    expect(
      claudeCodeCliPolicySupport("--safe-mode-extra\n--strict-mcp-config-v2")
        .missing,
    ).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config"]));
  });

  it("refuses the adapter when the binary cannot express the policy", () => {
    let thrown: unknown;
    try {
      assertClaudeCodeCliSupportsPolicy("/opt/claude/claude", () => ({
        ok: true,
        helpText: "--allowedTools <tools...>\n--permission-mode <mode>",
      }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
    const failure = thrown as WorkflowHarnessDispatchError;
    // NOT_BOUND rather than NOT_INSTALLED: the harness is installed and it is
    // the binding that is unavailable.
    expect(failure.code).toBe("WORKFLOW_HARNESS_NOT_BOUND");
    expect(failure.message).toContain("--tools");
    // Names the user's next action and leaks no filesystem path (#71).
    expect(failure.message).toContain("Update Claude Code");
    expect(failure.message).not.toContain("/opt/claude");
  });

  it("refuses the adapter when the binary does not answer --help", () => {
    expect(() =>
      assertClaudeCodeCliSupportsPolicy("/opt/claude/claude", () => ({
        ok: false,
        detail: "The Claude Code binary did not answer --help.",
      }))
    ).toThrow(WorkflowHarnessDispatchError);
  });

  it("probes a path once per process", () => {
    let calls = 0;
    const probe = (): { ok: true; helpText: string } => {
      calls += 1;
      return {
        ok: true,
        helpText: CLAUDE_CODE_REQUIRED_POLICY_FLAGS.map((flag) =>
          `${flag} <value>`
        ).join("\n"),
      };
    };
    assertClaudeCodeCliSupportsPolicy("/opt/claude/claude", probe);
    assertClaudeCodeCliSupportsPolicy("/opt/claude/claude", probe);
    expect(calls).toBe(1);
  });

  it("holds against the Claude Code binary installed on this machine", () => {
    // The version-aware half. Whichever branch runs, it asserts something: a
    // resolvable binary must advertise every flag the policy is expressed in,
    // and an unresolvable one must fail the adapter closed. This test is what
    // turns "the CLI supports --tools" from a belief into a measurement.
    const resolution = resolveClaudeCodeBinary({ settings: {} });
    if (resolution.state !== "resolved") {
      expect(() =>
        openClaudeCodeRelay({ selection: SELECTION, settings: {} })
      ).toThrow(WorkflowHarnessDispatchError);
      return;
    }
    const help = spawnSync(resolution.binaryPath, ["--help"], {
      encoding: "utf8",
      timeout: 20_000,
      shell: false,
    });
    expect(help.error).toBeUndefined();
    const support = claudeCodeCliPolicySupport(
      `${help.stdout ?? ""}\n${help.stderr ?? ""}`,
    );
    expect(support.missing).toEqual([]);
    expect(support.ok).toBe(true);
  });
});

describe("claude code relay invocation", () => {
  it("invokes print mode and carries the system-prompt override into argv", () => {
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest(),
      binaryPath: "/opt/claude/claude",
      binarySource: "override",
      systemPrompt: "You are Kady's relayed reviewer.",
    });
    expect(invocation.argv[0]).toBe("-p");
    expect(invocation.argv).toEqual([
      "-p",
      "--output-format",
      "json",
      // The provider prefix is stripped; `claude --model` takes an Anthropic id.
      "--model",
      "claude-opus-4-1",
      "--system-prompt",
      "You are Kady's relayed reviewer.",
      // The availability cap comes before the approval rule.
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--disallowedTools",
      expect.any(String),
      "--permission-mode",
      "default",
      "--strict-mcp-config",
      "--safe-mode",
      "--max-turns",
      "4",
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
    });
    expect(invocation.argv).not.toContain("--system-prompt");
  });

  it.each([
    ["a missing envelope", "Do the work."],
    ["a malformed envelope", "KADY_NODE_CONTROL_V1:!!!not-base64!!!\nDo the work."],
    [
      "an envelope without a tool policy",
      controlledTask("Do the work.", { toolPolicy: undefined }),
    ],
  ])("refuses %s instead of launching with CLI defaults", (_label, task) => {
    expect(() =>
      buildClaudeCodeInvocation({
        request: relayRequest({ task }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      })
    ).toThrow(/node-control envelope|tool grant/);
  });

  it("turns the node's tool policy into real CLI flags, not a comment", () => {
    // `autonomy` is BOUND in NodeSpec v1 because it is the child's tool gate.
    // The Pi child enforces `toolPolicy.allowedTools` with `setActiveTools`
    // (`workflow-delegation-session.ts:527-529`); the relay has to enforce the
    // same policy in the CLI's own vocabulary or the contract row is false for
    // this harness.
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest({ task: controlledTask("Do the work.") }),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    // `--tools` is the availability cap. The CLI reference is explicit that
    // `--allowedTools` only removes the approval prompt and that restricting
    // availability needs `--tools`, so an allowlist alone left `Agent`, `Bash`
    // and every other built-in in the child's context (round-3 HIGH 1).
    const toolsIndex = invocation.argv.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(invocation.argv[toolsIndex + 1]).toBe("Read,Grep,Glob");
    const allowedIndex = invocation.argv.indexOf("--allowedTools");
    expect(allowedIndex).toBeGreaterThan(-1);
    expect(invocation.argv[allowedIndex + 1]).toBe("Read,Grep,Glob");
    const disallowedIndex = invocation.argv.indexOf("--disallowedTools");
    expect(disallowedIndex).toBeGreaterThan(-1);
    const denyList = invocation.argv[disallowedIndex + 1]?.split(",") ?? [];
    for (
      const denied of [
        // `--tools` does not touch MCP tools; the reference names this exact
        // rule as the way to remove them.
        "mcp__*",
        // The current subagent built-in. Round 3 found only the obsolete
        // `Task` name denied while the live tools reference documents `Agent`
        // as the subagent tool needing no permission.
        "Agent",
        "Task",
        "Bash",
        "Write",
        "Edit",
        "Skill",
        "WebFetch",
      ]
    ) {
      expect(denyList).toContain(denied);
    }
    const modeIndex = invocation.argv.indexOf("--permission-mode");
    expect(modeIndex).toBeGreaterThan(-1);
    // Never `bypassPermissions`: in -p mode an approval prompt cannot be
    // answered, so `default` is what makes an unlisted tool fail closed.
    expect(invocation.argv[modeIndex + 1]).toBe("default");
    expect(invocation.argv).not.toContain("bypassPermissions");
    // No MCP server and no project customization may hand the child a
    // capability the node never declared.
    expect(invocation.argv).toContain("--strict-mcp-config");
    expect(invocation.argv).not.toContain("--mcp-config");
    expect(invocation.argv).toContain("--safe-mode");
  });

  it("caps availability at nothing when the node granted nothing", () => {
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest({
        task: controlledTask("Do the work.", {
          autonomy: "strict",
          subagents: { mode: "inherit", permitted: false },
          toolPolicy: { allowedTools: [] },
        }),
      }),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    // `--tools ""` disables every built-in tool. An omitted flag would have
    // meant "all of them", which is the opposite of what the node declared.
    const toolsIndex = invocation.argv.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(invocation.argv[toolsIndex + 1]).toBe("");
  });

  it("maps the tool vocabulary exactly, and refuses an id it does not know", () => {
    expect(translateClaudeCodeToolPolicy(["read", "grep", "find", "ls"]))
      .toEqual({ ok: true, allowed: ["Read", "Grep", "Glob"] });
    expect(translateClaudeCodeToolPolicy([])).toEqual({ ok: true, allowed: [] });
    // A tool added to Pi's vocabulary later must fail this suite rather than
    // silently vanish from the relayed child's policy.
    expect(translateClaudeCodeToolPolicy(["read", "write"]))
      .toEqual({ ok: false, unbindable: ["write"] });
    // `subagent` has no faithful translation: a Claude Code Task child is not
    // itself bound by this allowlist, so granting it grants strictly more.
    expect(translateClaudeCodeToolPolicy(["read", "subagent"]))
      .toEqual({ ok: false, unbindable: ["subagent"] });
  });

  it("refuses the node rather than granting a tool policy it cannot honour", () => {
    let thrown: unknown;
    try {
      buildClaudeCodeInvocation({
        request: relayRequest({
          task: controlledTask("Do the work.", {
            autonomy: "loose",
            subagents: { mode: "inherit", permitted: true },
            toolPolicy: { allowedTools: ["read", "grep", "find", "ls", "subagent"] },
          }),
        }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
    const dispatchError = thrown as WorkflowHarnessDispatchError;
    expect(dispatchError.code).toBe("WORKFLOW_HARNESS_NOT_BOUND");
    expect(dispatchError.message).toContain("autonomy/toolPolicy");
    expect(dispatchError.message).toContain("subagents");
    expect(dispatchError.message).toContain("run it on the pi harness");
    // #71: no filesystem path in the diagnostic.
    expect(dispatchError.message).not.toMatch(/(?:^|\s)\/[^\s]/);
  });

  it("refuses a node whose named skills the relay cannot inject", () => {
    expect(() =>
      buildClaudeCodeInvocation({
        request: relayRequest({
          task: controlledTask("Do the work.", {
            skills: {
              mode: "manual",
              configured: ["kady-evidence"],
              delegated: ["kady-evidence"],
            },
          }),
        }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      })
    ).toThrow(/skills/);
  });

  it("refuses delegated auto skills even when the configured list is empty", () => {
    expect(() =>
      buildClaudeCodeInvocation({
        request: relayRequest({
          task: controlledTask("Do the work.", {
            skills: {
              mode: "auto",
              configured: [],
              delegated: ["kady-evidence"],
            },
          }),
          skill: false,
        }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      })
    ).toThrow(/effective delegated skill set/);
  });

  it("refuses the required byom skill carried on request.skill", () => {
    expect(() =>
      buildClaudeCodeInvocation({
        request: relayRequest({
          task: controlledTask("Solve the Lean theorem.", {
            skills: { mode: "auto", configured: [], delegated: [] },
          }),
          skill: "byom-dag-fusion",
        }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      })
    ).toThrow(/effective delegated skill set/);
  });

  it("refuses automatic skill discovery carried as request.skill=true", () => {
    expect(() =>
      buildClaudeCodeInvocation({
        request: relayRequest({
          task: controlledTask("Do the work.", {
            skills: { mode: "auto", configured: [], delegated: [] },
          }),
          skill: true,
        }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      })
    ).toThrow(/effective delegated skill set/);
  });

  it("refuses a model reference the CLI cannot run, instead of relaying the slug", () => {
    // `modelReference` produces `${provider}/${id}` (`agent/models.ts:387-391`).
    expect(claudeCodeModelArgument("anthropic/claude-sonnet-4-5"))
      .toEqual({ ok: true, model: "claude-sonnet-4-5" });
    expect(claudeCodeModelArgument(undefined)).toEqual({ ok: true, model: undefined });
    for (const reference of [
      "openrouter/anthropic/claude-sonnet-4",
      "openai/gpt-5",
      "openrouter/fusion",
      "claude-opus-5",
    ]) {
      const mapped = claudeCodeModelArgument(reference);
      expect(mapped.ok, reference).toBe(false);
      if (mapped.ok) continue;
      expect(mapped.detail).toContain(reference);
    }
    let thrown: unknown;
    try {
      buildClaudeCodeInvocation({
        request: relayRequest({ model: "openrouter/anthropic/claude-sonnet-4" }),
        binaryPath: "/opt/claude/claude",
        binarySource: "path",
        systemPrompt: undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
    expect((thrown as WorkflowHarnessDispatchError).message).toContain("model");
  });

  it("sends the node's structured-output schema, and digests what it sent", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" }, score: { type: "number" } },
      required: ["verdict", "score"],
      additionalProperties: false,
    };
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest({
        task: controlledTask("Judge the evidence."),
        result: { kind: "structured", schema },
      } as never),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    expect(invocation.structuredSchema).toEqual(schema);
    expect(invocation.stdin).toContain("Judge the evidence.");
    expect(invocation.stdin).toContain("It must validate against this JSON Schema:");
    expect(invocation.stdin).toContain(JSON.stringify(schema));

    // The digest covers stdin, so two launches differing only in the schema are
    // not the same launch. Round 1 digested binary + argv + systemPrompt only,
    // and the prompt — the only place the node's work travels — was uncovered.
    const other = buildClaudeCodeInvocation({
      request: relayRequest({
        task: controlledTask("Judge the evidence."),
        result: { kind: "structured", schema: { type: "object", properties: {} } },
      } as never),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    expect(other.launchContractDigest).not.toBe(invocation.launchContractDigest);

    const otherWorkingDirectory = buildClaudeCodeInvocation({
      request: relayRequest({
        cwd: "/tmp/other-workspace",
        task: controlledTask("Judge the evidence."),
        result: { kind: "structured", schema },
      } as never),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    expect(otherWorkingDirectory.launchContractDigest)
      .not.toBe(invocation.launchContractDigest);
  });

  it("publishes the controls it cannot bind rather than dropping them quietly", () => {
    const controls = CLAUDE_CODE_UNBOUND_CONTROLS.map((entry) => entry.control);
    expect(controls).toEqual(["toolBudget", "billingMode", "supervisedBudget"]);
    for (const entry of CLAUDE_CODE_UNBOUND_CONTROLS) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
    const invocation = buildClaudeCodeInvocation({
      request: relayRequest({ task: controlledTask("Do the work.") }),
      binaryPath: "/opt/claude/claude",
      binarySource: "path",
      systemPrompt: undefined,
    });
    expect([...invocation.unboundControls]).toEqual(controls);
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

/**
 * The decisive round-2 test.
 *
 * Round 1's only end-to-end relay item spawned a four-line shell script that
 * `cat`ed a hand-written fixture whose `result` happened to match, so a relay
 * that never sent the structured-output schema was structurally invisible. This
 * fake binary is *schema-driven*: it reads stdin, finds the JSON Schema the
 * relay embedded, and synthesises an instance of exactly that schema. If the
 * relay stops sending the schema — or sends a different one — the returned
 * object changes or disappears, and these assertions fail. Nothing is spawned
 * through a shell and `runProcess` is the production one, so this exercises the
 * real `spawn`, the real argv and the real stdin.
 */
function schemaEchoBinary(directory: string): string {
  const file = path.join(directory, "claude-fake");
  fs.writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)));",
      "fs.writeFileSync(path.join(process.cwd(), 'stdin.txt'), stdin);",
      "const marker = 'It must validate against this JSON Schema:';",
      "const at = stdin.indexOf(marker);",
      "if (at === -1) {",
      "  process.stdout.write(JSON.stringify({ result: 'NO_SCHEMA_WAS_SENT', num_turns: 1 }));",
      "  process.exit(0);",
      "}",
      "const schema = JSON.parse(stdin.slice(at + marker.length).trim());",
      "const value = {};",
      "for (const [key, property] of Object.entries(schema.properties ?? {})) {",
      "  value[key] = property.type === 'number' ? 42",
      "    : property.type === 'boolean' ? true",
      "    : property.type === 'array' ? []",
      "    : property.type === 'object' ? {}",
      "    : `${key}-from-schema`;",
      "}",
      "process.stdout.write(JSON.stringify({",
      "  result: JSON.stringify(value),",
      "  num_turns: 1,",
      "  total_cost_usd: 0,",
      "  usage: { input_tokens: 5, output_tokens: 7 },",
      "}));",
      "",
    ].join("\n"),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe("claude code relay end to end, through a schema-driven fake binary", () => {
  it("round-trips the node's own structured-output schema", async () => {
    const directory = temporaryDirectory();
    const binaryPath = schemaEchoBinary(directory);
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath, source: "override" },
      systemPrompt: "Be terse.",
    });
    const schema = {
      type: "object",
      properties: {
        verdict: { type: "string" },
        confidence: { type: "number" },
        supported: { type: "boolean" },
      },
      required: ["verdict", "confidence", "supported"],
      additionalProperties: false,
    };
    const receipt = await session.host.delegate(
      relayRequest({
        cwd: directory,
        task: controlledTask("Judge the evidence."),
        result: { kind: "structured", schema },
      } as never),
      { limits: { maxTokens: 1_000, maxCostUsd: 1 }, reconcileUsage: () => undefined },
    );

    expect(receipt.response.status).toBe("completed");
    expect(receipt.response.result?.kind).toBe("structured");
    // The child could only have produced these three keys, with these three
    // types, by reading the schema the relay sent it.
    expect(receipt.response.result?.value).toEqual({
      verdict: "verdict-from-schema",
      confidence: 42,
      supported: true,
    });
    // Which is what `validateTerminalStructured` (`kady-node-executor.ts:1420`)
    // then hands to the slot's `parse`; a text result or a missing structured
    // value would fail the node with WORKFLOW_DELEGATION_INVALID_RESULT.
    for (const required of schema.required) {
      expect(Object.keys(receipt.response.result?.value as object)).toContain(required);
    }

    // The real argv the operating system saw, read back off disk.
    const argv = JSON.parse(
      fs.readFileSync(path.join(directory, "argv.json"), "utf-8"),
    ) as string[];
    expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("4");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("Be terse.");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-1");
    const stdin = fs.readFileSync(path.join(directory, "stdin.txt"), "utf-8");
    expect(stdin).toContain(JSON.stringify(schema));
    // The Pi-only control envelope never reaches the Claude prompt.
    expect(stdin).not.toContain("KADY_NODE_CONTROL_V1:");
  });

  it("returns a different object for a different schema — the schema is what moved", async () => {
    const directory = temporaryDirectory();
    const binaryPath = schemaEchoBinary(directory);
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath, source: "override" },
      systemPrompt: undefined,
    });
    const receipt = await session.host.delegate(
      relayRequest({
        cwd: directory,
        task: controlledTask("Extract the citation."),
        result: {
          kind: "structured",
          schema: {
            type: "object",
            properties: { citation: { type: "string" }, page: { type: "number" } },
            required: ["citation", "page"],
          },
        },
      } as never),
      { limits: { maxTokens: 1_000, maxCostUsd: 1 }, reconcileUsage: () => undefined },
    );
    expect(receipt.response.result?.value)
      .toEqual({ citation: "citation-from-schema", page: 42 });
  });

  it("is a real control: the same binary says so when no schema is sent", async () => {
    // A text-result request carries no schema, and the fake binary reports that
    // it saw none. This is what proves the two assertions above are measuring
    // the relay's behaviour rather than a fixture that happened to match.
    const directory = temporaryDirectory();
    const binaryPath = schemaEchoBinary(directory);
    const session = createClaudeCodeRelaySession({
      selection: SELECTION,
      resolution: { state: "resolved", binaryPath, source: "override" },
      systemPrompt: undefined,
    });
    const receipt = await session.host.delegate(
      relayRequest({
        cwd: directory,
        task: controlledTask("Just talk."),
        result: { kind: "text" },
      } as never),
      { limits: { maxTokens: 1_000, maxCostUsd: 1 }, reconcileUsage: () => undefined },
    );
    expect(receipt.response.result).toEqual({
      kind: "text",
      text: "NO_SCHEMA_WAS_SENT",
    });
  });
});
