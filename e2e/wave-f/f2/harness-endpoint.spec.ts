/**
 * Lane F2 — the harness endpoint, against the **live** backend.
 *
 * The rest of the suite is mocked at the boundary by `e2e/fixtures.ts`, which
 * proves nothing about the server; these items follow `e2e/live-backend.spec.ts`
 * and drive the real backend origin from inside the real browser.
 *
 * **What these items are not.** They are not Gate U for matrix rows 7 and 11–13.
 * The "Settings ▸ Kady CLI" surface is lane F8's (Team C) and does not exist in
 * this clone, so there is no control to drive by mouse or keyboard here. What is
 * proved is the contract F8 builds against: the shape the picker renders from,
 * the honest disabled-and-why states, and the fail-closed override — including
 * that a refusal body never carries a server filesystem path (#71) and that the
 * payload is total, so a client destructuring it cannot throw in render (#62).
 *
 * These items require the route registration in `INTEGRATION.md` to have been
 * applied to `server/src/index.ts`, which is not lane F2's file.
 */
import { expect, test, type LiveWorkspace } from "../../live-fixtures";
import { e2eServiceOrigin } from "../../service-origins";

interface HarnessBinaryPathState {
  resolvedPath: string | null;
  source: string | null;
  override: string | null;
  systemPrompt: string | null;
  systemPromptMaxBytes: number;
  state: "resolved" | "not-found" | "rejected";
  detail: string | null;
}

interface HarnessListEntry {
  id: string;
  label: string;
  summary: string;
  executables: string[];
  adapter: string | null;
  hasAdapter: boolean;
  availability: "ready" | "not-found" | "no-adapter" | "rejected";
  resolvedExecutable: string | null;
  detail: string | null;
  supportsBinaryPathOverride: boolean;
  binaryPath: HarnessBinaryPathState | null;
  unboundControls: Array<{ control: string; reason: string }>;
}

interface ObservedResponse {
  status: number;
  url: string;
  body: unknown;
}

/** One browser-side fetch against the live backend, status and body captured. */
async function callBackend(
  workspace: LiveWorkspace,
  input: { path: string; method: string; payload?: unknown },
): Promise<ObservedResponse> {
  const origin = e2eServiceOrigin("backend");
  return workspace.page.evaluate(async ({ origin, path, method, payload }) => {
    const url = `${origin}${path}`;
    const response = await fetch(url, {
      method,
      ...(payload === undefined
        ? {}
        : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body is itself the finding; keep the text.
    }
    return { status: response.status, url, body };
  }, { origin, path: input.path, method: input.method, payload: input.payload });
}

const EXPECTED_HARNESS_IDS = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "deepseek",
  "grok-cli",
  "oh-my-pi",
];

test("@live @live-alt lists every harness with a total, renderable state", async ({
  liveWorkspace,
}) => {
  expect(
    new URL(liveWorkspace.projectsResponseUrl).origin,
    `The browser loaded projects from ${liveWorkspace.projectsResponseUrl}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));

  const listed = await callBackend(liveWorkspace, {
    path: "/harnesses",
    method: "GET",
  });
  expect(
    listed.status,
    `GET ${listed.url} returned ${listed.status} with ${JSON.stringify(listed.body)}.`,
  ).toBe(200);

  const payload = listed.body as { version: number; harnesses: HarnessListEntry[] };
  expect(payload.version).toBe(1);
  expect(payload.harnesses.map((entry) => entry.id)).toEqual(EXPECTED_HARNESS_IDS);

  // #62: every field is present on every row, so a picker that reads
  // `entry.binaryPath.state` or maps `entry.executables` cannot throw in render.
  for (const entry of payload.harnesses) {
    expect(
      Object.keys(entry).sort(),
      `Harness ${entry.id} answered ${JSON.stringify(entry)}.`,
    ).toEqual([
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
      "unboundControls",
    ]);
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.executables.length).toBeGreaterThan(0);
    expect(["ready", "not-found", "no-adapter", "rejected"]).toContain(entry.availability);
    expect(Array.isArray(entry.unboundControls)).toBe(true);
    for (const control of entry.unboundControls) {
      expect(control.control.length).toBeGreaterThan(0);
      expect(control.reason.length).toBeGreaterThan(0);
    }
    // §6.7: a row that cannot act carries the reason it cannot.
    if (entry.availability !== "ready") expect(entry.detail).toBeTruthy();
  }

  // The Pi harness is the one that is always selectable.
  expect(payload.harnesses.find((entry) => entry.id === "pi")).toMatchObject({
    availability: "ready",
    hasAdapter: true,
    adapter: "pi-delegation",
    binaryPath: null,
  });

  // Rows 11–13 exist and are honest about having no adapter this wave.
  for (const id of ["deepseek", "grok-cli", "oh-my-pi"]) {
    const entry = payload.harnesses.find((candidate) => candidate.id === id);
    expect(entry, `Harness ${id} is missing from the list.`).toBeDefined();
    expect(entry!.hasAdapter).toBe(false);
    expect(entry!.availability).toBe("no-adapter");
    expect(entry!.detail).toContain(id);
  }

  // Exactly one harness offers the binary-path editor F8 renders (row 7).
  const withPathEditor = payload.harnesses.filter(
    (entry) => entry.supportsBinaryPathOverride,
  );
  expect(withPathEditor.map((entry) => entry.id)).toEqual(["claude-code"]);
  expect(withPathEditor[0]!.binaryPath).not.toBeNull();
  expect(withPathEditor[0]!.binaryPath!.systemPromptMaxBytes).toBeGreaterThan(0);
});

test("@live @live-alt refuses an unusable Claude Code path without leaking a server path", async ({
  liveWorkspace,
}) => {
  // The browser reports the deliberate 400 as a console error; declare it.
  liveWorkspace.expectRefusedResourceStatus(400);

  const before = await callBackend(liveWorkspace, { path: "/harnesses", method: "GET" });
  const beforeClaude = (before.body as { harnesses: HarnessListEntry[] }).harnesses
    .find((entry) => entry.id === "claude-code");

  const refused = await callBackend(liveWorkspace, {
    path: "/harnesses/claude-code/binary-path",
    method: "PUT",
    payload: { binaryPath: "/f2/definitely/not/here/claude" },
  });
  expect(
    refused.status,
    `PUT ${refused.url} returned ${refused.status} with ${JSON.stringify(refused.body)}.`,
  ).toBe(400);

  const body = refused.body as { error: string; detail: string };
  expect(body.error).toBe("unresolvable-path");
  // The only path in the refusal is the one this test supplied (#71).
  expect(body.detail).toContain("/f2/definitely/not/here/claude");
  expect(body.detail).not.toMatch(/\/(Users|home|private|var|opt)\//);
  expect(JSON.stringify(refused.body)).not.toContain("node_modules");

  // Fail closed: nothing was persisted, so the resolved state is unchanged.
  const after = await callBackend(liveWorkspace, { path: "/harnesses", method: "GET" });
  const afterClaude = (after.body as { harnesses: HarnessListEntry[] }).harnesses
    .find((entry) => entry.id === "claude-code");
  expect(afterClaude!.binaryPath!.override).toBe(beforeClaude!.binaryPath!.override);
  expect(afterClaude!.binaryPath!.resolvedPath).toBe(
    beforeClaude!.binaryPath!.resolvedPath,
  );
});

test("@live @live-alt round-trips the Claude system-prompt override and clears it", async ({
  liveWorkspace,
}) => {
  const marker = `Kady relay probe ${Date.now().toString(36)}`;
  const saved = await callBackend(liveWorkspace, {
    path: "/harnesses/claude-code/system-prompt",
    method: "PUT",
    payload: { systemPrompt: marker },
  });
  expect(
    saved.status,
    `PUT ${saved.url} returned ${saved.status} with ${JSON.stringify(saved.body)}.`,
  ).toBe(200);
  const savedClaude = (saved.body as { harnesses: HarnessListEntry[] }).harnesses
    .find((entry) => entry.id === "claude-code");
  expect(savedClaude!.binaryPath!.systemPrompt).toBe(marker);

  // The write is durable: a fresh read sees it, not just the write's echo.
  const reread = await callBackend(liveWorkspace, { path: "/harnesses", method: "GET" });
  const rereadClaude = (reread.body as { harnesses: HarnessListEntry[] }).harnesses
    .find((entry) => entry.id === "claude-code");
  expect(rereadClaude!.binaryPath!.systemPrompt).toBe(marker);

  const cleared = await callBackend(liveWorkspace, {
    path: "/harnesses/claude-code/system-prompt",
    method: "DELETE",
  });
  expect(
    cleared.status,
    `DELETE ${cleared.url} returned ${cleared.status} with ${JSON.stringify(cleared.body)}.`,
  ).toBe(200);
  const clearedClaude = (cleared.body as { harnesses: HarnessListEntry[] }).harnesses
    .find((entry) => entry.id === "claude-code");
  expect(clearedClaude!.binaryPath!.systemPrompt).toBeNull();
});
