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

/** One issue as `POST /dag-workflows/validate` returns it on a refused save. */
interface TypedValidationIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
}

// Derived, never hard-coded: `e2e/fixtures.ts` resolves the mocked backend
// origin from the preview's own ports (N-10), and a spec that pinned :18000
// would silently stop intercepting on any lane preview — driving whatever
// really answers on 18000 instead. Kept in step with that derivation; the
// fixture's own copy is not exported.
const BACKEND_PORT = process.env.KADY_PORT ?? "18000";
const BACKEND_ORIGINS = [
  `http://127.0.0.1:${BACKEND_PORT}`,
  `http://localhost:${BACKEND_PORT}`,
  ...(process.env.NEXT_PUBLIC_ADK_API_URL
    ? [new URL(process.env.NEXT_PUBLIC_ADK_API_URL).origin]
    : []),
];
const BACKEND = new RegExp(
  `^(?:${[...new Set(BACKEND_ORIGINS)]
    .map((origin) => origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})/`,
);

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
async function installTypedRoutes(
  page: Page,
  options: { validationIssues?: TypedValidationIssue[] } = {},
): Promise<TypedRequestLog> {
  const log: TypedRequestLog = { validated: [], writes: [] };

  await page.route(BACKEND, async (route, request) => {
    const path = backendPath(request);
    const method = request.method();

    if (path === "/dag-workflows/validate" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { document?: unknown };
      log.validated.push(body.document);
      if (options.validationIssues) {
        return routeJson(route, { ok: false, issues: options.validationIssues });
      }
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

/**
 * The node position React Flow wrote into a canvas node's transform.
 *
 * This is the node's position in CANVAS coordinates — the same number the typed
 * document stores — so it can be compared against what the save actually wrote.
 */
function parseNodeTranslate(transform: string): { x: number; y: number } | null {
  const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
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

    // Read the dragged coordinate BEFORE saving. The save response carries a
    // new `graphSha256`, which re-applies the saved document to the canvas — so
    // a transform read afterwards is whatever was written and comparing the two
    // proves nothing.
    const positionBeforeDrag = parseNodeTranslate(transformBeforeDrag);
    const draggedPosition = parseNodeTranslate(
      await node.evaluate((element) => element.style.transform),
    );
    expect(positionBeforeDrag, "React Flow must expose the node position as a transform.")
      .not.toBeNull();
    expect(draggedPosition, "React Flow must expose the node position as a transform.")
      .not.toBeNull();

    await expect(workspacePage.getByLabel("Unsaved changes")).toBeVisible();
    await workspacePage.getByRole("button", { name: "Save workflow" }).click();
    await expect(workspacePage.getByTestId("builder-host-status")).toContainText("Saved");

    const written = log.writes[0].body as {
      nodes: Array<{ id: string; position?: { x: number; y: number } }>;
    };
    const savedPosition = written.nodes[0].position;
    expect(savedPosition, "The saved node must carry a position.").toBeDefined();
    // Asserting the position is merely PRESENT does not distinguish "the drag
    // reached the typed document" from "some position reached it". What has to
    // hold is that the coordinate WRITTEN is the coordinate the author dragged
    // to, and that it is not where the node started.
    expect(savedPosition!.x, "The saved x must be the dragged x.").toBeCloseTo(
      draggedPosition!.x,
      0,
    );
    expect(savedPosition!.y, "The saved y must be the dragged y.").toBeCloseTo(
      draggedPosition!.y,
      0,
    );
    expect(
      Math.hypot(
        savedPosition!.x - positionBeforeDrag!.x,
        savedPosition!.y - positionBeforeDrag!.y,
      ),
      "The drag must move the coordinate the save writes.",
    ).toBeGreaterThan(20);
  });

  test("detaches the canvas when an engine pipeline is loaded over a typed workflow", async ({
    workspacePage,
  }) => {
    // The regression for the round's most consequential fix: before it, loading
    // an engine-native pipeline onto a canvas that was projecting a typed
    // document let the host diff the ENGINE graph against its TYPED document
    // and "apply" the difference — silently overwriting one workflow with an
    // unrelated one on the next save.
    const log = await installTypedRoutes(workspacePage);
    await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);
    await loadE2eWorkflow(workspacePage);

    await workspacePage.getByRole("button", { name: "Load workflow" }).click();
    await workspacePage.getByLabel("Search workflow sources").fill("e2e-vendored");
    await workspacePage
      .getByTestId("source-picker-list")
      .getByRole("option", { name: /E2E Workflow/ })
      .click();

    // The host must let the typed document go, not keep a Save button pointed
    // at a workflow nobody is looking at.
    await expect(workspacePage.getByTestId("builder-host-status")).toContainText(
      "The canvas left the typed workflow",
    );
    await expect(workspacePage.getByTestId("loaded-workflow-name")).toHaveText(
      "No workflow loaded",
    );
    await expect(workspacePage.getByRole("button", { name: "Save workflow" })).toBeDisabled();
    // And nothing was written on the way out.
    expect(log.writes).toHaveLength(0);
  });

  test("names what is wrong when validation refuses the save", async ({ workspacePage }) => {
    // The author's first encounter with an invalid workflow. Before this, the
    // save path fetched the validator's full issues, stored them, forwarded
    // them to the iframe — and rendered a tally: "2 issue(s) block this save."
    // Nothing on either side ever put the validator's words on the screen, so
    // the only way forward was undoing edits at random.
    //
    // `ok: false` is an HTTP 200 here, as the real route returns it, so this
    // item produces no console error for the `runtimeErrors` fixture to catch.
    const log = await installTypedRoutes(workspacePage, {
      validationIssues: [
        {
          code: "workflow/invalid-document",
          severity: "error",
          path: "/nodes/0/name",
          message: "must NOT have fewer than 1 characters",
        },
        {
          code: "workflow/invalid-document",
          severity: "error",
          path: "/edges/0/to",
          message: "must reference a node that exists",
        },
      ],
    });
    await openTypedBuilder(workspacePage);
    await expectCanvasLinked(workspacePage);
    await loadE2eWorkflow(workspacePage);

    await workspacePage.getByRole("button", { name: "Save workflow" }).click();

    const status = workspacePage.getByTestId("builder-host-status");
    await expect(status).toContainText("must NOT have fewer than 1 characters");
    await expect(status).toContainText("/nodes/0/name");
    // A tally is what this item exists to prevent coming back.
    await expect(status).not.toContainText("issue(s) block this save");

    // Every issue is reachable, not only the one in the status line.
    const issues = workspacePage.getByTestId("builder-issue-list");
    await expect(issues.getByRole("listitem")).toHaveCount(2);
    await expect(issues).toContainText("must reference a node that exists");
    await expect(issues).toContainText("/edges/0/to");

    // The refusal must not be the kind that also loses the edit or writes.
    expect(log.writes).toHaveLength(0);
    await expect(workspacePage.getByTestId("loaded-workflow-name")).toHaveText("E2E Workflow");
  });

  // The two CAS-conflict paths are covered by
  // web/src/components/builder/cas-conflict.test.ts instead of here: Chrome
  // logs every 4xx response as a console error, and this suite's shared
  // `runtimeErrors` fixture fails any test that produces one — so a 409 cannot
  // be exercised in this tier at all.
});
