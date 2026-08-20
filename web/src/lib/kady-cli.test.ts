import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  binaryPathSourceLabel,
  clearClaudeBinaryPath,
  fetchHarnesses,
  HARNESS_IDS,
  isSelectable,
  parseHarnessListResponse,
  saveClaudeBinaryPath,
  saveClaudeSystemPrompt,
  unselectableReason,
  utf8ByteLength,
  type HarnessId,
  type HarnessListEntry,
} from "@/lib/kady-cli";

/**
 * Contract tests against `W/interfaces/F2-harness-and-nodecontrol.md`.
 *
 * These prove the CLIENT honours the published contract. They are Gate-U-side
 * evidence only: the routes do not exist in this tree, so nothing here is
 * offered as proof that a harness selection reaches a dispatch decision. That
 * binding is reported NOT DONE.
 */

function makeEntry(overrides: Partial<HarnessListEntry> = {}): HarnessListEntry {
  return {
    id: "codex",
    label: "Codex CLI",
    summary: "The Codex command-line harness.",
    executables: ["codex"],
    adapter: null,
    hasAdapter: false,
    availability: "no-adapter",
    resolvedExecutable: null,
    detail: "No adapter is implemented for this harness yet.",
    supportsBinaryPathOverride: false,
    binaryPath: null,
    unboundControls: [],
    ...overrides,
  };
}

function makeContractList(
  overrides: Partial<Record<HarnessId, Partial<HarnessListEntry>>> = {},
): HarnessListEntry[] {
  return HARNESS_IDS.map((id) =>
    makeEntry({
      id,
      label: `${id} label`,
      ...overrides[id],
    }),
  );
}

const CLAUDE_BINARY_PATH = {
  resolvedPath: "/opt/tools/claude",
  source: "path" as const,
  override: null,
  systemPrompt: null,
  systemPromptMaxBytes: 16_384,
  state: "resolved" as const,
  detail: null,
};

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

describe("selectability", () => {
  it("is decided by availability alone", () => {
    expect(isSelectable(makeEntry({ availability: "ready" }))).toBe(true);
    for (const availability of ["not-found", "no-adapter", "rejected"] as const) {
      expect(isSelectable(makeEntry({ availability }))).toBe(false);
    }
  });

  it("does not infer selectability from hasAdapter or resolvedExecutable", () => {
    // A harness with an adapter AND a resolved command can still be non-ready —
    // e.g. a rejected binary-path override. `availability` already folds all of
    // that in, and it is the only field consulted.
    expect(
      isSelectable(
        makeEntry({
          availability: "rejected",
          hasAdapter: true,
          adapter: "claude-code-relay",
          resolvedExecutable: "claude",
        }),
      ),
    ).toBe(false);
    // And the converse: ready with no adapter string still selects.
    expect(
      isSelectable(makeEntry({ availability: "ready", hasAdapter: false, adapter: null })),
    ).toBe(true);
  });

  it("always has a visible reason for a non-selectable harness", () => {
    expect(unselectableReason(makeEntry({ availability: "ready" }))).toBeNull();
    expect(unselectableReason(makeEntry({ detail: "DeepSeek CLI is not installed." }))).toBe(
      "DeepSeek CLI is not installed.",
    );
    // Never an empty disabled row: a fallback sentence stands in for a null detail.
    expect(unselectableReason(makeEntry({ detail: null }))).toBe(
      "This harness is not available on this machine.",
    );
  });
});

describe("binaryPathSourceLabel", () => {
  it("uses the interface's exact wording per source", () => {
    expect(binaryPathSourceLabel("override")).toBe("Set here");
    expect(binaryPathSourceLabel("env")).toBe(
      "From the CLAUDE_BIN_PATH environment variable",
    );
    expect(binaryPathSourceLabel("native-installer")).toBe(
      "Found at the default install location",
    );
    expect(binaryPathSourceLabel("path")).toBe("Found on PATH");
    expect(binaryPathSourceLabel(null)).toBeNull();
  });
});

describe("parseHarnessListResponse", () => {
  it("accepts a contract-shaped list", () => {
    const parsed = parseHarnessListResponse({
      version: 1,
      harnesses: makeContractList({
        pi: { label: "Pi (built in)", availability: "ready", detail: null },
        "claude-code": {
          label: "Claude Code CLI",
          supportsBinaryPathOverride: true,
          binaryPath: CLAUDE_BINARY_PATH,
          unboundControls: [
            { control: "toolBudget", reason: "Claude Code counts turns, not tool calls." },
          ],
        },
      }),
    });
    expect(parsed?.harnesses).toHaveLength(8);
    expect(parsed?.harnesses[1]?.binaryPath?.systemPromptMaxBytes).toBe(16_384);
    expect(parsed?.harnesses[1]?.unboundControls[0]?.control).toBe("toolBudget");
  });

  it("rejects malformed bodies instead of throwing (#62)", () => {
    for (const bad of [
      null,
      undefined,
      "no",
      {},
      { version: 2, harnesses: [] },
      { version: 1, harnesses: {} },
      { version: 1, harnesses: [] },
      { version: 1, harnesses: [null] },
      { version: 1, harnesses: [{ id: "pi" }] },
      { version: 1, harnesses: [{ id: "pi", label: "Pi", availability: "sometimes" }] },
      // `unboundControls` is total in F2's round-2 contract. Omitting it would
      // hide an adapter limitation from the Settings surface.
      {
        version: 1,
        harnesses: makeContractList().map(({ unboundControls: _omitted, ...entry }) => entry),
      },
      // supportsBinaryPathOverride true but binaryPath absent: the interface
      // guarantees it is non-null there, so a body that breaks that guarantee
      // is not trusted for the rest of its contents either.
      {
        version: 1,
        harnesses: [
          { id: "claude-code", label: "Claude Code CLI", availability: "ready", supportsBinaryPathOverride: true },
        ],
      },
      // systemPromptMaxBytes must be present and positive — it is read, never
      // hardcoded, so a missing one cannot be silently defaulted to 16384.
      {
        version: 1,
        harnesses: [
          {
            id: "claude-code",
            label: "Claude Code CLI",
            availability: "ready",
            supportsBinaryPathOverride: true,
            binaryPath: { ...CLAUDE_BINARY_PATH, systemPromptMaxBytes: 0 },
          },
        ],
      },
    ]) {
      expect(() => parseHarnessListResponse(bad)).not.toThrow();
      expect(parseHarnessListResponse(bad)).toBeNull();
    }
  });
});

describe("fetchHarnesses", () => {
  it("maps a 404 to unavailable-with-retry, not to an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    const outcome = await fetchHarnesses();
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail).toContain("Retry");
      expect(outcome.detail).not.toContain("/");
    }
  });

  it("maps a 503 harness-settings-unavailable to unavailable, showing its detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "harness-settings-unavailable",
            detail: "Harness settings could not be read. Restart the backend and retry.",
          },
          503,
        ),
      ),
    );
    const outcome = await fetchHarnesses();
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.detail).toBe(
        "Harness settings could not be read. Restart the backend and retry.",
      );
    }
  });

  it("maps a malformed 200 to unavailable rather than rendering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ version: 1, harnesses: 3 })));
    const outcome = await fetchHarnesses();
    expect(outcome.kind).toBe("unavailable");
  });

  it("maps a network failure to unavailable rather than rejecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(fetchHarnesses()).resolves.toMatchObject({ kind: "unavailable" });
  });
});

describe("mutations", () => {
  it("returns the full list from a 200 so no follow-up GET is needed", async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        version: 1,
        harnesses: makeContractList({
          pi: { label: "Pi (built in)", availability: "ready" },
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchStub);

    const outcome = await saveClaudeBinaryPath("/opt/tools/claude");

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.response.harnesses).toHaveLength(8);
    // Exactly one request: the response IS the new state.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ binaryPath: "/opt/tools/claude" }));
  });

  it("surfaces unresolvable-path as its own outcome so nothing is applied optimistically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "unresolvable-path",
            detail: "'/nope/claude' does not name an executable file.",
          },
          400,
        ),
      ),
    );
    const outcome = await saveClaudeBinaryPath("/nope/claude");
    expect(outcome.kind).toBe("unresolvable-path");
    if (outcome.kind === "unresolvable-path") {
      // `detail` quotes the path the CALLER supplied — the client renders it
      // verbatim and never substitutes a server path of its own.
      expect(outcome.detail).toContain("/nope/claude");
    }
  });

  it("distinguishes invalid-request from unresolvable-path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "invalid-request", detail: "binaryPath is required." }, 400),
      ),
    );
    await expect(saveClaudeSystemPrompt("x")).resolves.toMatchObject({
      kind: "invalid-request",
    });
  });

  it("sends DELETE to clear an override", async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ version: 1, harnesses: makeContractList() }),
    );
    vi.stubGlobal("fetch", fetchStub);
    await clearClaudeBinaryPath();
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes, not code units, so the counter matches systemPromptMaxBytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("🛠")).toBe(4);
  });
});
