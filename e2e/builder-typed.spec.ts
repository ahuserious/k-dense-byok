// The typed authoring path: the Kady host feeds the builder its workflow
// sources, loads a typed document onto the vendored canvas over the
// postMessage bridge, and saves it back through the typed route with a
// conditional write.
//
// The owner's complaint was "none of the workflows have loaded". The first
// tests here are the direct regression for that: a non-empty, searchable
// source list, and a Kady typed workflow actually rendered on the canvas.

import type { Page, Request, Route } from "@playwright/test";

import { expect, selectWorkspaceTab, test } from "./fixtures";

interface TypedRequestLog {
  validated: unknown[];
  writes: Array<{ workflowId: string; ifMatch?: string; ifNoneMatch?: string; body: unknown }>;
}

const BACKEND = /^http:\/\/(?:127\.0\.0\.1|localhost):18000\//;

function backendPath(request: Request): string | null {
  const url = request.url();
  if (!BACKEND.test(url)) return null;
  return new URL(url).pathname;
}

async function routeJson(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Typed-route overrides layered on top of the shared fixture mocks.
 *
 * Registered after `workspacePage` so they take precedence: the shared fixture
 * refuses `If-Match` on a definition write (it only models a create), and has
 * no validate route at all.
 */
async function installTypedRoutes(page: Page): Promise<TypedRequestLog> {
  const log: TypedRequestLog = { validated: [], writes: [] };

  await page.route(BACKEND, async (route, request) => {
    const path = backendPath(request);
    const method = request.method();

    if (path === "/dag-workflows/validate" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { document?: unknown };
      log.validated.push(body.document);
      return routeJson(route, {
        ok: true,
        document: body.document,
        graphSha256: "e2e-validated-sha256",
        warnings: [],
      });
    }

    if (path?.startsWith("/dag-workflows/") && method === "PUT") {
      const workflowId = decodeURIComponent(path.slice("/dag-workflows/".length));
      const headers = request.headers();
      log.writes.push({
        workflowId,
        ifMatch: headers["if-match"],
        ifNoneMatch: headers["if-none-match"],
        body: JSON.parse(request.postData() ?? "null") as unknown,
      });
      const graph = JSON.parse(request.postData() ?? "{}") as { name?: string };
      return routeJson(
        route,
        {
          outcome: headers["if-none-match"] === "*" ? "created" : "updated",
          definition: {
            storageVersion: 1,
            id: workflowId,
            revision: headers["if-none-match"] === "*" ? 1 : 2,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            graphSha256: "e2e-saved-sha256",
            graph: { ...(JSON.parse(request.postData() ?? "{}") as object), name: graph.name },
          },
        },
        headers["if-none-match"] === "*" ? 201 : 200,
        { ETag: headers["if-none-match"] === "*" ? '"1"' : '"2"' },
      );
    }

    return route.fallback();
  });

  return log;
}

async function openTypedBuilder(page: Page) {
  await selectWorkspaceTab(page, "Builder");
  await expect(page.getByRole("button", { name: "Load workflow" })).toBeVisible();
  return page.frameLocator('iframe[title="DAG Builder"]');
}

/** The bridge is up once the host has heard `builder.ready` from the iframe. */
async function expectCanvasLinked(page: Page) {
  await expect(page.getByTestId("builder-bridge-status")).toHaveText("canvas linked", {
    timeout: 20_000,
  });
}

async function loadE2eWorkflow(page: Page) {
  const list = page.getByTestId("source-picker-list");
  await list.getByRole("option", { name: /E2E Workflow/ }).click();
  await expect(page.getByTestId("loaded-workflow-name")).toHaveText("E2E Workflow");
}

test.describe("typed builder source list", () => {
  test("lists the project's typed workflows instead of an empty pipeline select", async ({
    workspacePage,
  }) => {
    await openTypedBuilder(workspacePage);

    const list = workspacePage.getByTestId("source-picker-list");
    await expect(list.getByRole("option", { name: /E2E Workflow/ })).toBeVisible();
    await expect(workspacePage.getByTestId("source-picker-count")).not.toHaveText(
      "0 of 0 workflows",
    );
  });

  test("groups the workflow library beside the project's workflows", async ({ workspacePage }) => {
    await openTypedBuilder(workspacePage);

    const list = workspacePage.getByTestId("source-picker-list");
    await expect(list.getByText("Kady workflows", { exact: false })).toBeVisible();
    await expect(list.getByText("Workflows library", { exact: false })).toBeVisible();
  });

  test("narrows the list from the search box", async ({ workspacePage }) => {
    await openTypedBuilder(workspacePage);

    // Deliberately NOT "E2E Workflow": the fixture serves a typed workflow and an
    // engine pipeline under that one name, so it would narrow to two and read as
    // a filtering bug. A library template's name is unique across every group.
    await workspacePage.getByLabel("Search workflow sources").fill("ML Model Selection Review");

    await expect(workspacePage.getByTestId("source-picker-count")).toHaveText(
      /^1 of \d+ workflows$/,
    );
  });

  test("lists engine-native pipelines as their own group in the Kady picker", async ({
    workspacePage,
  }) => {
    await openTypedBuilder(workspacePage);

    // Narrowed to the engine pipeline's own id first: the list is windowed, and
    // the third group sits below a 264px viewport once the library is in it.
    await workspacePage.getByLabel("Search workflow sources").fill("e2e-vendored");

    // The Kady picker carries a third group the iframe's select is NOT fed:
    // the vendored select enumerates engine pipelines itself, so feeding them
    // over the bridge as well would list every pipeline twice.
    const list = workspacePage.getByTestId("source-picker-list");
    await expect(list.getByText("Engine pipelines", { exact: false })).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(1);
  });

  test("feeds the same sources into the builder's own load select", async ({ workspacePage }) => {
    const frame = await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);

    const hostGroup = frame.locator('optgroup[label="Kady workflows"] option');
    await expect(hostGroup.first()).toHaveText("E2E Workflow");
  });
});

test.describe("typed builder load and save", () => {
  test("links the canvas to the host", async ({ workspacePage }) => {
    await openTypedBuilder(workspacePage);

    await expectCanvasLinked(workspacePage);
  });

  test("renders a Kady typed workflow's nodes on the vendored canvas", async ({
    workspacePage,
  }) => {
    const frame = await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);

    await loadE2eWorkflow(workspacePage);

    await expect(frame.locator(".react-flow__node")).toHaveCount(1);
    await expect(frame.locator(".react-flow__node").filter({ hasText: "Analyze" })).toHaveCount(1);
    await expect(frame.getByPlaceholder("workflow-name")).toHaveValue("E2E Workflow");
  });

  test("starts a draft from a library template", async ({ workspacePage }) => {
    await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);

    await workspacePage.getByLabel("Search workflow sources").fill("ML Model Selection Review");
    await workspacePage
      .getByTestId("source-picker-list")
      .getByRole("option", { name: /ML Model Selection Review/ })
      .click();

    await expect(workspacePage.getByTestId("loaded-workflow-name")).toHaveText(
      "ML Model Selection Review",
    );
    await expect(workspacePage.getByText("draft", { exact: true })).toBeVisible();
  });

  test("validates then writes conditionally when saving a loaded workflow", async ({
    workspacePage,
  }) => {
    const log = await installTypedRoutes(workspacePage);
    await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);
    await loadE2eWorkflow(workspacePage);

    await workspacePage.getByRole("button", { name: "Save workflow" }).click();

    await expect(workspacePage.getByTestId("builder-host-status")).toContainText(
      "Saved e2e-workflow at revision 2",
    );
    expect(log.validated).toHaveLength(1);
    expect(log.writes).toHaveLength(1);
    // An update must carry the revision it was loaded at, never a blind write.
    expect(log.writes[0]).toMatchObject({ workflowId: "e2e-workflow", ifMatch: '"1"' });
    expect(log.writes[0].ifNoneMatch).toBeUndefined();
  });

  test("saves a library draft as a create, so it cannot overwrite an existing workflow", async ({
    workspacePage,
  }) => {
    const log = await installTypedRoutes(workspacePage);
    await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);

    await workspacePage.getByLabel("Search workflow sources").fill("ML Model Selection Review");
    await workspacePage
      .getByTestId("source-picker-list")
      .getByRole("option", { name: /ML Model Selection Review/ })
      .click();
    await expect(workspacePage.getByTestId("loaded-workflow-name")).toHaveText(
      "ML Model Selection Review",
    );
    await workspacePage.getByRole("button", { name: "Save workflow" }).click();

    await expect(workspacePage.getByTestId("builder-host-status")).toContainText("Saved");
    expect(log.writes[0]).toMatchObject({
      workflowId: "ml-model-selection-review",
      ifNoneMatch: "*",
    });
    expect(log.writes[0].ifMatch).toBeUndefined();
  });

  test("persists a dragged node position through the save round-trip", async ({
    workspacePage,
  }) => {
    const log = await installTypedRoutes(workspacePage);
    const frame = await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);
    await loadE2eWorkflow(workspacePage);

    // Loading collapses the picker, which moves the iframe up the page. Reading
    // the node box before that settles yields coordinates the drag then misses
    // entirely, so wait for the collapse first.
    await expect(workspacePage.getByRole("button", { name: "Load workflow" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const node = frame.locator(".react-flow__node").first();
    await node.hover();
    const box = await node.boundingBox();
    expect(box, "The loaded node must be laid out before it can be dragged.").not.toBeNull();
    // React Flow writes the node's CANVAS position into its transform. Unlike a
    // bounding box it does not move when the page around the iframe reflows, so
    // it distinguishes "the drag registered" from "the layout shifted".
    const transformBeforeDrag = await node.evaluate((element) => element.style.transform);
    await workspacePage.mouse.down();
    await workspacePage.mouse.move(box!.x + box!.width / 2 + 160, box!.y + box!.height / 2 + 90, {
      steps: 12,
    });
    await workspacePage.mouse.up();

    await expect
      .poll(async () => node.evaluate((element) => element.style.transform))
      .not.toBe(transformBeforeDrag);

    await expect(workspacePage.getByLabel("Unsaved changes")).toBeVisible();
    await workspacePage.getByRole("button", { name: "Save workflow" }).click();
    await expect(workspacePage.getByTestId("builder-host-status")).toContainText("Saved");

    const written = log.writes[0].body as { nodes: Array<{ id: string; position?: { x: number } }> };
    expect(written.nodes[0].position, "The drag must reach the typed document.").toBeTruthy();
  });

  // The two CAS-conflict paths are covered by
  // web/src/components/builder/cas-conflict.test.ts instead of here: Chrome
  // logs every 4xx response as a console error, and this suite's shared
  // `runtimeErrors` fixture fails any test that produces one — so a 409 cannot
  // be exercised in this tier at all.
});
