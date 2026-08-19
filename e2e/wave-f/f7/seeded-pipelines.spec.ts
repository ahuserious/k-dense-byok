import fs from "node:fs";
import path from "node:path";

import type { Page, Route } from "@playwright/test";

import { expect, selectWorkspaceTab, test } from "../../fixtures";
import { SEEDED_PIPELINES } from "./seeded-pipeline-inventory";

/**
 * Gate U for master-brief row 20: a user who has never read the source finds the
 * seeded pipelines in the workflow registry and operates one from there.
 *
 * The names, descriptions and per-node skill lists asserted here are read from
 * the committed seed files at `server/seed/pipelines/` at spec load time, so the
 * assertions are driven by the shipped bytes rather than by a copy of them.
 * `server/test/seed-pipelines.test.ts` pins the rest of the inventory against
 * what the real loader produces.
 */

const SEED_DIR = path.resolve(__dirname, "../../../server/seed/pipelines");
/**
 * The retired brand name, assembled from fragments: `scripts/token-ban.mjs`
 * bans the literal string everywhere outside a short allow-list, and an
 * absence assertion that spells it out would be a violation of the very ban
 * it exists to verify.
 */
const RETIRED_BRAND = new RegExp(["arch", "on"].join(""), "i");

const NOW = 1_700_000_000_000;

function seedSource(id: string): string {
  return fs.readFileSync(path.join(SEED_DIR, `${id}.yaml`), "utf8");
}

/** The `description:` block of a seed file, as committed. */
function seedDescription(id: string): string {
  const source = seedSource(id);
  const start = source.indexOf("description: |");
  const body = source.slice(start + "description: |".length);
  const lines: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    if (line.trim() !== "" && !line.startsWith("  ")) break;
    lines.push(line.replace(/^ {2}/, ""));
  }
  return lines.join("\n").trim();
}

/** The first `settings.skills.list` block in a seed file, as committed. */
function firstSeedSkillList(id: string): string[] {
  const source = seedSource(id);
  const start = source.indexOf("        list:\n");
  if (start === -1) throw new Error(`${id} declares no node skills.`);
  const skills: string[] = [];
  for (const line of source.slice(start).split("\n").slice(1)) {
    const match = /^ {10}- (\S+)$/.exec(line);
    if (!match) break;
    skills.push(match[1]);
  }
  return skills;
}

const PLAN_SKILLS = firstSeedSkillList("data-scientist");

function summary(id: string) {
  const pipeline = SEEDED_PIPELINES.find((entry) => entry.id === id)!;
  return {
    id: pipeline.id,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    graphSha256: `seed-${pipeline.id}`,
    schemaVersion: "1.0",
    name: pipeline.name,
    description: seedDescription(pipeline.id),
    nodeCount: pipeline.nodeCount,
    edgeCount: pipeline.edgeCount,
  };
}

function storedSeedDefinition(id: string) {
  const pipeline = SEEDED_PIPELINES.find((entry) => entry.id === id)!;
  const nodeIds = pipeline.executionOrder ?? [pipeline.entryNodeId];
  return {
    storageVersion: 1,
    id: pipeline.id,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    graphSha256: `seed-${pipeline.id}`,
    graph: {
      schemaVersion: "1.0",
      id: pipeline.id,
      name: pipeline.name,
      description: seedDescription(pipeline.id),
      entryNodeId: pipeline.entryNodeId,
      provenance: {
        source: "seed-pipelines",
        id: `${pipeline.id}.yaml`,
        sha256: "0".repeat(64),
      },
      limits: {
        maxIterations: 24,
        maxModelCalls: 24,
        maxParallelism: 1,
        maxSubagents: 5,
        timeoutMs: 3_600_000,
        maxTokens: 4_000_000,
        maxCostUsd: 5,
        maxRetries: 0,
      },
      rescue: { enabled: false, maxAttempts: 0, triggers: [] },
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
      artifacts: [],
      nodes: nodeIds.map((nodeId, index) => ({
        id: nodeId,
        name: nodeId,
        kind: "agent",
        terminal: index === nodeIds.length - 1,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: `Seeded step ${nodeId}.`,
        ...(index === 0
          ? { settings: { version: 1, skills: { mode: "auto-manual", list: PLAN_SKILLS } } }
          : {}),
      })),
      edges: nodeIds.slice(1).map((nodeId, index) => ({
        id: `${nodeIds[index]}-to-${nodeId}`,
        from: nodeIds[index],
        to: nodeId,
        condition: "always",
      })),
    },
  };
}

/**
 * Serve the seeded library. Registered after the suite's default mocks, so it
 * wins the match; every other request falls through untouched.
 */
async function useSeededLibrary(page: Page): Promise<void> {
  await page.route("**/dag-workflows", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: SEEDED_PIPELINES.map((pipeline) => summary(pipeline.id)),
      }),
    });
  });
  await page.route("**/dag-workflows/*", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const workflowId = new URL(request.url()).pathname.split("/").pop() ?? "";
    const known = SEEDED_PIPELINES.some((pipeline) => pipeline.id === workflowId);
    if (!known) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { ETag: '"1"' },
      body: JSON.stringify(storedSeedDefinition(workflowId)),
    });
  });
}

const SEED_RUN_ID = `wrun_${"7".repeat(32)}`;

/** The launch route for a seeded workflow, which the suite's default mocks do not know. */
async function useSeededRunLaunch(page: Page): Promise<void> {
  await page.route("**/dag-workflows/*/runs", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const workflowId = new URL(request.url()).pathname.split("/").at(-2) ?? "";
    if (!SEEDED_PIPELINES.some((pipeline) => pipeline.id === workflowId)) {
      return route.fallback();
    }
    const stored = storedSeedDefinition(workflowId);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        manifest: {
          storageVersion: 1,
          id: SEED_RUN_ID,
          projectId: "default",
          workflowId,
          workflowRevision: 1,
          graphSha256: stored.graphSha256,
          requestId: "f7-seeded-request",
          requestSha256: "f7-seeded-request-sha256",
          sessionId: "session-f7",
          createdAt: NOW,
          requestedBy: "user",
          input: { goal: "Exercise the seeded pipeline." },
          effectiveLimits: stored.graph.limits,
          graph: stored.graph,
        },
        state: {
          runId: SEED_RUN_ID,
          status: "queued",
          lastSeq: 0,
          executions: {},
          startedAt: NOW,
        },
      }),
    });
  });
}

async function openSeededRegistry(page: Page): Promise<void> {
  await useSeededLibrary(page);
  await useSeededRunLaunch(page);
  await selectWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
}

function registry(page: Page) {
  return page.getByRole("list", { name: "Scientific pipeline workflows" });
}

test.describe("seeded pipelines in the workflow registry", () => {
  test("all three seeded pipelines are listed under their de-branded names", async ({
    workspacePage,
  }) => {
    await openSeededRegistry(workspacePage);

    const rows = registry(workspacePage).getByRole("listitem");
    // The registry merges typed and vendored-engine rows, so the seeded three
    // are asserted individually rather than as the whole list.
    await expect(rows).not.toHaveCount(0);
    for (const pipeline of SEEDED_PIPELINES) {
      await expect(
        rows.filter({ hasText: pipeline.name }),
        `${pipeline.id} must be listed as ${pipeline.name}`,
      ).toHaveCount(1);
    }
  });

  test("no seeded row carries the retired brand name", async ({ workspacePage }) => {
    await openSeededRegistry(workspacePage);

    await expect(registry(workspacePage)).not.toContainText(RETIRED_BRAND);
    await expect(registry(workspacePage)).not.toContainText(/kdense-starter/i);
  });

  test("each seeded row states what the pipeline is for", async ({ workspacePage }) => {
    await openSeededRegistry(workspacePage);

    for (const pipeline of SEEDED_PIPELINES) {
      const row = registry(workspacePage).getByRole("listitem").filter({ hasText: pipeline.name });
      await expect(row).toContainText(pipeline.descriptionPhrase);
    }
  });

  test("the honest loss of the human approval gate is visible before launch", async ({
    workspacePage,
  }) => {
    await openSeededRegistry(workspacePage);

    const row = registry(workspacePage).getByRole("listitem").filter({ hasText: "Data Scientist" });
    await expect(row).toContainText("This runtime has no human approval gate");
  });

  test("a seeded pipeline opens from the registry with the mouse", async ({ workspacePage }) => {
    await openSeededRegistry(workspacePage);

    await workspacePage.getByRole("button", { name: "Open Data Scientist details" }).click();

    const details = workspacePage.getByRole("region", { name: "Data Scientist", exact: true });
    await expect(details.getByRole("heading", { name: "Data Scientist" })).toBeVisible();
    await expect(
      workspacePage.getByRole("heading", { name: "Complete stored definition (read-only)" }),
    ).toBeVisible();
  });

  test("a seeded pipeline opens from the registry with the keyboard alone", async ({
    workspacePage,
  }) => {
    await openSeededRegistry(workspacePage);

    const opener = workspacePage.getByRole("button", { name: "Open Research Starter details" });
    await opener.focus();
    await expect(opener).toBeFocused();
    await workspacePage.keyboard.press("Enter");

    await expect(
      workspacePage.getByRole("region", { name: "Research Starter", exact: true }),
    ).toBeVisible();
  });

  test("the opened definition shows the seeded graph, its provenance, and its per-node skills", async ({
    workspacePage,
  }) => {
    await openSeededRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Open Data Scientist details" }).click();

    const raw = workspacePage.getByTestId("raw-typed-definition");
    const text = await raw.textContent();
    expect(text).not.toBeNull();
    const definition = JSON.parse(text ?? "") as {
      id: string;
      graph: {
        id: string;
        entryNodeId: string;
        provenance?: { source: string; id: string };
        nodes: Array<{ id: string; settings?: { skills?: { list?: string[] } } }>;
      };
    };

    const expected = SEEDED_PIPELINES.find((pipeline) => pipeline.id === "data-scientist")!;
    expect(definition.id).toBe(expected.id);
    expect(definition.graph.entryNodeId).toBe(expected.entryNodeId);
    expect(definition.graph.nodes.map((node) => node.id)).toEqual(expected.executionOrder);
    // A seeded definition names the committed file it was built from.
    expect(definition.graph.provenance?.source).toBe("seed-pipelines");
    expect(definition.graph.provenance?.id).toBe("data-scientist.yaml");
    // The skills the seed attaches to its first node are the ones the document carries.
    expect(definition.graph.nodes[0]?.settings?.skills?.list).toEqual(PLAN_SKILLS);
  });

  test("a seeded pipeline can be launched from its details panel", async ({
    workspacePage,
  }) => {
    await openSeededRegistry(workspacePage);
    await workspacePage.getByRole("button", { name: "Open Data Scientist details" }).click();

    const details = workspacePage.getByRole("region", { name: "Data Scientist", exact: true });
    const launch = details.getByRole("button", { name: "Run typed workflow" });
    await expect(launch).toBeEnabled();

    const launchPath = "/dag-workflows/data-scientist/runs";
    const response = workspacePage.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === launchPath &&
        candidate.request().method() === "POST",
    );
    await launch.click();
    expect((await response).status()).toBe(201);
    await expect(details.getByRole("status")).toContainText("Created run");
  });
});
