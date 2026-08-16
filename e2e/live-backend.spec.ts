import { randomUUID } from "node:crypto";

import type { TestInfo } from "@playwright/test";

import {
  expect,
  selectLiveWorkspaceTab,
  test,
  type LiveWorkspace,
} from "./live-fixtures";
import { e2eServiceOrigin } from "./service-origins";

interface StoredWorkflow {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  graphSha256: string;
  graph: {
    id: string;
    name: string;
    nodes: unknown[];
    edges: unknown[];
  };
}

interface WorkflowSummary {
  id: string;
  revision: number;
  createdAt: number;
  graphSha256: string;
  nodeCount: number;
  edgeCount: number;
}

function uniqueWorkflow(testInfo: TestInfo): { id: string; name: string } {
  const nonce = `${Date.now().toString(36)}-${testInfo.workerIndex}-${randomUUID().slice(0, 8)}`;
  return { id: `c3-live-${nonce}`, name: `C3 Live ${nonce}` };
}

async function createTemplateWorkflow(
  workspace: LiveWorkspace,
  testInfo: TestInfo,
): Promise<{
  created: StoredWorkflow;
  firstPutStatus: number;
  firstPutUrl: string;
  startedAt: number;
  finishedAt: number;
}> {
  const { page } = workspace;
  const workflow = uniqueWorkflow(testInfo);
  await selectLiveWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
  await page.getByRole("button", { name: "New typed workflow" }).click();
  await page.getByLabel("Workflow template").selectOption("ml-model-selection-review");
  await page.getByLabel("New workflow id").fill(workflow.id);
  await page.getByLabel("New workflow name").fill(workflow.name);

  const firstPutPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/dag-workflows/${workflow.id}` &&
      response.request().method() === "PUT";
  });
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Create and open" }).click();
  const firstPutResponse = await firstPutPromise;
  const finishedAt = Date.now();
  const created = await firstPutResponse.json() as StoredWorkflow;
  const observedProjectId = await firstPutResponse.request().headerValue("X-Project-Id");
  expect(
    firstPutResponse.status(),
    `Initial PUT ${firstPutResponse.url()} returned ${firstPutResponse.status()} with ${JSON.stringify(created)}.`,
  ).toBe(201);
  expect(created.id).toBe(workflow.id);
  expect(created.graph.id).toBe(workflow.id);
  expect(created.graph.name).toBe(workflow.name);
  expect(
    observedProjectId,
    `Initial PUT carried X-Project-Id=${String(observedProjectId)}; expected ${workspace.project.id}.`,
  ).toBe(workspace.project.id);
  await expect(page.getByRole("region", { name: workflow.name, exact: true })).toBeVisible();
  return {
    created,
    firstPutStatus: firstPutResponse.status(),
    firstPutUrl: firstPutResponse.url(),
    startedAt,
    finishedAt,
  };
}

test("@live creates a template workflow and renders API-exact details", async ({
  liveWorkspace,
}, testInfo) => {
  const { page, projectsResponseUrl } = liveWorkspace;
  expect(
    new URL(projectsResponseUrl).origin,
    `The browser loaded projects from ${projectsResponseUrl}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));

  const creation = await createTemplateWorkflow(liveWorkspace, testInfo);
  const listResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/dag-workflows" && response.request().method() === "GET";
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  const listResponse = await listResponsePromise;
  const listBody = await listResponse.json() as { workflows: WorkflowSummary[] };
  expect(
    listResponse.status(),
    `GET ${listResponse.url()} returned ${listResponse.status()} with ${JSON.stringify(listBody)}.`,
  ).toBe(200);
  expect(new URL(listResponse.url()).origin).toBe(e2eServiceOrigin("backend"));
  const summary = listBody.workflows.find((workflow) => workflow.id === creation.created.id);
  expect(
    summary,
    `GET /dag-workflows did not contain ${creation.created.id}; observed ids: ${listBody.workflows.map(({ id }) => id).join(", ")}.`,
  ).toBeDefined();
  expect(summary!.revision, `Observed workflow summary: ${JSON.stringify(summary)}.`).toBe(1);
  expect(summary!.graphSha256, `Observed workflow summary: ${JSON.stringify(summary)}.`)
    .toMatch(/^[0-9a-f]{64}$/);
  expect(
    summary!.createdAt,
    `createdAt ${summary!.createdAt} must be within [${creation.startedAt}, ${creation.finishedAt}].`,
  ).toBeGreaterThanOrEqual(creation.startedAt);
  expect(
    summary!.createdAt,
    `createdAt ${summary!.createdAt} must be within [${creation.startedAt}, ${creation.finishedAt}].`,
  ).toBeLessThanOrEqual(creation.finishedAt);
  expect(summary).toMatchObject({
    id: creation.created.id,
    revision: creation.created.revision,
    createdAt: creation.created.createdAt,
    graphSha256: creation.created.graphSha256,
    nodeCount: creation.created.graph.nodes.length,
    edgeCount: creation.created.graph.edges.length,
  });

  const details = page.getByRole("region", { name: creation.created.graph.name, exact: true });
  // dag-workflows-panel.tsx:860-866 selects the definition after creation, while
  // refreshRegistry at lines 707-716 clears that selection before refetching.
  const closeDetails = page.getByRole("button", { name: "Close details" });
  if (await closeDetails.isVisible()) await closeDetails.click();
  const openDetails = page.getByRole("button", {
    name: `Open ${creation.created.graph.name} details`,
  });
  await expect(openDetails).toBeVisible();
  await openDetails.click();
  await expect(details).toBeVisible();
  await expect(details).toContainText(
    `${creation.created.id} · revision ${summary!.revision} · ${summary!.nodeCount} nodes · ${summary!.edgeCount} edges`,
  );
  const renderedDefinition = JSON.parse(
    await details.getByTestId("raw-typed-definition").innerText(),
  ) as StoredWorkflow;
  expect(renderedDefinition.revision).toBe(summary!.revision);
  expect(renderedDefinition.graph.nodes).toHaveLength(summary!.nodeCount);
  expect(renderedDefinition.graph.edges).toHaveLength(summary!.edgeCount);
  console.log(
    `LIVE_VALUES workflow=${summary!.id} revision=${summary!.revision} createdAt=${summary!.createdAt} ` +
      `graphSha256=${summary!.graphSha256} nodes=${summary!.nodeCount} edges=${summary!.edgeCount}`,
  );
});

test("@live identical workflow PUT is a no-op: same 201 for revision 1, unchanged record", async ({
  liveWorkspace,
}, testInfo) => {
  const creation = await createTemplateWorkflow(liveWorkspace, testInfo);
  const repeated = await liveWorkspace.page.evaluate(async ({ url, graph, projectId }) => {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Id": projectId,
      },
      body: JSON.stringify(graph),
    });
    return {
      status: response.status,
      body: await response.json() as StoredWorkflow,
    };
  }, {
    url: creation.firstPutUrl,
    graph: creation.created.graph,
    projectId: liveWorkspace.project.id,
  });

  expect(creation.firstPutStatus).toBe(201);
  // The route currently derives status from stored revision, so an unchanged
  // revision-1 record remains 201. A 200 no-op status is server-owned backlog N-09.
  expect(
    repeated.status,
    `Identical PUT observed status=${repeated.status}, revision=${repeated.body.revision}, ` +
      `createdAt=${repeated.body.createdAt}, graphSha256=${repeated.body.graphSha256}.`,
  ).toBe(201);
  expect(repeated.body).toMatchObject({
    id: creation.created.id,
    revision: creation.created.revision,
    createdAt: creation.created.createdAt,
    updatedAt: creation.created.updatedAt,
    graphSha256: creation.created.graphSha256,
  });
  expect(
    repeated.body,
    `Identical PUT must return the unchanged stored record; first=${JSON.stringify(creation.created)}, ` +
      `repeated=${JSON.stringify(repeated.body)}.`,
  ).toEqual(creation.created);
});

test("@live creates and validates a provider-free graph against the real engine", async ({
  liveWorkspace,
}, testInfo) => {
  const { page } = liveWorkspace;
  const workflow = uniqueWorkflow(testInfo);
  await selectLiveWorkspaceTab(page, "Builder");
  const iframe = page.getByTitle("DAG Builder");
  await expect(iframe).toBeVisible();
  const iframeSource = await iframe.getAttribute("src");
  expect(iframeSource, "The Builder iframe must expose a browser-resolvable source URL.").not.toBeNull();
  expect(
    new URL(iframeSource!, page.url()).origin,
    `Builder iframe resolved to ${iframeSource}; expected the configured engine origin.`,
  ).toBe(e2eServiceOrigin("engine"));

  const frame = page.frameLocator('iframe[title="DAG Builder"]');
  const workflowName = frame.getByPlaceholder("workflow-name");
  await expect(workflowName).toBeVisible();
  await workflowName.fill(workflow.name);
  await frame.getByTitle("Add description").click();
  await frame.getByPlaceholder("Description...").fill(
    "Provider-free live validation contract.",
  );
  const canvas = frame.locator(".react-flow");
  await expect(canvas).toBeVisible();
  await canvas.dblclick({ position: { x: 640, y: 360 } });
  await frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ }).click();
  const prompt = frame.getByPlaceholder("Enter inline prompt...");
  await prompt.fill("Validate this bounded provider-free graph without executing it.");

  const validationResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/workflows/validate" && response.request().method() === "POST";
  });
  await frame.getByRole("button", { name: "Validate", exact: true }).click();
  const validationResponse = await validationResponsePromise;
  const validation = await validationResponse.json() as { valid: boolean; errors?: string[] };
  expect(new URL(validationResponse.url()).origin).toBe(e2eServiceOrigin("engine"));
  expect(
    validationResponse.status(),
    `Engine validation returned ${validationResponse.status()} with ${JSON.stringify(validation)}.`,
  ).toBe(200);
  expect(validation, `Engine validation observed ${JSON.stringify(validation)}.`).toEqual({ valid: true });
  await expect(frame.getByText("Problems", { exact: true })).toBeVisible();
  await expect(frame.getByText("No issues found", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Valid", exact: true })).toBeVisible();
  await expect(frame.getByText("1 nodes · 0 edges", { exact: true })).toBeVisible();
});
