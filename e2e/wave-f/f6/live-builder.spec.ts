import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";

import {
  expect,
  selectLiveWorkspaceTab,
  test,
  type LiveWorkspace,
} from "../../live-fixtures";

// TIER: UNMOCKED. Real backend on KADY_PORT, real engine on
// KADY_PIPELINE_ENGINE_PORT. Gate U evidence only; Gate B uses the F6 server
// effect test.

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.KADY_E2E_EVIDENCE_DIR ??
    path.resolve(".stably/wave-f-evidence/f6");
  fs.mkdirSync(directory, { recursive: true });
  const screenshotPath = path.join(directory, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function createTypedWorkflow(
  workspace: LiveWorkspace,
  testInfo: TestInfo,
): Promise<{ id: string; name: string }> {
  const id = `f6-live-${testInfo.workerIndex}-${randomUUID().slice(0, 8)}`;
  const name = `F6 Live ${id.slice(-8)}`;
  await selectLiveWorkspaceTab(workspace.page, "Scientific Pipelines");
  await workspace.page.getByRole("button", { name: "New typed workflow" }).click();
  await workspace.page.getByLabel("Workflow template").selectOption("ml-model-selection-review");
  await workspace.page.getByLabel("New workflow id").fill(id);
  await workspace.page.getByLabel("New workflow name").fill(name);
  const responsePromise = workspace.page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/dag-workflows/${id}` &&
    response.request().method() === "PUT"
  ));
  await workspace.page.getByRole("button", { name: "Create and open" }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(workspace.page.getByRole("region", { name, exact: true })).toBeVisible();
  return { id, name };
}

test.describe("F6 · unmocked builder and run paths", () => {
  test("@live compose enables a real planning fusion node while workflow-ref stays honest", async ({
    liveWorkspace,
  }, testInfo) => {
    const workflow = await createTypedWorkflow(liveWorkspace, testInfo);
    liveWorkspace.expectRefusedResourceStatus(404);
    liveWorkspace.expectRefusedResourceStatus(404);
    await selectLiveWorkspaceTab(liveWorkspace.page, "Builder");
    await liveWorkspace.page
      .getByRole("listbox", { name: "Workflow sources" })
      .getByRole("option")
      .filter({ hasText: workflow.name })
      .first()
      .click();
    await liveWorkspace.page.getByTestId("compose-toggle").click();

    await expect(
      liveWorkspace.page.getByTestId(`saved-workflow-reference-${workflow.id}`),
    ).toBeDisabled();
    await expect(liveWorkspace.page.getByTestId("saved-workflow-reference-reason"))
      .toContainText("no workflow-reference node kind");

    const frame = liveWorkspace.page.frameLocator('iframe[title="DAG Builder"]');
    const beforeNodes = await frame.locator(".react-flow__node").count();
    const enabled = liveWorkspace.page.getByTestId("fusion-boost-enabled");
    await enabled.check();
    const planning = liveWorkspace.page.getByTestId("fusion-boost-stage-planning");
    await expect(planning).toBeEnabled();
    await planning.check();
    await expect(liveWorkspace.page.getByTestId("builder-host-status"))
      .toContainText("Fusion boost on at: planning");
    await expect(frame.locator(".react-flow__node")).toHaveCount(beforeNodes + 1);

    await liveWorkspace.page.getByTestId("durability-toggle").click();
    const durability = liveWorkspace.page.getByRole("region", { name: "Durability" });
    await expect(durability).toContainText("not available in this server build yet");
    await attachScreenshot(liveWorkspace.page, testInfo, "compose-fusion-and-disabled-reference");
  });

  test("@live a real best-of-n run renders modelCallSlots as a React Flow sequence", async ({
    liveWorkspace,
  }, testInfo) => {
    const workflow = await createTypedWorkflow(liveWorkspace, testInfo);
    liveWorkspace.expectRefusedResourceStatus(404);
    liveWorkspace.expectRefusedResourceStatus(404);
    const details = liveWorkspace.page.getByRole("region", {
      name: workflow.name,
      exact: true,
    });
    const runResponse = liveWorkspace.page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/dag-workflows/${workflow.id}/runs` &&
      response.request().method() === "POST"
    ));
    await details.getByRole("button", { name: "Run typed workflow" }).click();
    expect((await runResponse).status()).toBe(202);

    const branches = liveWorkspace.page.getByTestId("best-of-n-branches");
    await expect(branches).toBeVisible({ timeout: 20_000 });
    await expect(branches).toContainText("React Flow sequence");
    await expect(branches).toContainText("not concurrent fan-out");
    await expect(branches.locator(".react-flow")).toBeVisible();
    await expect(liveWorkspace.page.getByTestId("best-of-n-branch-1")).toBeVisible();
    await attachScreenshot(liveWorkspace.page, testInfo, "best-of-n-react-flow-live");
  });
});
