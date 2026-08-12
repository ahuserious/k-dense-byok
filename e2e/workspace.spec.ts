import {
  createTypedWorkflowFromTemplate,
  expect,
  selectWorkspaceTab,
  test,
} from "./fixtures";
import { SCIENTIFIC_TEMPLATES, WORKSPACE_TABS } from "./inventory";

test.describe("workspace navigation consequences", () => {
  for (const tabName of WORKSPACE_TABS) {
    test(`${tabName} becomes the current workspace surface`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, tabName);
      const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
      await expect(navigation.getByRole("button", { name: tabName, exact: true }))
        .toHaveAttribute("aria-current", "page");
    });
  }

  test("retired workspace labels stay absent from navigation", async ({ workspacePage }) => {
    const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
    for (const retiredLabel of [
      "Archon",
      "DAG Workflows",
      "DAG Pipelines",
      "Typed builder",
      "DAG Builder agent",
    ] as const) {
      await expect(navigation).not.toContainText(retiredLabel);
    }
  });
});

test.describe("scientific skill catalogue", () => {
  test("renders the renamed skill without the retired Archon name", async ({ workspacePage }) => {
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Skills" }).click();
    await expect(settings.getByText("scientific-dag-studio", { exact: true })).toBeVisible();
    await expect(settings).not.toContainText(/archon/i);
  });
});

test.describe("scientific template structure and close control", () => {
  for (const template of SCIENTIFIC_TEMPLATES) {
    test(`${template.id} creates its own graph and Close details returns to the registry`, async ({
      workspacePage,
    }) => {
      const { details, rawDefinition, workflowName } = await createTypedWorkflowFromTemplate(
        workspacePage,
        template.id,
      );
      expect(workflowName).toBe(template.name);

      const rawText = await rawDefinition.textContent();
      expect(rawText).not.toBeNull();
      const definition = JSON.parse(rawText ?? "") as {
        id: string;
        graph: {
          id: string;
          name: string;
          nodes: Array<{ kind: string; name?: string; goal?: string; prompt?: string }>;
        };
      };
      expect(definition.id).toBe(template.id);
      expect(definition.graph.id).toBe(template.id);
      expect(definition.graph.name).toBe(template.name);
      expect(definition.graph.nodes.map((node) => node.kind)).toEqual(template.nodeKinds);
      expect(JSON.stringify(definition.graph.nodes)).toContain(template.nodeText);

      await details.getByRole("button", { name: "Close details" }).click();
      await expect(details).toBeHidden();
      await expect(workspacePage.getByRole("list", { name: "Scientific pipeline workflows" }))
        .toBeVisible();
    });
  }
});

test.describe("thin inventory smoke — excluded from the substantive count", () => {
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
