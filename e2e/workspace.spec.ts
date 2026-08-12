import { expect, selectWorkspaceTab, test } from "./fixtures";
import { WORKFLOW_LIBRARY_ITEMS, WORKSPACE_TABS } from "./inventory";

test.describe("workspace navigation", () => {
  for (const tabName of WORKSPACE_TABS) {
    test(`${tabName} is a selectable workspace tab`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, tabName);
    });
  }

  const surfaceAssertions = [
    { tab: "Chat", placeholder: "Ask Kady anything… (@ for files, + for data / compute / skills)" },
    { tab: "Workflows", placeholder: "Search workflows..." },
    { tab: "Scientific Pipelines", role: "heading" as const, name: "Scientific Pipelines" },
    { tab: "Builder", title: "DAG Builder" },
    { tab: "Console", role: "button" as const, name: "DAG Runs" },
    { tab: "Raindrop", role: "heading" as const, name: "Raindrop" },
  ] as const;

  for (const surface of surfaceAssertions) {
    test(`${surface.tab} exposes its primary control`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, surface.tab);
      const target = "placeholder" in surface
        ? workspacePage.getByPlaceholder(surface.placeholder)
        : "title" in surface
          ? workspacePage.getByTitle(surface.title)
          : workspacePage.getByRole(surface.role, { name: new RegExp(surface.name, "i") });
      await expect(target.first()).toBeVisible();
    });
  }
});

test.describe("workflow library", () => {
  for (const workflowName of WORKFLOW_LIBRARY_ITEMS) {
    test(`${workflowName} can be found and opened`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, "Workflows");
      const search = workspacePage.getByPlaceholder("Search workflows...");
      await search.fill(workflowName);
      await workspacePage.getByRole("button", { name: new RegExp(`^${workflowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
      const dialog = workspacePage.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: workflowName })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    });
  }
});
