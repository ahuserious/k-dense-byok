import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { KadyCliPanel } from "./kady-cli-panel";

/**
 * Gate-U-side evidence for master-brief row 15.
 *
 * These pin what the panel does with what F2's contract can return — including
 * the state it actually shows in THIS tree, where `/harnesses` 404s. Nothing
 * here is offered as Gate B evidence: no assertion below concerns what a
 * selection dispatches, because in this tree a selection dispatches nothing and
 * the panel says so on screen.
 */

const READY_PI = {
  id: "pi",
  label: "Pi (built in)",
  summary: "The built-in Pi delegation harness.",
  executables: ["pi"],
  adapter: "pi-delegation",
  hasAdapter: true,
  availability: "ready",
  resolvedExecutable: "pi",
  detail: null,
  supportsBinaryPathOverride: false,
  binaryPath: null,
  unboundControls: [],
};

const NOT_FOUND_DEEPSEEK = {
  id: "deepseek",
  label: "DeepSeek CLI",
  summary: "The DeepSeek command-line harness.",
  executables: ["deepseek", "deepseek-cli"],
  adapter: null,
  hasAdapter: false,
  availability: "not-found",
  resolvedExecutable: null,
  detail: "DeepSeek CLI was not found on this machine. Install it, then retry.",
  supportsBinaryPathOverride: false,
  binaryPath: null,
  unboundControls: [],
};

const CLAUDE_CODE = {
  id: "claude-code",
  label: "Claude Code CLI",
  summary: "Relays a node to the Claude Code CLI.",
  executables: ["claude"],
  adapter: "claude-code-relay",
  hasAdapter: true,
  availability: "ready",
  resolvedExecutable: "claude",
  detail: null,
  supportsBinaryPathOverride: true,
  unboundControls: [
    {
      control: "toolBudget",
      reason: "Claude Code counts turns rather than individual tool calls.",
    },
  ],
  binaryPath: {
    resolvedPath: "/opt/tools/claude",
    source: "path",
    override: null,
    systemPrompt: null,
    // Deliberately NOT 16384: the counter must come from the response.
    systemPromptMaxBytes: 2_048,
    state: "resolved",
    detail: null,
  },
};

function unavailableHarness(id: string, label: string) {
  return {
    id,
    label,
    summary: `${label} is not available in this build.`,
    executables: [id],
    adapter: null,
    hasAdapter: false,
    availability: "no-adapter",
    resolvedExecutable: null,
    detail: `No adapter is implemented for ${label}.`,
    supportsBinaryPathOverride: false,
    binaryPath: null,
    unboundControls: [],
  };
}

const ALL_HARNESSES = [
  READY_PI,
  CLAUDE_CODE,
  unavailableHarness("codex", "Codex CLI"),
  unavailableHarness("opencode", "OpenCode CLI"),
  unavailableHarness("copilot", "GitHub Copilot CLI"),
  NOT_FOUND_DEEPSEEK,
  unavailableHarness("grok-cli", "Grok CLI"),
  unavailableHarness("oh-my-pi", "oh-my-pi"),
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("Kady CLI panel — when the harness routes are absent (this tree)", () => {
  it("renders an honest unavailable state with a retry, not an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    render(<KadyCliPanel />);

    expect(await screen.findByText(/Harness settings are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/not available from this backend yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // Not an empty list, and not a picker that looks live.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("reloads on Retry and shows the list once it becomes available", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({}, 404)
          : jsonResponse({ version: 1, harnesses: ALL_HARNESSES });
      }),
    );
    render(<KadyCliPanel />);

    await user.click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Pi (built in)")).toBeInTheDocument();
  });

  it("never leaks a filesystem path in the unavailable message (#71)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    render(<KadyCliPanel />);
    const message = await screen.findByText(/not available from this backend yet/);
    expect(message.textContent).not.toMatch(/\/(Users|home|opt|var|tmp)\//);
  });
});

describe("Kady CLI panel — with a contract-shaped list", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          version: 1,
          harnesses: ALL_HARNESSES,
        }),
      ),
    );
  });

  it("renders labels, never ids", async () => {
    render(<KadyCliPanel />);
    expect(await screen.findByText("Pi (built in)")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek CLI")).toBeInTheDocument();
    // The raw ids must not appear as visible row text.
    expect(screen.queryByText("grok-cli")).not.toBeInTheDocument();
    expect(screen.queryByText("deepseek")).not.toBeInTheDocument();
  });

  it("shows a non-ready harness disabled with its detail — never hidden", async () => {
    render(<KadyCliPanel />);
    const row = await screen.findByRole("radio", { name: /DeepSeek CLI/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("DeepSeek CLI was not found on this machine. Install it, then retry."),
    ).toBeInTheDocument();
  });

  it("keeps every row disabled — including ready ones — because nothing stores the choice", async () => {
    const user = userEvent.setup();
    render(<KadyCliPanel />);
    const pi = await screen.findByRole("radio", { name: /Pi \(built in\)/ });

    expect(pi).toHaveAttribute("aria-disabled", "true");
    expect(pi).toHaveAttribute("aria-checked", "false");
    await user.click(pi);
    // Clicking changes nothing: the published F2 interface has no endpoint that
    // persists a default selection into a backend dispatch decision.
    expect(pi).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Selection is not bound yet/)).toBeInTheDocument();
  });

  it("keeps disabled rows in the tab order so their reason is reachable", async () => {
    render(<KadyCliPanel />);
    const row = await screen.findByRole("radio", { name: /DeepSeek CLI/ });
    // `aria-disabled`, not `disabled`: a `disabled` button drops out of the tab
    // order, and a user who cannot reach the control cannot reach the reason.
    expect(row).not.toHaveAttribute("disabled");
    row.focus();
    expect(row).toHaveFocus();
  });

  it("reads the system-prompt byte budget from the response instead of hardcoding it", async () => {
    render(<KadyCliPanel />);
    expect(await screen.findByText(/0 \/ 2048 bytes/)).toBeInTheDocument();
  });

  it("renders F2's machine-readable unbound-control reasons", async () => {
    render(<KadyCliPanel />);
    expect(
      await screen.findByText(/Adapter limits: toolBudget — Claude Code counts turns/),
    ).toBeInTheDocument();
  });

  it("renders the resolved path and where it came from, in F2's exact wording", async () => {
    render(<KadyCliPanel />);
    expect(await screen.findByText("/opt/tools/claude")).toBeInTheDocument();
    expect(screen.getByText(/Found on PATH/)).toBeInTheDocument();
  });

  it("surfaces the two verbatim validation refusals F2 asks the picker to show", async () => {
    render(<KadyCliPanel />);
    expect(await screen.findByText("unreachable-node-harness")).toBeInTheDocument();
    expect(screen.getByText("unreachable-inherited-harness")).toBeInTheDocument();
    expect(screen.getByText("WORKFLOW_HARNESS_NOT_BOUND")).toBeInTheDocument();
  });
});

describe("Kady CLI panel — saving a binary path", () => {
  it("keeps the field dirty and shows the detail on 400 unresolvable-path", async () => {
    const user = userEvent.setup();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ version: 1, harnesses: ALL_HARNESSES });
        return jsonResponse(
          {
            error: "unresolvable-path",
            detail: "'/nope/claude' does not name an executable file.",
          },
          400,
        );
      }),
    );
    render(<KadyCliPanel />);

    const input = await screen.findByLabelText("Binary path");
    await user.clear(input);
    await user.type(input, "/nope/claude");
    await user.click(screen.getByRole("button", { name: "Save path" }));

    expect(
      await screen.findByText("'/nope/claude' does not name an executable file."),
    ).toBeInTheDocument();
    // Nothing was persisted, so the draft is untouched — no optimistic apply.
    expect(input).toHaveValue("/nope/claude");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("replaces state from the mutation's own full response, with no follow-up GET", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method) return jsonResponse({ version: 1, harnesses: ALL_HARNESSES });
      if (url.includes("binary-path")) {
        return jsonResponse({
          version: 1,
          harnesses: ALL_HARNESSES.map((entry) =>
            entry.id === "claude-code"
              ? {
                  ...CLAUDE_CODE,
                  binaryPath: {
                    ...CLAUDE_CODE.binaryPath,
                    resolvedPath: "/elsewhere/claude",
                    source: "override",
                    override: "/elsewhere/claude",
                  },
                }
              : entry,
          ),
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    render(<KadyCliPanel />);

    const input = await screen.findByLabelText("Binary path");
    await user.type(input, "/elsewhere/claude");
    await user.click(screen.getByRole("button", { name: "Save path" }));

    expect(await screen.findByText("/elsewhere/claude")).toBeInTheDocument();
    expect(screen.getByText(/Set here/)).toBeInTheDocument();
    await waitFor(() => {
      // One initial GET plus one PUT. A third call would be the follow-up GET
      // that could lose a concurrent change.
      expect(fetchStub).toHaveBeenCalledTimes(2);
    });
  });
});
