import { randomUUID } from "node:crypto";

import type { TestInfo } from "@playwright/test";

import {
  expect,
  selectLiveWorkspaceTab,
  test,
  type LiveWorkspace,
} from "./live-fixtures";
import { e2eServiceOrigin } from "./service-origins";
import { readMlModelSelectionTemplateSignature } from "./template-source";

interface StoredWorkflow {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  graphSha256: string;
  graph: {
    id: string;
    name: string;
    nodes: Array<{ id: string; kind: string }>;
    edges: Array<{ id: string; from: string; to: string; condition?: string }>;
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

/**
 * The definition PUT returns an envelope, not a bare record: the store's
 * compare-and-set outcome plus the definition it settled on
 * (server/src/api/dag-workflows.ts:414-421).
 */
interface SavedWorkflowEnvelope {
  outcome: "created" | "unchanged" | "updated";
  definition: StoredWorkflow;
}

/** A PUT observed from inside the browser, including its conditional result. */
interface ObservedDefinitionWrite {
  status: number;
  url: string;
  etag: string | null;
  body: unknown;
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
  firstPutOutcome: SavedWorkflowEnvelope["outcome"];
  firstPutETag: string | undefined;
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
  const envelope = await firstPutResponse.json() as SavedWorkflowEnvelope;
  const created = envelope.definition;
  const observedProjectId = await firstPutResponse.request().headerValue("X-Project-Id");
  const firstPutETag = firstPutResponse.headers().etag;
  // The panel's create form declares its intent explicitly; the server refuses a
  // definition write that carries no conditional header at all.
  const observedCreatePrecondition = await firstPutResponse.request()
    .headerValue("If-None-Match");
  expect(
    observedCreatePrecondition,
    `Initial PUT carried If-None-Match=${String(observedCreatePrecondition)}; expected the create precondition \`*\`.`,
  ).toBe("*");
  expect(
    await firstPutResponse.request().headerValue("If-Match"),
    "A create must not also carry an If-Match update precondition.",
  ).toBeNull();
  expect(
    firstPutResponse.status(),
    `Initial PUT ${firstPutResponse.url()} returned ${firstPutResponse.status()} with ${JSON.stringify(envelope)}.`,
  ).toBe(201);
  expect(
    envelope.outcome,
    `Initial PUT ${firstPutResponse.url()} returned outcome=${String(envelope.outcome)} with ${JSON.stringify(envelope)}.`,
  ).toBe("created");
  expect(
    firstPutETag,
    `Initial PUT returned ETag=${String(firstPutETag)}; expected the created revision tag "1".`,
  ).toBe('"1"');
  expect(
    created.revision,
    `Initial PUT stored revision ${created.revision}; expected 1 for a create.`,
  ).toBe(1);
  expect(
    new URL(firstPutResponse.url()).origin,
    `Initial PUT resolved to ${firstPutResponse.url()}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
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
    firstPutOutcome: envelope.outcome,
    firstPutETag,
    firstPutUrl: firstPutResponse.url(),
    startedAt,
    finishedAt,
  };
}

test("@live @live-alt creates a template workflow and renders API-exact details", async ({
  liveWorkspace,
}, testInfo) => {
  const { page, projectsResponseUrl } = liveWorkspace;
  expect(
    new URL(projectsResponseUrl).origin,
    `The browser loaded projects from ${projectsResponseUrl}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));

  const creation = await createTemplateWorkflow(liveWorkspace, testInfo);
  const expectedTemplate = readMlModelSelectionTemplateSignature();
  expect(creation.created.graph.nodes.map(({ id, kind }) => ({ id, kind }))).toEqual(
    expectedTemplate.nodes,
  );
  expect(creation.created.graph.edges.map(({ id, from, to, condition }) => ({
    id,
    from,
    to,
    condition,
  }))).toEqual(expectedTemplate.edges);
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
  expect(
    new URL(listResponse.url()).origin,
    `List GET resolved to ${listResponse.url()}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
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
    nodeCount: expectedTemplate.nodes.length,
    edgeCount: expectedTemplate.edges.length,
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
  const detailResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/dag-workflows/${creation.created.id}` &&
    response.request().method() === "GET"
  ));
  await openDetails.click();
  const detailResponse = await detailResponsePromise;
  const detailRecord = await detailResponse.json() as StoredWorkflow;
  expect(detailResponse.status()).toBe(200);
  expect(
    new URL(detailResponse.url()).origin,
    `Detail GET resolved to ${detailResponse.url()}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
  expect(
    detailRecord,
    `Detail GET must equal the created record; created=${JSON.stringify(creation.created)}, ` +
      `detail=${JSON.stringify(detailRecord)}.`,
  ).toEqual(creation.created);
  await expect(details).toBeVisible();
  await expect(details).toContainText(
    `${creation.created.id} · revision ${summary!.revision} · ${summary!.nodeCount} nodes · ${summary!.edgeCount} edges`,
  );
  const renderedDefinition = JSON.parse(
    await details.getByTestId("raw-typed-definition").innerText(),
  ) as StoredWorkflow;
  expect(renderedDefinition).toEqual(detailRecord);
  console.log(
    `LIVE_VALUES workflow=${summary!.id} revision=${summary!.revision} createdAt=${summary!.createdAt} ` +
      `graphSha256=${summary!.graphSha256} nodes=${summary!.nodeCount} edges=${summary!.edgeCount}`,
  );
});

test("@live @live-alt definition compare-and-set matrix: unchanged no-op, update, conflicting create, missing and malformed preconditions", async ({
  liveWorkspace,
}, testInfo) => {
  const creation = await createTemplateWorkflow(liveWorkspace, testInfo);
  expect(creation.firstPutStatus).toBe(201);
  expect(creation.firstPutOutcome).toBe("created");
  expect(creation.firstPutETag).toBe('"1"');

  // Every case below is deliberately non-mutating, so the independent GET that
  // follows them proves the stored record survived the whole group untouched.
  // Each refusal is also a browser console error, so it is declared up front;
  // the fixture still fails on anything else the page reports.
  for (const refusedStatus of [409, 428, 400, 400, 400, 400]) {
    liveWorkspace.expectRefusedResourceStatus(refusedStatus);
  }
  const preconditions = await liveWorkspace.page.evaluate(async (
    { url, graph, projectId },
  ) => {
    const put = async (conditional: Record<string, string>) => {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Project-Id": projectId,
          ...conditional,
        },
        body: JSON.stringify(graph),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // A non-JSON body is reported verbatim so the failure names what arrived.
      }
      return {
        status: response.status,
        url: response.url,
        etag: response.headers.get("ETag"),
        body,
      };
    };
    return {
      identicalUpdate: await put({ "If-Match": '"1"' }),
      repeatCreate: await put({ "If-None-Match": "*" }),
      missingPrecondition: await put({}),
      bothPreconditions: await put({ "If-None-Match": "*", "If-Match": '"1"' }),
      malformedBareIfMatch: await put({ "If-Match": "1" }),
      malformedWeakIfMatch: await put({ "If-Match": 'W/"1"' }),
      malformedWildcardIfNoneMatch: await put({ "If-None-Match": '"1"' }),
    };
  }, {
    url: creation.firstPutUrl,
    graph: creation.created.graph,
    projectId: liveWorkspace.project.id,
  });

  const describeWrite = (label: string, observed: ObservedDefinitionWrite) =>
    `${label} observed status=${observed.status}, ETag=${String(observed.etag)}, ` +
    `body=${JSON.stringify(observed.body)}.`;
  for (const [label, observed] of Object.entries(preconditions)) {
    expect(
      new URL(observed.url).origin,
      `${label} PUT resolved to ${observed.url}; expected the configured backend origin.`,
    ).toBe(e2eServiceOrigin("backend"));
  }

  // An identical body under the revision-1 update precondition is the no-op:
  // 200 `unchanged`, the revision does not advance, and the record is byte-equal.
  expect(
    preconditions.identicalUpdate.status,
    describeWrite("Identical update", preconditions.identicalUpdate),
  ).toBe(200);
  expect(
    preconditions.identicalUpdate.etag,
    describeWrite("Identical update", preconditions.identicalUpdate),
  ).toBe('"1"');
  const identical = preconditions.identicalUpdate.body as SavedWorkflowEnvelope;
  expect(
    identical.outcome,
    describeWrite("Identical update", preconditions.identicalUpdate),
  ).toBe("unchanged");
  expect(
    identical.definition.revision,
    describeWrite("Identical update", preconditions.identicalUpdate),
  ).toBe(1);
  expect(
    identical.definition,
    `Identical update must return the unchanged stored record; first=${JSON.stringify(creation.created)}, ` +
      `repeated=${JSON.stringify(identical.definition)}.`,
  ).toEqual(creation.created);

  // A create precondition against an existing definition conflicts, and the
  // conflict names the revision the server compared against.
  expect(
    preconditions.repeatCreate.status,
    describeWrite("Repeated create", preconditions.repeatCreate),
  ).toBe(409);
  expect(
    preconditions.repeatCreate.etag,
    describeWrite("Repeated create", preconditions.repeatCreate),
  ).toBe('"1"');

  // No conditional header at all is 428, with no ETag to mistake for a state.
  expect(
    preconditions.missingPrecondition.status,
    describeWrite("Precondition-less PUT", preconditions.missingPrecondition),
  ).toBe(428);
  expect(
    preconditions.missingPrecondition.etag,
    describeWrite("Precondition-less PUT", preconditions.missingPrecondition),
  ).toBeNull();

  // Both intents at once, and every malformed entity-tag form, are 400.
  for (const label of [
    "bothPreconditions",
    "malformedBareIfMatch",
    "malformedWeakIfMatch",
    "malformedWildcardIfNoneMatch",
  ] as const) {
    expect(preconditions[label].status, describeWrite(label, preconditions[label])).toBe(400);
  }

  const persisted = await liveWorkspace.page.evaluate(async ({ url, projectId }) => {
    const response = await fetch(url, { headers: { "X-Project-Id": projectId } });
    return {
      status: response.status,
      url: response.url,
      etag: response.headers.get("ETag"),
      body: await response.json() as StoredWorkflow,
    };
  }, {
    url: creation.firstPutUrl,
    projectId: liveWorkspace.project.id,
  });
  expect(persisted.status).toBe(200);
  expect(
    new URL(persisted.url).origin,
    `Independent GET resolved to ${persisted.url}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
  expect(persisted.etag, `Independent GET returned ETag=${String(persisted.etag)}.`).toBe('"1"');
  expect(
    persisted.body,
    `Independent GET after the no-op and refused writes must remain unchanged; ` +
      `first=${JSON.stringify(creation.created)}, persisted=${JSON.stringify(persisted.body)}.`,
  ).toEqual(creation.created);
  expect(persisted.body.graph.nodes.map(({ id, kind }) => ({ id, kind }))).toEqual(
    creation.created.graph.nodes.map(({ id, kind }) => ({ id, kind })),
  );
  expect(persisted.body.graph.edges.map(({ id, from, to }) => ({ id, from, to }))).toEqual(
    creation.created.graph.edges.map(({ id, from, to }) => ({ id, from, to })),
  );

  // Only a changed body under the same revision-1 precondition advances the
  // definition, which is what separates the no-op above from a real update.
  const changedGraph = {
    ...creation.created.graph,
    name: `${creation.created.graph.name} revised`,
  };
  const updated = await liveWorkspace.page.evaluate(async ({ url, graph, projectId }) => {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Id": projectId,
        "If-Match": '"1"',
      },
      body: JSON.stringify(graph),
    });
    return {
      status: response.status,
      url: response.url,
      etag: response.headers.get("ETag"),
      body: await response.json() as SavedWorkflowEnvelope,
    };
  }, {
    url: creation.firstPutUrl,
    graph: changedGraph,
    projectId: liveWorkspace.project.id,
  });
  const describeUpdate = `Changed update observed status=${updated.status}, ` +
    `ETag=${String(updated.etag)}, body=${JSON.stringify(updated.body)}.`;
  expect(updated.status, describeUpdate).toBe(200);
  expect(updated.etag, describeUpdate).toBe('"2"');
  expect(
    new URL(updated.url).origin,
    `Changed update resolved to ${updated.url}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
  expect(updated.body.outcome, describeUpdate).toBe("updated");
  expect(updated.body.definition.revision, describeUpdate).toBe(2);
  expect(updated.body.definition.graph.name, describeUpdate).toBe(changedGraph.name);
  expect(
    updated.body.definition.createdAt,
    `An update must preserve createdAt; first=${creation.created.createdAt}, ` +
      `updated=${updated.body.definition.createdAt}.`,
  ).toBe(creation.created.createdAt);
  expect(
    updated.body.definition.graphSha256,
    `A changed graph must change graphSha256; first=${creation.created.graphSha256}, ` +
      `updated=${updated.body.definition.graphSha256}.`,
  ).not.toBe(creation.created.graphSha256);
});

test("@live @live-alt rejects an invalid graph then validates the exact provider-free graph", async ({
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
  const workflowDescription = "Provider-free live validation contract.";
  await frame.getByPlaceholder("Description...").fill(workflowDescription);

  const invalidRequestBody = {
    definition: {
      name: workflow.name,
      description: workflowDescription,
      nodes: [{
        id: "consumer",
        prompt: "Consume the missing result.",
        depends_on: ["missing-node"],
      }],
    },
  };
  const invalidResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/workflows/validate" && response.request().method() === "POST";
  });
  const invalidResult = await frame.locator("body").evaluate(async (_body, requestBody) => {
    const response = await fetch("/api/workflows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return {
      status: response.status,
      body: await response.json() as { valid: boolean; errors?: string[] },
    };
  }, invalidRequestBody);
  const invalidResponse = await invalidResponsePromise;
  expect(
    new URL(invalidResponse.url()).origin,
    `Invalid validation resolved to ${invalidResponse.url()}; expected the configured engine origin.`,
  ).toBe(e2eServiceOrigin("engine"));
  expect(invalidResponse.request().postDataJSON()).toEqual(invalidRequestBody);
  expect(invalidResult.status).toBe(200);
  expect(invalidResult.body).toEqual({
    valid: false,
    errors: ["Node 'consumer' depends_on unknown node 'missing-node'"],
  });

  const canvas = frame.locator(".react-flow");
  await expect(canvas).toBeVisible();
  await canvas.dblclick({ position: { x: 640, y: 360 } });
  await frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ }).click();
  const prompt = frame.getByPlaceholder("Enter inline prompt...");
  const promptText = "Validate this bounded provider-free graph without executing it.";
  await prompt.fill(promptText);
  const promptNodeId = await frame.locator(".react-flow__node").getAttribute("data-id");
  expect(promptNodeId, "The valid Builder request requires the rendered prompt-node id.").not.toBeNull();
  const validRequestBody = {
    definition: {
      name: workflow.name,
      description: workflowDescription,
      nodes: [{ id: promptNodeId!, prompt: promptText }],
    },
  };

  const validationResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/workflows/validate" && response.request().method() === "POST";
  });
  await frame.getByRole("button", { name: "Validate", exact: true }).click();
  const validationResponse = await validationResponsePromise;
  const validation = await validationResponse.json() as { valid: boolean; errors?: string[] };
  expect(
    new URL(validationResponse.url()).origin,
    `Valid validation resolved to ${validationResponse.url()}; expected the configured engine origin.`,
  ).toBe(e2eServiceOrigin("engine"));
  expect(validationResponse.request().postDataJSON()).toEqual(validRequestBody);
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
