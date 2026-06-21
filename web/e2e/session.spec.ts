// danbot-byok — e2e/session.spec.ts
// Proves a realistic session stays clean (checklist 58): driving the main surfaces
// (settings, model picker, a new tab, Workflows, Pipelines) produces no fatal console
// errors or unhandled promise rejections (benign dev noise filtered).

import { test, expect } from "@playwright/test";

const BENIGN = /favicon|sourcemap|DevTools|Fast Refresh|hydrat/i;

test("no fatal console errors / rejections during a normal session [58]", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e)}`));

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  // Exercise the main surfaces.
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.keyboard.press("Escape");
  await page.getByText("Claude Opus 4.8").first().click(); // open + close the model picker
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New chat tab" }).click();
  await page.getByRole("button", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "Pipelines" }).click();
  await page.waitForTimeout(1500);

  const fatal = errors.filter((e) => !BENIGN.test(e));
  expect(fatal, `fatal console output:\n${fatal.join("\n")}`).toHaveLength(0);
});
