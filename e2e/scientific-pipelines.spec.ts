import {
  WORKFLOW_RUN_ID,
  createTypedWorkflowFromTemplate,
  expect,
  requestCount,
  selectWorkspaceTab,
  test,
} from "./fixtures";
import { SCIENTIFIC_TEMPLATES } from "./inventory";

async function openPipelineRegistry(page: Parameters<typeof selectWorkspaceTab>[0]) {
  await selectWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
}

test.describe("scientific template launch controls", () => {
  for (const template of SCIENTIFIC_TEMPLATES) {
    test(`${template.id} enforces its declared launch contract`, async ({ workspacePage, apiState }) => {
      const { details } = await createTypedWorkflowFromTemplate(workspacePage, template.id);
      const launch = details.getByRole("button", { name: "Run typed workflow" });
      const launchPath = `/dag-workflows/${template.id}/runs`;

      if (template.blockingMessages.length > 0) {
        const alert = details.getByRole("alert");
        await expect(alert).toBeVisible();
        for (const message of template.blockingMessages) {
          await expect(alert).toContainText(message);
        }
        await expect(launch).toBeDisabled();
        await expect(launch).toHaveAttribute(
          "title",
          "Complete the required workflow inputs before launch",
        );
        expect(requestCount(apiState, "POST", launchPath)).toBe(0);
        return;
      }

      await expect(launch).toBeEnabled();
      const launchResponsePromise = workspacePage.waitForResponse((response) => (
        new URL(response.url()).pathname === launchPath &&
        response.request().method() === "POST"
      ));
      await launch.click();
      const launchResponse = await launchResponsePromise;
      expect(launchResponse.status()).toBe(201);
      const launchedRun = await launchResponse.json() as {
        manifest?: { graph?: { id?: string }; workflowId?: string };
      };
      expect(launchedRun.manifest?.workflowId).toBe(template.id);
      expect(launchedRun.manifest?.graph?.id).toBe(template.id);
      expect(requestCount(apiState, "POST", launchPath)).toBe(1);
      await expect(details.getByRole("status")).toHaveText(
        `Created run ${WORKFLOW_RUN_ID} with status queued. Open Console for runner progress.`,
      );
    });
  }
});

test.describe("scientific template topology returned by the workflow API", () => {
  for (const template of SCIENTIFIC_TEMPLATES) {
    test(`${template.id} returns a bounded sequential topology`, async ({ workspacePage }) => {
      const { rawDefinition } = await createTypedWorkflowFromTemplate(workspacePage, template.id);
      const rawText = await rawDefinition.textContent();
      expect(rawText).not.toBeNull();
      const definition = JSON.parse(rawText ?? "") as {
        id: string;
        graph: {
          entryNodeId: string;
          evidence: { enabled: boolean };
          rescue: { enabled: boolean; maxAttempts: number };
          nodes: Array<{ id: string; kind: string }>;
          edges: Array<{ condition: string; from: string; to: string }>;
        };
      };
      const { graph } = definition;
      expect(definition.id).toBe(template.id);
      expect(graph.nodes.map((node) => node.kind)).toEqual(template.nodeKinds);
      expect(graph.entryNodeId).toBe(graph.nodes[0]?.id);
      expect(graph.edges).toHaveLength(graph.nodes.length - 1);
      expect(graph.edges.map(({ condition, from, to }) => ({ condition, from, to }))).toEqual(
        graph.nodes.slice(0, -1).map((node, index) => ({
          condition: "always",
          from: node.id,
          to: graph.nodes[index + 1]?.id,
        })),
      );
      expect(graph.evidence.enabled).toBe(false);
      expect(graph.rescue).toMatchObject({ enabled: true, maxAttempts: 2 });
    });
  }
});

test.describe("deduplicated workflow registry actions", () => {
  test("matching typed and vendored topology has one row with both engine identities", async ({
    workspacePage,
    apiState,
  }) => {
    await openPipelineRegistry(workspacePage);
    const registry = workspacePage.getByRole("list", { name: "Scientific pipeline workflows" });
    await expect.poll(() => requestCount(apiState, "GET", "/pipelines")).toBeGreaterThan(0);
    await expect.poll(() => requestCount(apiState, "GET", "/dag-workflows")).toBeGreaterThan(0);
    const mergedRow = registry.getByRole("listitem").filter({ hasText: "E2E Workflow" });
    await expect(mergedRow).toHaveCount(1);
    await expect(mergedRow.getByText("Typed", { exact: true })).toBeVisible();
    await expect(mergedRow.getByText("Vendored", { exact: true })).toBeVisible();
  });

  test("failed topology verification keeps both engine entries and explains why", async ({
    workspacePage,
    apiState,
  }) => {
    apiState.failTypedDefinitionRead = true;
    await openPipelineRegistry(workspacePage);
    const registryRegion = workspacePage.getByRole("region", { name: "Workflow registry" });
    const registry = registryRegion.getByRole("list", { name: "Scientific pipeline workflows" });
    await expect(registry.getByRole("listitem")).toHaveCount(2);
    await expect(registryRegion.getByRole("alert")).toHaveText(
      "Could not verify structure for E2E Workflow; its engine entries remain separate.",
    );
  });

  test("Refresh refetches both engines and renders changed registry data", async ({
    workspacePage,
    apiState,
  }) => {
    await openPipelineRegistry(workspacePage);
    await expect(workspacePage.getByText("Refreshed deterministic E2E workflow")).toHaveCount(0);
    const typedRequestsBefore = requestCount(apiState, "GET", "/dag-workflows");
    const vendoredRequestsBefore = requestCount(apiState, "GET", "/pipelines");
    apiState.showRefreshedRegistryData = true;
    await workspacePage.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => requestCount(apiState, "GET", "/dag-workflows"))
      .toBeGreaterThan(typedRequestsBefore);
    await expect.poll(() => requestCount(apiState, "GET", "/pipelines"))
      .toBeGreaterThan(vendoredRequestsBefore);
    await expect(workspacePage.getByText("E2E Workflow", { exact: true })).toHaveCount(1);
    await expect(workspacePage.getByText("Refreshed deterministic E2E workflow")).toBeVisible();
  });

  test("Open details reveals the complete typed definition", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Open E2E Workflow details" }).click();
    await expect(workspacePage.getByRole("heading", { name: "Complete stored definition (read-only)" }))
      .toBeVisible();
    await expect(workspacePage.getByTestId("raw-typed-definition")).toContainText(
      '"id": "analyze"',
    );
  });

  test("Edit routes the exact vendored workflow into Builder", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Edit E2E Workflow with vendored engine" }).click();
    const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
    await expect(navigation.getByRole("button", { name: "Builder" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(workspacePage.getByTitle("DAG Builder")).toHaveAttribute(
      "src",
      /edit=e2e-vendored&codebaseId=e2e-codebase/,
    );
  });

  test("Run dispatches through the vendored engine and renders its receipt", async ({ workspacePage }) => {
    await openPipelineRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Run E2E Workflow with vendored engine" }).click();
    await expect(workspacePage.getByRole("status")).toContainText("engine-run-e2e");
    await expect(workspacePage.getByRole("status")).toContainText("queued");
  });
});

test.describe("thin inventory smoke — excluded from the substantive count", () => {
  for (const badge of ["Typed", "Vendored"] as const) {
    test(`merged registry row exposes its ${badge} engine badge`, async ({ workspacePage }) => {
      await openPipelineRegistry(workspacePage);
      await expect(workspacePage.getByText(badge, { exact: true })).toBeVisible();
    });
  }
});
