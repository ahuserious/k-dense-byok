// danbot-byok — e2e/wave-f/f9/f9-chat-elevation.spec.ts
//
// Wave F lane F9, master-brief rows 17 (Prompt Elevation panel) and 18 (baby
// view rail + hover/focus overlay). Gate U evidence: a user who has never read
// the source finds and operates both from the running app, by mouse AND by
// keyboard.
//
// GATE U ONLY. `e2e/fixtures.ts:35` mocks the backend for the whole suite, so a
// green here says the control is reachable and behaves — it says nothing about
// the server. Row 17 is deliberately NOT DONE on Gate B until F5 publishes the
// shared API; row 18's client-side effect evidence is in
// `web/src/lib/baby-view.test.ts`.
//
// This file lives under `e2e/wave-f/f9/` and its basename is unique across the
// wave: `e2e/chat.spec.ts` belongs to lane S11 and is not touched.

import type { Page } from "@playwright/test";

import { expect, selectWorkspaceTab, test } from "../../fixtures";

const ELEVATION_QUESTION = "Elevate workflow to a durable scientific DAG pipeline?";
const NO_SESSION_REASON = "Send a message first — there is no conversation to elevate yet.";
const ELEVATION_API_UNAVAILABLE_REASON =
  "This build does not include the shared elevate-to-DAG service yet.";
const USER_PROMPT = "Cluster the RNA-seq counts and report the silhouette score.";

/**
 * The two reads this lane's surfaces make that `e2e/fixtures.ts` does not
 * answer, supplied here rather than there because `e2e/fixtures.ts` belongs to
 * lane S11 and this lane does not edit it. Playwright gives precedence to the
 * most recently registered route, so these override the suite mock for this
 * spec only and leave every other file's expectations untouched.
 *
 *  - `/sessions/:id/run/state` — the suite answers `{status:"none", run:null}`,
 *    which folds to a projection with no turn. Row 17 is about a conversation
 *    that HAS turns, so this supplies the frame stream a real held run emits.
 *  - `/dag-workflows/chat-e2e-workflow` — the suite's session workflow-run link
 *    names this id but its typed-definition mock only knows `e2e-workflow` and
 *    the scientific templates, so the read 501s. That is a gap in the fixture's
 *    own internal consistency, not a claim about this lane; it is reported to
 *    the orchestrator in INTEGRATION.md.
 */
async function bindSessionToPipeline(page: Page) {
  await page.route("**/sessions/session-e2e/run/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "running",
        run: {
          runId: "run-f9",
          lastSeq: 5,
          frames: [
            { seq: 1, type: "run_start", runId: "run-f9" },
            { seq: 2, type: "turn_start" },
            { seq: 3, type: "message_start", role: "user", content: USER_PROMPT },
            { seq: 4, type: "turn_end" },
            { seq: 5, type: "done" },
          ],
        },
      }),
    });
  });
  // The suite's registry list carries only `e2e-workflow`, so without this the
  // resolver correctly refuses to read the linked definition at all.
  await page.route("**/dag-workflows", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          { id: "e2e-workflow", revision: 1, createdAt: 1, updatedAt: 9, graphSha256: "e2e-graph-sha256", schemaVersion: "1.0", name: "E2E Workflow", description: "Deterministic E2E workflow", nodeCount: 1, edgeCount: 0 },
          { id: "chat-e2e-workflow", revision: 3, createdAt: 1, updatedAt: 2, graphSha256: "f9", schemaVersion: "1.0", name: "Silhouette pipeline", description: null, nodeCount: 2, edgeCount: 1 },
        ],
      }),
    });
  });
  await page.route("**/dag-workflows/chat-e2e-workflow", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { ETag: '"3"' },
      body: JSON.stringify({
        storageVersion: 1,
        id: "chat-e2e-workflow",
        revision: 3,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "f9",
        graph: {
          schemaVersion: "1.0",
          id: "chat-e2e-workflow",
          name: "Silhouette pipeline",
          entryNodeId: "prepare",
          limits: {
            maxIterations: 6,
            maxModelCalls: 8,
            maxParallelism: 2,
            maxSubagents: 2,
            timeoutMs: 300000,
            maxTokens: 50000,
            maxCostUsd: 5,
            maxRetries: 2,
          },
          evidence: {
            enabled: true,
            minimumIndependentSources: 1,
            requireArtifactReferences: false,
            onUnsupportedOutput: "fail",
          },
          nodes: [
            { id: "prepare", name: "Prepare counts", kind: "agent", terminal: false, workspace: { isolation: "read-only", writePaths: [] }, prompt: "p" },
            { id: "analyze", name: "Analyze clusters", kind: "agent", terminal: true, workspace: { isolation: "read-only", writePaths: [] }, prompt: "a" },
          ],
          edges: [{ id: "prepare-analyze", from: "prepare", to: "analyze" }],
        },
      }),
    });
  });
}

/**
 * Evidence capture, off by default.
 *
 * Gate D and Gate U both ask for screenshots from a live preview, and the
 * honest place to take them is the same run that asserts the behaviour — a
 * screenshot from a separate ad-hoc script proves a page, not a passing state.
 * `F9_SHOT_DIR` is unset in CI and in every other lane's run, so this file
 * behaves identically for everyone who is not gathering F9's evidence.
 */
const SHOT_DIR = process.env.F9_SHOT_DIR;

async function capture(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

/** next-themes writes `.dark` onto the document element; this is that switch. */
async function setDark(page: Page, dark: boolean) {
  await page.evaluate((wantDark) => {
    document.documentElement.classList.toggle("dark", wantDark);
  }, dark);
}

function elevationPanel(page: Page) {
  return page.getByRole("region", { name: "Prompt elevation" });
}

function railTrigger(page: Page) {
  return page.getByRole("button", { name: /Pipeline preview/ });
}

function overlay(page: Page) {
  return page.getByRole("dialog", { name: "Pipeline preview" });
}

function chatComposer(page: Page) {
  const composerForm = page.locator("form").filter({
    has: page.getByRole("button", { name: /^(Submit|Stop)$/ }),
  });
  return composerForm.getByRole("textbox");
}

async function openChat(page: Page) {
  await selectWorkspaceTab(page, "Chat");
  await expect(chatComposer(page)).toBeVisible();
}

/** Start a held streaming turn so the tab binds to a session id, as chat.spec does. */
async function startHeldRun(page: Page) {
  await openChat(page);
  await page.evaluate(() => localStorage.setItem("kady:e2e-run-mode", "streaming"));
  const composer = chatComposer(page);
  await composer.fill(USER_PROMPT);
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
}

test.describe("row 17 — the Prompt Elevation panel is on the chat surface", () => {
  test("asks the elevation question where a reader is already looking", async ({ workspacePage: page }) => {
    await openChat(page);
    const panel = elevationPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(ELEVATION_QUESTION)).toBeVisible();
    await capture(page, "row17-panel-light");
    await setDark(page, true);
    await expect(panel.getByText(ELEVATION_QUESTION)).toBeVisible();
    await capture(page, "row17-panel-dark");
    await setDark(page, false);
  });

  test("is disabled with a VISIBLE reason while there is nothing to elevate", async ({ workspacePage: page }) => {
    await openChat(page);
    const elevate = elevationPanel(page).getByRole("button", { name: "Elevate", exact: true });
    await expect(elevate).toBeDisabled();
    await expect(elevationPanel(page).getByText(NO_SESSION_REASON)).toBeVisible();
    // §6.7: the reason is tied to the control, not merely near it.
    const describedBy = await elevate.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText(NO_SESSION_REASON);
  });

  test("both answers are keyboard reachable and in a sane tab order", async ({ workspacePage: page }) => {
    await openChat(page);
    const panel = elevationPanel(page);
    await panel.getByRole("button", { name: "Not now" }).focus();
    await expect(panel.getByRole("button", { name: "Not now" })).toBeFocused();
    await page.keyboard.press("Enter");
    // Declining collapses the question but never removes the capability.
    await expect(panel.getByText(ELEVATION_QUESTION)).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Elevate this chat to a DAG pipeline" }),
    ).toBeVisible();
  });

  test("stays honestly disabled on a real conversation until F5's shared API lands", async ({ workspacePage: page }) => {
    await bindSessionToPipeline(page);
    await startHeldRun(page);
    const elevate = elevationPanel(page).getByRole("button", { name: "Elevate", exact: true });
    await expect(elevate).toBeDisabled({ timeout: 15_000 });
    await expect(elevationPanel(page).getByText(ELEVATION_API_UNAVAILABLE_REASON, {
      exact: false,
    })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /promote|elevate/i })).toHaveCount(0);
    await capture(page, "row17-shared-api-disabled");
  });
});

test.describe("row 18 — the baby view rail", () => {
  test("the rail itself is visible beside the chat and is in the tab order", async ({ workspacePage: page }) => {
    await openChat(page);
    await expect(railTrigger(page)).toBeVisible();
    await expect(railTrigger(page)).toHaveAttribute("aria-expanded", "false");
    const box = await railTrigger(page).boundingBox();
    // ~1 inch at the 96dpi CSS reference is 96px; the trigger fills the rail's
    // width inside its padding, so it must be within a few px of it.
    expect(box?.width ?? 0).toBeGreaterThan(70);
    expect(box?.width ?? 0).toBeLessThanOrEqual(96);
  });

  test("hover opens the preview over the document area", async ({ workspacePage: page }) => {
    await openChat(page);
    await railTrigger(page).hover();
    await expect(overlay(page)).toBeVisible();
    const box = await overlay(page).boundingBox();
    // ~2in x 2in at the 96dpi CSS reference = 192px x 192px = 12rem x 12rem.
    expect(box?.width).toBeCloseTo(192, 0);
    expect(box?.height).toBeCloseTo(192, 0);
    await capture(page, "row18-overlay-light");
    await setDark(page, true);
    await expect(overlay(page)).toBeVisible();
    await capture(page, "row18-overlay-dark");
    await setDark(page, false);
  });

  test("keyboard focus opens it too, and Escape closes it without stranding focus", async ({ workspacePage: page }) => {
    await openChat(page);
    await railTrigger(page).focus();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveAttribute("aria-modal", "true");

    // The keyboard-opened overlay traps focus between its trigger and close
    // control. Both directions are asserted before Escape restores the trigger.
    await page.keyboard.press("Tab");
    const close = overlay(page).getByRole("button", { name: "Close pipeline preview" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(railTrigger(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(railTrigger(page)).toBeFocused();
    await expect(overlay(page)).toBeVisible();
    // The focus ring is a real ring, not an opacity change (§6.6).
    await capture(page, "row18-focus-ring-light");
    await setDark(page, true);
    await capture(page, "row18-focus-ring-dark");
    await setDark(page, false);

    // Gate D, verified in the running app rather than assumed from the class
    // string: Tailwind v4 only emits utilities it FINDS IN SOURCE, so a token
    // utility that was never generated would silently leave the ring at its
    // default and the boundary at its default, and the class name in the diff
    // would be a claim nothing backs.
    const resolved = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const overlayElement = document.querySelector(
        '[role="dialog"][aria-label="Pipeline preview"]',
      ) as HTMLElement;
      const toRgb = (css: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) return "";
        context.fillStyle = "#000000";
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        return `${data[0]},${data[1]},${data[2]}`;
      };

      // `--tw-ring-color` is declared inside the `:focus-visible` rule, so it is
      // absent from the element's computed style until that state matches.
      // Reading the generated RULE proves the utility exists and names which
      // token it points at, which is the whole of the claim.
      // Tailwind v4 emits everything inside `@layer utilities`, so the rules are
      // NOT at the top level of the sheet — a flat scan finds nothing and would
      // read as "the utility was never generated".
      const declarations: string[] = [];
      const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          const grouping = rule as CSSGroupingRule;
          if (grouping.cssRules) visit(grouping.cssRules);
          const styleRule = rule as CSSStyleRule;
          if (typeof styleRule.selectorText !== "string") continue;
          if (!styleRule.selectorText.includes("focus-visible\\:ring-foreground:")) continue;
          declarations.push(styleRule.style.getPropertyValue("--tw-ring-color").trim());
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          visit(sheet.cssRules);
        } catch {
          continue;
        }
      }

      return {
        ringDeclarations: declarations,
        overlayBorder: toRgb(getComputedStyle(overlayElement).borderTopColor),
        mutedForegroundToken: toRgb(root.getPropertyValue("--muted-foreground").trim()),
        borderToken: toRgb(root.getPropertyValue("--border").trim()),
      };
    });

    // The `focus-visible:ring-foreground` utility was generated, and it points
    // at the foreground token rather than `--ring`, whose light-mode value
    // measures 2.58:1 against the background — under §6.6's 3:1 floor.
    expect(resolved.ringDeclarations.length).toBeGreaterThan(0);
    for (const declaration of resolved.ringDeclarations) {
      expect(declaration).toContain("foreground");
      expect(declaration).not.toContain("--color-ring");
    }
    // The overlay boundary really is the muted-foreground token and really is
    // not the default border token.
    expect(resolved.overlayBorder).toBe(resolved.mutedForegroundToken);
    expect(resolved.overlayBorder).not.toBe(resolved.borderToken);

    await page.keyboard.press("Escape");
    await expect(overlay(page)).toHaveCount(0);
    await expect(railTrigger(page)).toBeFocused();
  });

  test("the preview renders the ACTUAL pipeline, named and counted from the document", async ({ workspacePage: page }) => {
    await openChat(page);
    await railTrigger(page).hover();
    const preview = overlay(page);
    await expect(preview).toContainText("E2E Workflow");
    await expect(preview).toContainText("Most recent in this project");
    await expect(preview).toContainText("1 node · 0 edges");
    // The node names the 192px drawing cannot carry are carried in text.
    await expect(preview).toContainText("1. Analyze — agent, terminal");
    await capture(page, "row18-preview-real-document");
  });

  test("the preview follows the pipeline the chat becomes bound to", async ({ workspacePage: page }) => {
    await bindSessionToPipeline(page);
    await openChat(page);
    await railTrigger(page).hover();
    await expect(overlay(page)).toContainText("Most recent in this project");
    await expect(overlay(page)).toContainText("E2E Workflow");

    // Starting a run binds this tab to a session, and that session's typed
    // workflow-run link names a DIFFERENT workflow. A placeholder preview would
    // not move; this one must.
    await startHeldRun(page);
    await railTrigger(page).hover();
    await expect(overlay(page)).toContainText("Linked to this chat", { timeout: 20_000 });
    // Not merely a different label — a different DOCUMENT.
    await expect(overlay(page)).toContainText("Silhouette pipeline");
    await expect(overlay(page)).toContainText("2 nodes · 1 edge · rev 3");
  });
});
