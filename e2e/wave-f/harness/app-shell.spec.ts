/**
 * Wave-F reachability sweep — one item per app surface, 15 items.
 *
 * TIER: UNMOCKED for every item in this file. There is no `page.route` in this file or anywhere in
 * its fixture chain (`./fixtures` -> `../../live-fixtures`), so every request the browser makes here
 * is served by the real backend on KADY_PORT and the real vendored engine on
 * KADY_PIPELINE_ENGINE_PORT. Boot them with scripts/preview-up.mjs first.
 *
 * WHY IT EXISTS: "every Settings tab is reachable" was, before this file, an unmeasured claim — the
 * mocked suite opened exactly one of the eight (`e2e/workspace.spec.ts:34-40`, the Skills tab, to
 * check a retired name is gone). This sweep turns the whole shell into measured facts, at the tier
 * where "the panel rendered" means it rendered against the real server.
 *
 * NOT A DUPLICATE of `workspace.spec.ts`'s thin inventory smoke: that one is mocked, asserts
 * visibility only, and retains no artifact. Each item here additionally (a) reaches its surface by
 * keyboard and records the tab-order distance, and (b) writes a full-page screenshot that is this
 * lane's Gate U evidence.
 *
 * GATE SCOPE: these items are Gate U evidence. They are NOT Gate B evidence — no assertion here
 * proves a value reached an executor dispatch decision or a provider call. Gate B needs a server test.
 */
import type { Page } from "@playwright/test";

import { WORKSPACE_TABS } from "../../inventory";
import { expect, test } from "../fixtures";

/**
 * The named thing each workspace surface must present before it counts as rendered. Deliberately a
 * control or heading that *names the surface* rather than "the page did not throw": #62 has already
 * shown that a surface can survive render and still be empty of everything the user came for.
 */
const WORKSPACE_SURFACE_ANCHORS: Record<
  (typeof WORKSPACE_TABS)[number],
  { readonly describedAs: string; readonly locate: (page: Page) => ReturnType<Page["locator"]> }
> = {
  Chat: {
    describedAs: 'the composer placeholder "Ask Kady anything…"',
    locate: (page) => page.getByPlaceholder(/^Ask Kady anything/),
  },
  Workflows: {
    describedAs: 'the "Search workflows..." filter',
    locate: (page) => page.getByPlaceholder("Search workflows..."),
  },
  "Scientific Pipelines": {
    describedAs: 'a heading naming "Scientific Pipelines"',
    locate: (page) => page.getByRole("heading", { name: /Scientific Pipelines/i }),
  },
  Builder: {
    describedAs: 'the "DAG Builder" iframe',
    locate: (page) => page.getByTitle("DAG Builder"),
  },
  Console: {
    describedAs: 'the "DAG Runs" control',
    locate: (page) => page.getByRole("button", { name: /DAG Runs/i }),
  },
  Raindrop: {
    describedAs: 'a heading naming "Raindrop"',
    locate: (page) => page.getByRole("heading", { name: /Raindrop/i }),
  },
};

/** The eight Settings tabs, read from web/src/components/settings-dialog.tsx:655-711. */
const SETTINGS_TABS = [
  { tab: "Model providers", heading: "Model providers" },
  { tab: "API keys", heading: "API keys" },
  { tab: "Skills", heading: "Skills" },
  { tab: "Specialists", heading: "Sub-agents" },
  { tab: "Connectors", heading: "Connectors" },
  { tab: "Fusion", heading: "Fusion Configurations" },
  { tab: "Pipelines", heading: "DAG Runtime" },
  { tab: "Appearance", heading: "Appearance" },
] as const;

const MAX_TAB_PRESSES = 40;

async function describeFocusedElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "(body)";
    const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
    return `${role}:${name.slice(0, 40) || "(unnamed)"}`;
  });
}

/**
 * Walk the real tab order until `target` holds focus, and report how far it was. Returns the focus
 * chain so a failure names every stop instead of just saying "not reachable" — and so the passing
 * case can record a number in the evidence file rather than an assertion of compliance.
 */
async function tabUntilFocused(
  page: Page,
  target: ReturnType<Page["locator"]>,
  what: string,
): Promise<{ presses: number; chain: string[] }> {
  const chain: string[] = [];
  for (let presses = 0; presses <= MAX_TAB_PRESSES; presses += 1) {
    const focused = await target.evaluate(
      (element) => element === document.activeElement,
    ).catch(() => false);
    if (focused) {
      await expect(target, `${what} holds focus but is not visible.`).toBeVisible();
      return { presses, chain };
    }
    chain.push(await describeFocusedElement(page));
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `${what} was not reachable within ${String(MAX_TAB_PRESSES)} Tab presses. Focus order observed:\n` +
      chain.map((stop, index) => `  ${String(index)}. ${stop}`).join("\n"),
  );
}

test.describe("Wave-F reachability sweep: workspace surfaces", () => {
  for (const tabName of WORKSPACE_TABS) {
    // UNMOCKED. Real backend, real engine.
    test(`workspace surface ${tabName} is keyboard-reachable and renders its own content`, async ({
      liveWorkspace,
      evidence,
    }, testInfo) => {
      const { page } = liveWorkspace;
      const navigation = page.getByRole("navigation", { name: "Project workspace" });
      const navButton = navigation.getByRole("button", { name: tabName, exact: true });

      // Keyboard, not mouse: reach the control through the real tab order, then activate it with
      // Enter. A surface only a pointer can open fails Gate U however pretty it looks.
      const walk = await tabUntilFocused(page, navButton, `Workspace tab "${tabName}"`);
      await page.keyboard.press("Enter");
      await expect(navButton).toHaveAttribute("aria-current", "page");

      const anchor = WORKSPACE_SURFACE_ANCHORS[tabName];
      await expect(
        anchor.locate(page).first(),
        `Workspace surface "${tabName}" must present ${anchor.describedAs}.`,
      ).toBeVisible();

      const screenshot = await evidence.shot(
        `workspace-${tabName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      );
      testInfo.annotations.push({
        type: "wave-f-keyboard",
        description:
          `"${tabName}" reached in ${String(walk.presses)} Tab press(es) from workspace entry, ` +
          `activated with Enter; anchor = ${anchor.describedAs}; screenshot = ${screenshot}`,
      });
    });
  }
});

/**
 * Reach a Settings tab the way a keyboard user actually does.
 *
 * The first version of this helper just pressed Tab until the target held focus, and it failed on
 * seven of the eight tabs — correctly. A `tablist` implements a *roving tabindex*: exactly one
 * trigger (the selected one) is in the document tab order, and the rest are reached with the arrow
 * keys. The observed focus cycle inside the dialog was
 * `tab:API keys -> tabpanel -> button:Close -> (wrap)`, which is the ARIA-prescribed shape, not a
 * defect. So the honest keyboard proof is two-legged: Tab into the tablist, then arrow along it.
 */
async function keyboardReachSettingsTab(
  page: Page,
  settings: ReturnType<Page["getByRole"]>,
  tabName: string,
): Promise<{ tabPresses: number; arrowPresses: number }> {
  const target = settings.getByRole("tab", { name: tabName, exact: true });
  const focusChain: string[] = [];
  let tabPresses = 0;
  for (; tabPresses <= MAX_TAB_PRESSES; tabPresses += 1) {
    const onATab = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute("role") === "tab",
    );
    if (onATab) break;
    focusChain.push(await describeFocusedElement(page));
    await page.keyboard.press("Tab");
  }
  if (tabPresses > MAX_TAB_PRESSES) {
    throw new Error(
      `No Settings tab entered the tab order within ${String(MAX_TAB_PRESSES)} presses. ` +
        `Focus order observed:\n${focusChain.map((stop, index) => `  ${String(index)}. ${stop}`).join("\n")}`,
    );
  }

  const tabCount = await settings.getByRole("tab").count();
  for (let arrowPresses = 0; arrowPresses <= tabCount; arrowPresses += 1) {
    const focused = await target.evaluate((element) => element === document.activeElement);
    if (focused) {
      await expect(target, `Settings tab "${tabName}" holds focus but is not visible.`).toBeVisible();
      return { tabPresses, arrowPresses };
    }
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(
    `Settings tab "${tabName}" was not reachable with ArrowDown from the tablist ` +
      `(${String(tabCount)} tabs present). Focus stopped at ${await describeFocusedElement(page)}.`,
  );
}

test.describe("Wave-F reachability sweep: Settings tabs", () => {
  for (const settingsTab of SETTINGS_TABS) {
    // UNMOCKED. Real backend, real engine.
    test(`Settings tab ${settingsTab.tab} is keyboard-reachable and names itself`, async ({
      liveWorkspace,
      evidence,
    }, testInfo) => {
      const { page } = liveWorkspace;
      await page.getByRole("button", { name: "Open settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();

      const trigger = settings.getByRole("tab", { name: settingsTab.tab, exact: true });
      const walk = await keyboardReachSettingsTab(page, settings, settingsTab.tab);
      // Enter is a no-op for a tablist that activates on focus; it is here so this still passes
      // against a manual-activation tablist.
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-selected", "true");

      await expect(
        settings.getByRole("heading", { name: settingsTab.heading, exact: true }),
        `The "${settingsTab.tab}" panel must present a heading naming itself ` +
          `("${settingsTab.heading}") rather than merely failing to error.`,
      ).toBeVisible();

      const screenshot = await evidence.shot(
        `settings-${settingsTab.tab.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      );
      testInfo.annotations.push({
        type: "wave-f-keyboard",
        description:
          `"${settingsTab.tab}" reached with ${String(walk.tabPresses)} Tab press(es) into the ` +
          `tablist + ${String(walk.arrowPresses)} ArrowDown press(es) along it (roving tabindex); ` +
          `panel heading "${settingsTab.heading}" visible; screenshot = ${screenshot}`,
      });

      // Overlays close on Escape and this one is no exception -- §6.6 makes that a gate, so the
      // sweep measures it rather than assuming it.
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    });
  }
});

// UNMOCKED. The palette lives inside the vendored engine's iframe, which is served by the real
// engine process -- under the mocked tier even this traffic is intercepted (e2e/fixtures.ts:436).
test("Wave-F reachability sweep: the Builder node palette opens and offers a focusable node type", async ({
  liveWorkspace,
  evidence,
}, testInfo) => {
  const { page } = liveWorkspace;
  const navigation = page.getByRole("navigation", { name: "Project workspace" });
  const builderTab = navigation.getByRole("button", { name: "Builder", exact: true });
  const walk = await tabUntilFocused(page, builderTab, 'Workspace tab "Builder"');
  await page.keyboard.press("Enter");
  await expect(builderTab).toHaveAttribute("aria-current", "page");

  const frame = page.frameLocator('iframe[title="DAG Builder"]');
  await expect(frame.getByPlaceholder("workflow-name")).toBeVisible();
  const canvas = frame.locator(".react-flow");
  await expect(canvas).toBeVisible();
  await canvas.dblclick({ position: { x: 640, y: 360 } });

  const promptChoice = frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ });
  await expect(
    promptChoice,
    "The node palette must offer a named node type, not an empty menu.",
  ).toBeVisible();

  // Keyboard check across the frame boundary: the palette entry is a real button, so it takes focus
  // and reports itself as the frame's active element.
  await promptChoice.focus();
  await expect(frame.locator(":focus")).toBeVisible();
  const focusedPaletteEntry = await promptChoice.evaluate(
    (element) => element === document.activeElement,
  );
  expect(
    focusedPaletteEntry,
    "The focused palette entry must be the frame's active element.",
  ).toBe(true);

  const screenshot = await evidence.shot("builder-node-palette");
  testInfo.annotations.push({
    type: "wave-f-keyboard",
    description:
      `Builder reached in ${String(walk.presses)} Tab press(es); palette opened by double-click on ` +
      `the canvas; the "Prompt / Inline AI prompt" entry accepts focus; screenshot = ${screenshot}`,
  });
});
