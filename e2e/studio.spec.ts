import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { STUDIO_FONT_SPECIMENS, STUDIO_SECTIONS, STUDIO_STATUS_ITEMS, STUDIO_SWATCHES } from "./inventory";

const EXPECTED_FONT_FAMILIES: Record<(typeof STUDIO_FONT_SPECIMENS)[number], RegExp> = {
  "Display / --fhero": /0xProto Nerd Font/i,
  "Navigation / --fnav": /Inter/i,
  "CTA + code / --fcta": /(FiraCode Nerd Font|Space Mono)/i,
  "Figures / --ffig": /(Tinos Nerd Font|Tinos)/i,
  "Annotations / --fann": /(Terminess Nerd Font|Space Mono)/i,
};

const EXPECTED_SWATCH_COLORS: Record<(typeof STUDIO_SWATCHES)[number], string> = {
  Canvas: "rgb(9, 11, 13)",
  Surface: "rgb(12, 15, 18)",
  Line: "rgb(28, 33, 38)",
  Text: "rgb(238, 242, 244)",
  Cyan: "rgb(47, 212, 236)",
  Blue: "rgb(31, 127, 209)",
  Highlight: "rgb(255, 225, 77)",
};

const EXPECTED_STATUS_STYLES: Record<
  (typeof STUDIO_STATUS_ITEMS)[number],
  { backgroundColor: string; borderColor: string; color: string }
> = {
  VERIFIED: {
    backgroundColor: "rgba(47, 212, 236, 0.1)",
    borderColor: "rgb(21, 149, 184)",
    color: "rgb(138, 240, 251)",
  },
  SUPERVISED: {
    backgroundColor: "rgba(31, 127, 209, 0.12)",
    borderColor: "rgb(31, 127, 209)",
    color: "rgb(127, 196, 240)",
  },
  REVIEW: {
    backgroundColor: "rgba(255, 225, 77, 0.08)",
    borderColor: "rgb(255, 225, 77)",
    color: "rgb(255, 225, 77)",
  },
  DRAFT: {
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderColor: "rgb(42, 49, 56)",
    color: "rgb(127, 142, 150)",
  },
  "12 STEPS": {
    backgroundColor: "rgb(9, 11, 13)",
    borderColor: "rgb(42, 49, 56)",
    color: "rgb(174, 188, 195)",
  },
  "$0.84 COMMITTED": {
    backgroundColor: "rgb(9, 11, 13)",
    borderColor: "rgb(42, 49, 56)",
    color: "rgb(174, 188, 195)",
  },
};

async function computedPaint(locator: Locator) {
  return locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      color: computed.color,
    };
  });
}

async function openStudio(page: Page) {
  await page.getByRole("button", { name: "Components studio" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Components studio" })).toBeVisible();
  return dialog;
}

test.describe("Scientific DAG Studio interaction and rendered visual contract", () => {
  test("launcher is contained by stable header chrome", async ({ workspacePage }) => {
    const launcher = workspacePage.getByRole("button", { name: "Components studio" });
    const header = workspacePage.locator("header").filter({ has: launcher });
    await expect(header).toBeVisible();
    await expect(launcher).toHaveCSS("position", "static");
    const [headerRect, launcherRect] = await Promise.all([
      header.boundingBox(),
      launcher.boundingBox(),
    ]);
    expect(headerRect).not.toBeNull();
    expect(launcherRect).not.toBeNull();
    expect(launcherRect!.x).toBeGreaterThanOrEqual(headerRect!.x);
    expect(launcherRect!.y).toBeGreaterThanOrEqual(headerRect!.y);
    expect(launcherRect!.x + launcherRect!.width).toBeLessThanOrEqual(
      headerRect!.x + headerRect!.width,
    );
    expect(launcherRect!.y + launcherRect!.height).toBeLessThanOrEqual(
      headerRect!.y + headerRect!.height,
    );
  });

  test("launcher opens the focused popup", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await expect(dialog.getByRole("button", { name: "Close components studio" })).toBeFocused();
  });

  test("close control dismisses the popup", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await dialog.getByRole("button", { name: "Close components studio" }).click();
    await expect(dialog).toBeHidden();
  });

  test("Escape dismisses the popup", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await workspacePage.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  for (const sectionName of STUDIO_SECTIONS) {
    test(`${sectionName} occupies a rendered studio section`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const section = dialog.getByRole("heading", { name: sectionName }).locator("..").locator("..");
      const layout = await section.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { display: getComputedStyle(element).display, height: box.height, width: box.width };
      });
      expect(layout.display).not.toBe("none");
      expect(layout.width).toBeGreaterThan(100);
      expect(layout.height).toBeGreaterThan(40);
    });
  }

  for (const specimen of STUDIO_FONT_SPECIMENS) {
    test(`${specimen} resolves the intended role face`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const sample = dialog.getByText(specimen, { exact: true }).locator("..").locator("strong");
      await expect(sample).toBeVisible();
      const family = await sample.evaluate((element) => getComputedStyle(element).fontFamily);
      expect(family).toMatch(EXPECTED_FONT_FAMILIES[specimen]);
    });
  }

  for (const swatchName of STUDIO_SWATCHES) {
    test(`${swatchName} paints the declared palette color`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const colorSample = dialog.getByText(swatchName, { exact: true }).locator("..").locator("span");
      await expect(colorSample).toBeVisible();
      const backgroundColor = await colorSample.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      expect(backgroundColor).toBe(EXPECTED_SWATCH_COLORS[swatchName]);
    });
  }

  for (const statusItem of STUDIO_STATUS_ITEMS) {
    test(`${statusItem} paints its semantic status treatment`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const status = dialog.getByText(statusItem, { exact: true });
      await expect(status).toBeVisible();
      expect(await computedPaint(status)).toEqual(EXPECTED_STATUS_STYLES[statusItem]);
    });
  }

  test("Awaiting graph is visibly and semantically disabled", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    const action = dialog.getByRole("button", { name: "Awaiting graph" });
    await expect(action).toBeDisabled();
    await expect(action).toHaveCSS("cursor", "not-allowed");
    await expect(action).toHaveCSS("background-color", "rgb(28, 33, 38)");
  });

  for (const card of [
    { name: "Literature synthesis", borderColor: "rgb(21, 149, 184)", status: "RUNNING" },
    { name: "Differential analysis", borderColor: "rgb(42, 49, 56)", status: "QUEUED" },
  ] as const) {
    test(`${card.name} paints its distinct node-card state`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const article = dialog.getByText(card.name, { exact: true }).locator("..").locator("..");
      await expect(article).toContainText(card.status);
      await expect(article).toHaveCSS("border-color", card.borderColor);
    });
  }
});

test.describe("documented product gaps — excluded from the substantive count", () => {
  for (const actionName of ["Run graph", "Validate", "Save draft"] as const) {
    test.skip(`${actionName} needs an observable production handler`, async () => {
      // scientific-dag-studio-buttons-ctas.tsx renders this enabled specimen
      // without onClick or state. A passing E2E assertion would hide the gap.
    });
  }
});
