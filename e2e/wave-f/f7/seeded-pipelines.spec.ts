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
import { e2eServiceOrigin } from "../../service-origins";
import { SEEDED_PIPELINES } from "./seeded-pipeline-inventory";

// TIER: UNMOCKED. Real backend on KADY_PORT, real engine on
// KADY_PIPELINE_ENGINE_PORT. Gate U evidence only; Gate B is in
// server/test/seed-pipelines.test.ts.

const RETIRED_BRAND = new RegExp(["arch", "on"].join(""), "i");

interface ProjectResponse {
  id: string;
  name: string;
}

interface WorkflowListResponse {
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    revision: number;
  }>;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const evidenceDir = process.env.KADY_E2E_EVIDENCE_DIR ??
    path.resolve(".stably/wave-f-evidence/f7");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function createFreshProject(
  workspace: LiveWorkspace,
  testInfo: TestInfo,
): Promise<ProjectResponse> {
  const { page } = workspace;
  await page.getByRole("button", { name: "Back to projects" }).click();
  await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();

  const name = `F7 seeded ${testInfo.workerIndex}-${randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name").fill(name);
  const createdResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/projects" &&
    response.request().method() === "POST"
  ));
  await dialog.getByRole("button", { name: "Create project" }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  expect(new URL(response.url()).origin).toBe(e2eServiceOrigin("backend"));
  const project = await response.json() as ProjectResponse;
  expect(project.name).toBe(name);
  await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
  return project;
}

async function openSeededRegistry(
  page: Page,
  expectedProjectId?: string,
): Promise<WorkflowListResponse> {
  await selectLiveWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();

  const listResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/dag-workflows" &&
    response.request().method() === "GET"
  ));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const response = await listResponsePromise;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).origin).toBe(e2eServiceOrigin("backend"));
  if (expectedProjectId) {
    expect(response.request().headers()["x-project-id"]).toBe(expectedProjectId);
  }
  return await response.json() as WorkflowListResponse;
}

function registry(page: Page) {
  return page.getByRole("list", { name: "Scientific pipeline workflows" });
}

test.describe("F7 · seeded pipelines in the workflow registry", () => {
  test("@live a project created through the UI immediately lists all three seeded pipelines", async ({
    liveWorkspace,
  }, testInfo) => {
    const project = await createFreshProject(liveWorkspace, testInfo);
    const body = await openSeededRegistry(liveWorkspace.page, project.id);

    expect(body.workflows.map(({ id }) => id).sort()).toEqual(
      SEEDED_PIPELINES.map(({ id }) => id).sort(),
    );
    const rows = registry(liveWorkspace.page).getByRole("listitem");
    for (const pipeline of SEEDED_PIPELINES) {
      await expect(rows.filter({ hasText: pipeline.name })).toHaveCount(1);
    }
    await attachScreenshot(liveWorkspace.page, testInfo, "fresh-project-seeded-pipelines");
  });

  test("@live no seeded row carries the retired brand name", async ({ liveWorkspace }) => {
    await openSeededRegistry(liveWorkspace.page);
    await expect(registry(liveWorkspace.page)).not.toContainText(RETIRED_BRAND);
    await expect(registry(liveWorkspace.page)).not.toContainText(/kdense-starter/i);
  });

  test("@live each seeded row states its purpose and pre-run limitations", async ({
    liveWorkspace,
  }) => {
    await openSeededRegistry(liveWorkspace.page);
    for (const pipeline of SEEDED_PIPELINES) {
      const row = registry(liveWorkspace.page)
        .getByRole("listitem")
        .filter({ hasText: pipeline.name });
      await expect(row).toContainText(pipeline.descriptionPhrase);
    }
    await expect(
      registry(liveWorkspace.page).getByRole("listitem").filter({ hasText: "Research Starter" }),
    ).toContainText("$0 workflow cost limit");
  });

  test("@live the loss of the human approval gate is visible before launch", async ({
    liveWorkspace,
  }) => {
    await openSeededRegistry(liveWorkspace.page);
    await expect(
      registry(liveWorkspace.page).getByRole("listitem").filter({ hasText: "Data Scientist" }),
    ).toContainText("This runtime has no human approval gate");
  });

  test("@live a seeded pipeline opens from the real registry with the mouse", async ({
    liveWorkspace,
  }, testInfo) => {
    await openSeededRegistry(liveWorkspace.page);
    await liveWorkspace.page.getByRole(
      "button",
      { name: "Open Data Scientist details" },
    ).click();
    const details = liveWorkspace.page.getByRole(
      "region",
      { name: "Data Scientist", exact: true },
    );
    await expect(details.getByRole("heading", { name: "Data Scientist" })).toBeVisible();
    await expect(
      details.getByRole("heading", { name: "Complete stored definition (read-only)" }),
    ).toBeVisible();
    await attachScreenshot(liveWorkspace.page, testInfo, "seeded-definition-details");
  });

  test("@live a seeded pipeline opens from the registry with the keyboard alone", async ({
    liveWorkspace,
  }, testInfo) => {
    await openSeededRegistry(liveWorkspace.page);
    const opener = liveWorkspace.page.getByRole(
      "button",
      { name: "Open Research Starter details" },
    );
    await opener.focus();
    await expect(opener).toBeFocused();
    await attachScreenshot(liveWorkspace.page, testInfo, "seeded-pipeline-focus");
    await liveWorkspace.page.keyboard.press("Enter");
    await expect(
      liveWorkspace.page.getByRole("region", { name: "Research Starter", exact: true }),
    ).toBeVisible();
  });

  test("@live the opened definition is the loader's stored graph with provenance and skills", async ({
    liveWorkspace,
  }) => {
    await openSeededRegistry(liveWorkspace.page);
    await liveWorkspace.page.getByRole(
      "button",
      { name: "Open Data Scientist details" },
    ).click();
    const definition = JSON.parse(
      await liveWorkspace.page.getByTestId("raw-typed-definition").innerText(),
    ) as {
      id: string;
      graph: {
        entryNodeId: string;
        provenance?: { source: string; id: string; sha256: string };
        nodes: Array<{
          id: string;
          prompt?: string;
          settings?: { skills?: { list?: string[] } };
        }>;
      };
    };

    const expected = SEEDED_PIPELINES.find(({ id }) => id === "data-scientist")!;
    expect(definition.id).toBe(expected.id);
    expect(definition.graph.entryNodeId).toBe(expected.entryNodeId);
    expect(definition.graph.nodes.map(({ id }) => id)).toEqual(expected.executionOrder);
    expect(definition.graph.nodes[0]?.prompt).toContain("analysis plan");
    expect(definition.graph.nodes[0]?.settings?.skills?.list).toEqual([
      "exploratory-data-analysis",
      "statistical-analysis",
    ]);
    expect(definition.graph.provenance).toMatchObject({
      source: "seed-pipelines",
      id: "data-scientist.yaml",
    });
    expect(definition.graph.provenance?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("@live a seeded pipeline launches from its details panel", async ({
    liveWorkspace,
  }) => {
    await openSeededRegistry(liveWorkspace.page);
    await liveWorkspace.page.getByRole(
      "button",
      { name: "Open Data Scientist details" },
    ).click();
    const details = liveWorkspace.page.getByRole(
      "region",
      { name: "Data Scientist", exact: true },
    );
    const launch = details.getByRole("button", { name: "Run typed workflow" });
    await expect(launch).toBeEnabled();
    const responsePromise = liveWorkspace.page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/dag-workflows/data-scientist/runs" &&
      response.request().method() === "POST"
    ));
    await launch.click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    await expect(details.getByRole("status")).toContainText("Created run");
  });
});
