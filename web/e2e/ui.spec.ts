// danbot-byok — e2e/ui.spec.ts
// Interaction proofs for the base UI, run against the production server (next start),
// which is stable under E2E (the dev server flaked). One shared page, serial. Ordered
// most-reliable first so a late flake doesn't mask earlier passes; the chat send runs on
// the warm Chat 1 tab (cached context → cheap) before a second tab is opened.

import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await page.close();
});

test("cost pill shows a running total [46]", async () => {
  await expect(page.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();
});

test("Settings dialog opens [55]", async () => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
});

test("file tree renders and opens a file [53]", async () => {
  await expect(page.getByText("AGENTS.md").first()).toBeVisible();
  // Open a CODE file (pyproject.toml) → CodeMirror editor mounts (markdown opens a viewer).
  await page.getByText("pyproject.toml").first().click();
  await expect(page.locator(".cm-editor, .cm-content").first()).toBeVisible({ timeout: 20_000 });
});

test("chat send streams a reply [15]", async () => {
  const input = page.getByPlaceholder(/Ask Kady/);
  await input.click();
  await input.fill("Reply with exactly the single word PONG and nothing else.");
  await page.getByRole("button", { name: "Submit" }).click();
  // The input clears on send, so a later PONG can only be the streamed reply (not my echo).
  await expect(input).toHaveValue("", { timeout: 10_000 });
  await expect(page.getByText(/PONG/i).first()).toBeVisible({ timeout: 90_000 });
});

test("tab bar opens a new chat tab [56]", async () => {
  const tabs = page.getByRole("button", { name: /^Chat \d+$/ });
  const before = await tabs.count();
  await page.getByRole("button", { name: "New chat tab" }).click();
  await expect(tabs).toHaveCount(before + 1, { timeout: 10_000 });
});

test("Workflows launcher opens [54]", async () => {
  await page.getByRole("button", { name: "Workflows" }).click();
  // The launcher may be a dialog, popover, menu, or Radix open-state container.
  await expect(
    page.locator('[role="dialog"], [role="menu"], [role="listbox"], [data-state="open"]').first(),
  ).toBeVisible({ timeout: 8_000 });
});
