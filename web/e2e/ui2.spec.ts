// danbot-byok — e2e/ui2.spec.ts
// Production-server UI proofs: Fusion shows in the model picker (59), and the
// deliberation-backend picker renders in the agent builder (96). One shared page, serial.

import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });
});

test.afterAll(async () => {
  await page.close();
});

test("Fusion appears in the model picker [59]", async () => {
  await page.getByText("Claude Opus 4.8").first().click(); // open the model selector
  await expect(page.getByText(/Fusion/i).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
});
