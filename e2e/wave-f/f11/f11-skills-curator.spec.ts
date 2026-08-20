/**
 * F11 real-user paths on the live app/backend.
 *
 * These items prove more than file presence: committed skills load into the
 * Settings list, the curator writes a real saved NodeSpec skill reference, and
 * the scientific-agent shortcut creates a project specialist through the
 * existing Agents API. Disabled cross-lane adapters stay visibly disabled.
 */
import { expect, test } from "../../live-fixtures";
import { e2eServiceOrigin } from "../../service-origins";

const F11_SKILLS = [
  "autoresearch-graph-architect",
  "autoresearch-squared",
  "prompt-elevation-to-dag",
  "workflow-supervisor",
  "lean4-prover",
  "create-scientific-agent",
  "infranodus-ontology-creator",
] as const;

test("@live @live-alt Settings ▸ Skills exposes all seven loaded F11 skills", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;
  const init = await page.evaluate(async ({ origin, projectId }) => {
    const response = await fetch(`${origin}/sandbox/init?remote=false`, {
      method: "POST",
      headers: { "X-Project-Id": projectId },
    });
    return { status: response.status, body: await response.json() };
  }, {
    origin: e2eServiceOrigin("backend"),
    projectId: liveWorkspace.project.id,
  });
  expect(init.status).toBe(200);

  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Skills" }).click();
  for (const skill of F11_SKILLS) {
    await expect(settings.getByText(skill, { exact: true })).toBeVisible();
  }
});

test("@live @live-alt the curator saves a loaded skill into a real workflow node and readback", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;
  const workflowId = await page.evaluate(async ({ origin, projectId }) => {
    await fetch(`${origin}/sandbox/init?remote=false`, {
      method: "POST",
      headers: { "X-Project-Id": projectId },
    });
    const id = `f11-curator-${Date.now().toString(36)}`;
    const graph = {
      schemaVersion: "1.0",
      id,
      name: "F11 curator live proof",
      entryNodeId: "research",
      defaultModel: {
        requested: {
          source: "fixed",
          provider: "ollama",
          model: "qwen3:32b",
          auth: { kind: "local" },
          reasoning: "high",
        },
        resolution: { mode: "exact" },
      },
      limits: {
        maxIterations: 4,
        maxModelCalls: 8,
        maxParallelism: 2,
        maxSubagents: 2,
        timeoutMs: 60000,
        maxTokens: 20000,
        maxCostUsd: 2,
        maxRetries: 1,
      },
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
      nodes: [{
        id: "research",
        name: "Research",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Produce one bounded evidence-grounded result.",
      }],
      edges: [],
    };
    const response = await fetch(`${origin}/dag-workflows/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-None-Match": "*",
        "X-Project-Id": projectId,
      },
      body: JSON.stringify(graph),
    });
    if (response.status !== 201) {
      throw new Error(`Workflow fixture save returned ${response.status}`);
    }
    return id;
  }, {
    origin: e2eServiceOrigin("backend"),
    projectId: liveWorkspace.project.id,
  });

  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Specialists" }).click();
  await settings.getByText("Curate skills into workflow nodes", { exact: true }).click();
  const curator = settings.getByRole("region", { name: "Workflow skill curator" });
  await expect(curator).toBeVisible();
  await expect(curator.getByLabel("Saved workflow")).toHaveValue(workflowId);

  await curator.getByRole("button", { name: "manual", exact: true }).click();
  await curator.getByRole("switch", {
    name: "Attach autoresearch-graph-architect",
  }).click();
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname ===
      `/skills/curator/workflows/${workflowId}/apply` &&
    response.request().method() === "POST"
  );
  await curator.getByRole("button", { name: "Save node curation" }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(curator.getByText(/real NodeSpec references and load on the next run/))
    .toBeVisible();

  const readback = await page.evaluate(async ({ origin, projectId, workflowId }) => {
    const response = await fetch(`${origin}/dag-workflows/${workflowId}`, {
      headers: { "X-Project-Id": projectId },
    });
    return { status: response.status, body: await response.json() };
  }, {
    origin: e2eServiceOrigin("backend"),
    projectId: liveWorkspace.project.id,
    workflowId,
  });
  expect(readback.status).toBe(200);
  expect(readback.body.graph.nodes[0].settings.skills).toEqual({
    mode: "manual",
    list: ["autoresearch-graph-architect"],
  });
});

test("@live @live-alt Specialists exposes bounded monitor, honest disabled adapters, and creates a scientific agent", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Specialists" }).click();

  const monitorSummary = settings.getByText("Monitor a live autoresearch run", {
    exact: true,
  });
  await monitorSummary.focus();
  await page.keyboard.press("Enter");
  const monitor = settings.getByRole("region", { name: "Autoresearch² live monitor" });
  await expect(monitor.getByRole("button", { name: "Stop monitoring" })).toBeDisabled();
  await expect(monitor.getByRole("button", { name: "Stop run" })).toBeDisabled();
  await monitor.getByRole("button", { name: "autonomous" }).click();
  await expect(monitor.getByLabel("Maximum autonomous evaluations")).toHaveValue("4");

  const supervisorSummary = settings.getByText("Configure the workflow supervisor", {
    exact: true,
  });
  await supervisorSummary.focus();
  await page.keyboard.press("Enter");
  const supervisor = settings.getByRole("region", { name: "Workflow supervisor" });
  const supervisorControl = supervisor.getByRole("button", {
    name: "Enable workflow supervisor",
  });
  await expect(supervisorControl).toBeDisabled();
  await expect(
    supervisor.getByText("Durability settings endpoint not available on this build."),
  ).toBeVisible();

  await settings.getByRole("button", { name: "Create scientific agent" }).click();
  await settings.getByPlaceholder("e.g. code-reviewer").fill("f11-live-scientist");
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/agents/f11-live-scientist" &&
    response.request().method() === "PUT"
  );
  await settings.getByRole("button", { name: "Add agent" }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(settings.getByText("f11-live-scientist", { exact: true })).toBeVisible();
});
