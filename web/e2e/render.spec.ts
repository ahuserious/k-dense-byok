// danbot-byok — e2e/render.spec.ts
// Reliable render proofs: ONE page load, assert the core controls are present. (The
// interaction proofs — dialog opens, chat send — live in ui.spec.ts and want a stable
// production server; the Next dev server flakes under repeated cold loads.)

import { test, expect } from "@playwright/test";

test("app shell renders the core controls", async ({ page }) => {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  await expect(page.getByText(/\$\d+\.\d{2}/).first(), "cost pill [46]").toBeVisible();
  await expect(page.getByText("AGENTS.md").first(), "file tree [53]").toBeVisible();
  await expect(page.getByRole("button", { name: "Workflows", exact: true }), "workflows launcher [54]").toBeVisible();
  await expect(page.getByRole("button", { name: "Open settings" }), "settings button [55]").toBeVisible();
  await expect(page.getByRole("button", { name: "Chat 1", exact: true }), "tab bar [56]").toBeVisible();
  await expect(page.getByPlaceholder(/Ask Kady/), "chat input [15]").toBeVisible();
});
