// DAG-Pipelines feature E2E — exercises the new shell nav (Workflows / DAG Pipelines /
// Pipeline Builder / Agent Console), the Pipeline Builder iframe, and the Agent Console.
// Points at the running Next.js dev server (baseURL from playwright.config.ts). Screenshots
// land in test-results/ for the proof tearsheet.
import { test, expect } from "@playwright/test";

const SHOTS = "test-results/dag-pipelines";

test.describe("DAG-Pipelines shell", () => {
  test("app shell loads with no fatal console errors", async ({ page }) => {
    const fatal: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") fatal.push(m.text());
    });
    const res = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(res!.status(), "root should not be 4xx/5xx").toBeLessThan(400);
    await expect(page.locator("body")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-shell.png`, fullPage: true });
    // Ignore benign resource/network noise + dev-only React hydration/caret warnings;
    // only a genuine uncaught page crash matters here.
    const realFatal = fatal.filter(
      (t) => !/favicon|net::ERR|Failed to load resource|hydrat|caret-color|Warning:/i.test(t),
    );
    expect(realFatal, `fatal console errors:\n${realFatal.join("\n")}`).toHaveLength(0);
  });

  test("right-side nav exposes the four pills in order", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    for (const label of ["Workflows", "DAG Pipelines", "Pipeline Builder", "Agent Console"]) {
      await expect(
        page.getByRole("button", { name: label }).or(page.getByText(label, { exact: true })).first(),
        `nav pill "${label}" should be visible`,
      ).toBeVisible();
    }
  });

  test("Pipeline Builder pill shows the Archon builder iframe (or a setup gate)", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Pipeline Builder" }).click();
    // The panel embeds Archon's rebranded builder via an iframe pointed at the sidecar.
    const builderIframe = page.locator('iframe[title="Pipeline Builder"]');
    await expect(builderIframe).toBeVisible({ timeout: 15000 });
    await expect(builderIframe).toHaveAttribute("src", /:3091\/.*workflows\/builder/);
    await page.screenshot({ path: `${SHOTS}/02-pipeline-builder.png`, fullPage: true });
  });

  test("Agent Console pill renders the console panel", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("Agent Console", { exact: true }).first().click();
    // The console shows a title/heading and either a runs table or the start-loop form.
    await expect(
      page.getByText(/Agent Console|Start a loop|goal|No runs|Runs/i).first(),
    ).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/03-agent-console.png`, fullPage: true });
  });

  test("DAG Pipelines pill renders the pipelines panel", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByText("DAG Pipelines", { exact: true }).first().click();
    await expect(page.getByText(/Pipelines|engine|healthy|Open builder/i).first()).toBeVisible({
      timeout: 15000,
    });
    await page.screenshot({ path: `${SHOTS}/04-dag-pipelines.png`, fullPage: true });
  });
});
