import type { Locator, Page } from "@playwright/test";

import { expect, selectWorkspaceTab, test } from "./fixtures";
import { PRECONDITIONED_TEMPLATE_IDS, SCIENTIFIC_TEMPLATE_IDS } from "./inventory";

function preconditionAlert(details: Locator) {
  return details.getByRole("alert").filter({ hasText: /required/i });
}

async function openPipelineRegistry(page: Page) {
  await selectWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
}

async function createFromTemplate(page: Page, templateId: string) {
  await openPipelineRegistry(page);
  await page.getByRole("button", { name: "New typed workflow" }).click();
  await page.getByLabel("Workflow template").selectOption(templateId);
  await expect(page.getByLabel("New workflow id")).toHaveValue(templateId);
  const workflowNameInput = page.getByLabel("New workflow name");
  await expect(workflowNameInput).not.toHaveValue("");
  const workflowName = await workflowNameInput.inputValue();
  await page.getByRole("button", { name: "Create and open" }).click();
  const details = page.getByRole("region", { name: workflowName, exact: true });
  await expect(details).toBeVisible();
  await expect(details.getByTestId("raw-typed-definition")).toBeVisible();
  return details;
}

test.describe("scientific template creation", () => {
  for (const templateId of SCIENTIFIC_TEMPLATE_IDS) {
    test(`${templateId} creates a stored typed definition`, async ({ workspacePage }) => {
      await createFromTemplate(workspacePage, templateId);
      await expect(workspacePage.getByTestId("raw-typed-definition")).toContainText(`"id": "${templateId}"`);
    });
  }
});

test.describe("scientific template preconditions", () => {
  for (const templateId of PRECONDITIONED_TEMPLATE_IDS) {
    test(`${templateId} blocks launch while declared inputs or files are missing`, async ({ workspacePage }) => {
      const details = await createFromTemplate(workspacePage, templateId);
      await expect(preconditionAlert(details)).toBeVisible();
      await expect(details.getByRole("button", { name: "Run typed workflow" })).toBeDisabled();
    });
  }

  test("missing declared variable names the blocking input", async ({ workspacePage }) => {
    const details = await createFromTemplate(workspacePage, "stock-market-analysis");
    await details.getByLabel("Typed workflow run goal").fill("Analyze the selected security");
    await expect(preconditionAlert(details)).toContainText("Stock ticker symbol");
  });

  test("missing declared file names the blocking upload", async ({ workspacePage }) => {
    const details = await createFromTemplate(workspacePage, "portfolio-optimization");
    await details.getByLabel("Typed workflow run goal").fill("Plan a bounded portfolio analysis");
    await expect(preconditionAlert(details)).toContainText("Uploaded asset returns data");
  });
});

test.describe("deduplicated workflow registry", () => {
  test("matching typed and vendored topology has one row", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    const registry = workspacePage.getByRole("list", { name: "Scientific pipeline workflows" });
    await expect(registry.getByText("E2E Workflow", { exact: true })).toHaveCount(1);
  });

  for (const badge of ["Typed", "Vendored"] as const) {
    test(`the merged row exposes its ${badge} engine badge`, async ({ workspacePage }) => {
      await openPipelineRegistry(workspacePage);
      await expect(workspacePage.getByText(badge, { exact: true })).toBeVisible();
    });
  }

  for (const action of ["Open E2E Workflow details", "Edit E2E Workflow with vendored engine", "Run E2E Workflow with vendored engine"] as const) {
    test(`${action} is routed explicitly`, async ({ workspacePage }) => {
      await openPipelineRegistry(workspacePage);
      await expect(workspacePage.getByRole("button", { name: action })).toBeEnabled();
    });
  }

  test("vendored engine health is visible", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await expect(workspacePage.getByText("vendored engine online")).toBeVisible();
  });

  test("refresh preserves the single merged row", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Refresh" }).click();
    await expect(workspacePage.getByText("E2E Workflow", { exact: true })).toHaveCount(1);
  });

  test("typed details expose the complete stored definition", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Open E2E Workflow details" }).click();
    await expect(workspacePage.getByRole("heading", { name: "Complete stored definition (read-only)" })).toBeVisible();
  });

  test("vendored run returns its dispatch receipt", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Run E2E Workflow with vendored engine" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("engine-run-e2e");
  });
});
