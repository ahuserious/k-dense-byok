import type { Page, Route } from "@playwright/test";

import { expect, test } from "../../fixtures";

/**
 * Gate U for master-brief rows 14 and 15 — lane F8.
 *
 * Every item here drives a control through a real user path in a real browser:
 * open the app shell, operate the widget, read what it says. None of it is
 * offered as Gate B evidence — `e2e/fixtures.ts:35` mocks the backend for the
 * whole suite, so a green run proves reachability and behaviour, never binding.
 *
 * Route overrides: Playwright matches the most recently registered handler
 * first, so the `page.route` calls below take precedence over `installApiMocks`
 * without touching `e2e/fixtures.ts` (lane S11's file). `/harnesses` is not
 * mocked by the shared fixture and is only requested when the Kady CLI tab is
 * mounted, so specs that never open that tab are unaffected.
 */

/**
 * Re-enter the workspace after installing a route override.
 *
 * The `workspacePage` fixture has already navigated and picked the project, so a
 * route registered inside a test arrives too late for a mount-time fetch. A
 * reload replays the mount — and lands back on the project picker, because the
 * fixture's entry path starts there.
 */
async function reenterWorkspace(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "Open project E2E Project" }).click();
  await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
}

/**
 * Why the "unavailable" items below serve a malformed 200 rather than a 404.
 *
 * A `route.fulfill({ status: 404 })` makes Chromium log
 * "Failed to load resource: ... 404", and `e2e/fixtures.ts`'s automatic
 * `runtimeErrors` fixture fails any spec that produces a browser console error.
 * So the honest-unavailable state is reached here through the other door that
 * leads to it — a successful response the client refuses to trust (#62). The
 * status-code mapping itself (404 and 503 -> unavailable-with-retry) is pinned
 * in `web/src/lib/kady-cli.test.ts`, where no browser is involved.
 */
async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const READY_PI = {
  id: "pi",
  label: "Pi (built in)",
  summary: "Delegates the node to the built-in Pi harness.",
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

const CLAUDE_CODE = {
  id: "claude-code",
  label: "Claude Code CLI",
  summary: "Relays the node to the Claude Code CLI.",
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
    systemPromptMaxBytes: 16384,
    state: "resolved",
    detail: null,
  },
};

const DEEPSEEK_MISSING = {
  id: "deepseek",
  label: "DeepSeek CLI",
  summary: "Runs the node through the DeepSeek CLI.",
  executables: ["deepseek", "deepseek-cli"],
  adapter: null,
  hasAdapter: false,
  availability: "not-found",
  detail: "DeepSeek CLI was not found on this machine. Install it, then retry.",
  resolvedExecutable: null,
  supportsBinaryPathOverride: false,
  binaryPath: null,
  unboundControls: [],
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
  DEEPSEEK_MISSING,
  unavailableHarness("grok-cli", "Grok CLI"),
  unavailableHarness("oh-my-pi", "oh-my-pi"),
];

const SUBSCRIPTION_PROVIDERS = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountLabel: "ChatGPT Plus/Pro",
    billingMode: "subscription",
    billingNote:
      "Uses provider-managed ChatGPT subscription limits. Kady cannot read remaining quota or overages.",
    connected: true,
    needsReauth: false,
    credentialType: "oauth",
    source: "oauth",
    loginLabel: null,
    modelCount: 3,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    accountLabel: "Claude Pro/Max",
    billingMode: "metered_oauth",
    billingNote:
      "Pi documents third-party Claude subscription use as extra usage billed per token.",
    connected: false,
    needsReauth: false,
    credentialType: null,
    source: null,
    loginLabel: null,
    modelCount: 0,
  },
];

test.describe("F8 row 14 — the subscription bar in the app shell", () => {
  test("is reachable from the header and separates spend from subscription usage", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/model-providers", (route) =>
      fulfillJson(route, { providers: SUBSCRIPTION_PROVIDERS }),
    );
    await reenterWorkspace(workspacePage);

    const bar = workspacePage.getByRole("button", {
      name: /Spend and subscription usage/,
    });
    await expect(bar).toBeVisible();

    await bar.click();
    // Two sections, one surface: the division of labour is on screen, so a
    // reader is never left guessing which number means what.
    await expect(
      workspacePage.getByRole("heading", { name: "Subscription usage" }),
    ).toBeVisible();
    await expect(workspacePage.getByRole("heading", { name: "This session" })).toBeVisible();
    await expect(
      workspacePage.getByText(
        "Tokens your providers bill under their own subscription, separately from the spend above.",
      ),
    ).toBeVisible();
  });

  test("shows every provider's quota as unreadable with the provider's own reason", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/model-providers", (route) =>
      fulfillJson(route, { providers: SUBSCRIPTION_PROVIDERS }),
    );
    await reenterWorkspace(workspacePage);
    await workspacePage
      .getByRole("button", { name: /Spend and subscription usage/ })
      .click();

    await expect(workspacePage.getByText("OpenAI Codex")).toBeVisible();
    await expect(
      workspacePage.getByText(/Kady cannot read remaining quota or overages/),
    ).toBeVisible();
    await expect(
      workspacePage.getByText(/no subscription ceiling to measure against/),
    ).toBeVisible();

    // The load-bearing assertion of this row: no percentage is invented for a
    // provider whose ceiling this machine cannot read.
    const quotaMeters = workspacePage.locator('[role="meter"][aria-disabled="true"]');
    await expect(quotaMeters).toHaveCount(2);
    for (const meter of await quotaMeters.all()) {
      expect(await meter.getAttribute("aria-valuenow")).toBeNull();
    }
  });

  test("opens on the keyboard, closes on Escape and returns focus to its trigger", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/model-providers", (route) =>
      fulfillJson(route, { providers: SUBSCRIPTION_PROVIDERS }),
    );
    await reenterWorkspace(workspacePage);

    const bar = workspacePage.getByRole("button", {
      name: /Spend and subscription usage/,
    });
    await bar.focus();
    await workspacePage.keyboard.press("Enter");
    await expect(workspacePage.getByRole("heading", { name: "This session" })).toBeVisible();

    await workspacePage.keyboard.press("Escape");
    await expect(
      workspacePage.getByRole("heading", { name: "This session" }),
    ).toBeHidden();
    await expect(bar).toBeFocused();
  });

  test("renders an honest unavailable state with a retry when providers cannot be read", async ({
    workspacePage,
  }) => {
    // A 200 the client refuses to trust: `providers` is not an array, so the
    // structural guard rejects it and the bar degrades instead of throwing.
    await workspacePage.route("**/model-providers", (route) =>
      fulfillJson(route, { providers: "not-an-array" }),
    );
    await reenterWorkspace(workspacePage);

    await workspacePage
      .getByRole("button", { name: /Spend and subscription usage/ })
      .click();
    await expect(
      workspacePage.getByText(/Subscription usage could not be read/),
    ).toBeVisible();
    await expect(workspacePage.getByRole("button", { name: "Retry" })).toBeVisible();
    // The next action is named and no filesystem path is exposed (#71).
    await expect(
      workspacePage.getByText(/Check that the Kady backend is running, then retry/),
    ).toBeVisible();
  });
});

test.describe("F8 row 15 — Settings ▸ Kady CLI", () => {
  test("is a grouped entry in the settings rail, reachable by mouse", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/harnesses", (route) => fulfillJson(route, {}));
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });

    // The eight pre-existing tabs still work and keep their names.
    for (const name of [
      "Model providers",
      "API keys",
      "Connectors",
      "Skills",
      "Specialists",
      "Fusion",
      "Pipelines",
      "Appearance",
    ] as const) {
      await expect(settings.getByRole("tab", { name })).toBeVisible();
    }
    // The group headings are presentational: they are visible, and they are not
    // tabs, so they cannot be focused or activated.
    for (const group of ["Workspace", "Agents", "Runtime"] as const) {
      await expect(settings.getByText(group, { exact: true })).toBeVisible();
      await expect(settings.getByRole("tab", { name: group })).toHaveCount(0);
    }

    await settings.getByRole("tab", { name: "Kady CLI" }).click();
    await expect(settings.getByRole("heading", { name: "Kady CLI" })).toBeVisible();
  });

  test("renders an untrustworthy list as unavailable-with-retry, not as an empty list", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/harnesses", (route) => fulfillJson(route, {}));
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Kady CLI" }).click();

    await expect(settings.getByText(/Harness settings are unavailable/)).toBeVisible();
    await expect(settings.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(settings.getByRole("radiogroup")).toHaveCount(0);
    // Error copy names the next action and leaks no filesystem path (#71).
    const message = await settings
      .getByText(/came back in an unexpected shape/)
      .textContent();
    expect(message).toMatch(/Retry/);
    expect(message).not.toMatch(/\/(Users|home|opt|var|tmp)\//);
  });

  test("lists labels, disables what is not ready, and shows why", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/harnesses", (route) =>
      fulfillJson(route, { version: 1, harnesses: ALL_HARNESSES }),
    );
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Kady CLI" }).click();

    // `label`, never `id`.
    await expect(settings.getByRole("radio", { name: /Pi \(built in\)/ })).toBeVisible();
    await expect(settings.getByRole("radio", { name: /DeepSeek CLI/ })).toBeVisible();

    const deepseek = settings.getByRole("radio", { name: /DeepSeek CLI/ });
    await expect(deepseek).toHaveAttribute("aria-disabled", "true");
    await expect(
      settings.getByText("DeepSeek CLI was not found on this machine. Install it, then retry."),
    ).toBeVisible();

    // §6.7: even a ready harness is inert, because nothing stores the choice.
    const pi = settings.getByRole("radio", { name: /Pi \(built in\)/ });
    await expect(pi).toHaveAttribute("aria-disabled", "true");
    // `force` because Playwright's own actionability check already refuses the
    // click — "element is not enabled" — which is itself the evidence that the
    // control reads as disabled to a user agent, not merely to the eye. Forcing
    // it through proves the handler is inert too.
    await pi.click({ force: true });
    await expect(pi).toHaveAttribute("aria-checked", "false");
    await expect(settings.getByText(/Selection is not bound yet/)).toBeVisible();

    // The byte budget comes from the response, not from a constant.
    await expect(settings.getByText("0 / 16384 bytes")).toBeVisible();
    await expect(settings.getByText("/opt/tools/claude")).toBeVisible();
    await expect(settings.getByText(/Found on PATH/)).toBeVisible();
  });

  test("reaches every harness row and the path editor by keyboard alone", async ({
    workspacePage,
  }) => {
    await workspacePage.route("**/harnesses", (route) =>
      fulfillJson(route, { version: 1, harnesses: ALL_HARNESSES }),
    );
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Kady CLI" }).click();
    await expect(settings.getByRole("radio", { name: /Pi \(built in\)/ })).toBeVisible();

    // Disabled rows use `aria-disabled`, not `disabled`, precisely so the reason
    // stays reachable: a control a keyboard user cannot reach is a reason they
    // cannot read.
    for (const label of [/Pi \(built in\)/, /Claude Code CLI/, /DeepSeek CLI/]) {
      const row = settings.getByRole("radio", { name: label });
      await row.focus();
      await expect(row).toBeFocused();
    }
    const pathField = settings.getByLabel("Binary path");
    await pathField.focus();
    await expect(pathField).toBeFocused();
  });

  test("applies the list a save returns, without a second read", async ({
    workspacePage,
  }) => {
    let listReads = 0;
    await workspacePage.route("**/harnesses", (route) => {
      listReads += 1;
      return fulfillJson(route, { version: 1, harnesses: ALL_HARNESSES });
    });
    await workspacePage.route("**/harnesses/claude-code/binary-path", (route) =>
      fulfillJson(route, {
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
      }),
    );
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Kady CLI" }).click();
    await expect(settings.getByRole("radio", { name: /Claude Code CLI/ })).toBeVisible();
    await expect(settings.getByText("/opt/tools/claude")).toBeVisible();

    const readsBeforeSave = listReads;
    const pathField = settings.getByLabel("Binary path");
    await pathField.fill("/elsewhere/claude");
    await settings.getByRole("button", { name: "Save path" }).click();

    // State is replaced from the mutation's own full response, so a concurrent
    // change cannot be lost between a write and a re-read.
    await expect(settings.getByText("/elsewhere/claude")).toBeVisible();
    await expect(settings.getByText(/Set here/)).toBeVisible();
    expect(listReads).toBe(readsBeforeSave);

    // The `400 unresolvable-path` refusal — where the field stays dirty and
    // nothing is applied — is pinned in web/src/lib/kady-cli.test.ts and
    // web/src/components/settings/kady-cli-panel.test.tsx instead of here: a
    // fulfilled non-2xx makes Chromium log a console error, and the shared
    // `runtimeErrors` fixture fails any spec that produces one.
  });
});
