// danbot-byok — e2e/smoke.spec.ts
// The base UI smoke proof (checklist 6 + 10): the app shell loads and renders real
// content, and the page produces no fatal console/page errors (benign dev-only noise is
// filtered). This is the foundation the richer flows (Fusion, agent builder, pipelines)
// build on — if the shell doesn't render cleanly, nothing downstream can.

import { test, expect } from "@playwright/test";

// Dev-only / third-party noise that isn't a real app failure.
const BENIGN = /favicon|sourcemap|Download the React DevTools|Fast Refresh|hydrat/i;

test("app shell loads with no fatal console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${String(err)}`));

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response, "no response for /").not.toBeNull();
  expect(response!.status(), "root should not be a 4xx/5xx").toBeLessThan(400);

  // The SPA should hydrate to non-empty content (not a blank or crashed page).
  await expect(page.locator("body")).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  const bodyText = (await page.locator("body").innerText()).trim();
  expect(bodyText.length, "app shell rendered no text").toBeGreaterThan(0);

  const fatal = errors.filter((e) => !BENIGN.test(e));
  expect(fatal, `fatal console errors:\n${fatal.join("\n")}`).toHaveLength(0);
});
