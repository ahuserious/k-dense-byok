/**
 * Wave-F smoke path — 1 item: the shortest real user journey that proves the whole stack is alive.
 *
 * TIER: UNMOCKED. No `page.route` in this file or its fixture chain. The PUT this item observes is
 * answered by the real backend process, and the record it then re-reads after a browser reload came
 * out of the real store.
 *
 * Modelled on e2e/live-backend.spec.ts, the only pre-existing unmocked spec: same entry fixture
 * (`liveWorkspace`), same "wait for the real PUT /dag-workflows/<id> response and read its envelope"
 * shape. It is deliberately *not* a fourth copy of that file's compare-and-set matrix — this item
 * answers one question ("is the stack end-to-end alive right now?") so that a Wave-F lane whose own
 * spec fails can tell a broken feature apart from a broken preview.
 *
 * GATE SCOPE: Gate U evidence. The server-effect assertion here (`outcome: "created"` came back from
 * a real store, and the record survived a reload) is real, but a lane must not cite it as Gate B for
 * *its* feature: Gate B is per-feature and needs a server test asserting on that feature's effect.
 */
import { randomUUID } from "node:crypto";

import { expect, selectLiveWorkspaceTab, test } from "../fixtures";

interface SavedWorkflowEnvelope {
  outcome: "created" | "unchanged" | "updated";
  definition: { id: string; revision: number; graphSha256: string };
}

test("Wave-F smoke: a typed workflow created through the UI is recorded by the real server and survives a reload", async ({
  liveWorkspace,
  evidence,
}, testInfo) => {
  const { page, project } = liveWorkspace;
  const nonce = `${testInfo.workerIndex}-${randomUUID().slice(0, 8)}`;
  const workflowId = `wave-f-smoke-${nonce}`;
  const workflowName = `Wave F Smoke ${nonce}`;

  await selectLiveWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
  await evidence.shot("registry-before-create");

  await page.getByRole("button", { name: "New typed workflow" }).click();
  await page.getByLabel("Workflow template").selectOption("ml-model-selection-review");
  await page.getByLabel("New workflow id").fill(workflowId);
  await page.getByLabel("New workflow name").fill(workflowName);

  const definitionWrite = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/dag-workflows/${workflowId}` &&
    response.request().method() === "PUT"
  ));
  await page.getByRole("button", { name: "Create and open" }).click();
  const writeResponse = await definitionWrite;

  // The effect, not the shape: a real store returned a create outcome for a revision it now holds.
  expect(
    writeResponse.status(),
    `PUT ${writeResponse.url()} returned ${String(writeResponse.status())}.`,
  ).toBeLessThan(300);
  const envelope = await writeResponse.json() as SavedWorkflowEnvelope;
  expect(envelope.outcome, "A new id must be a create, never a silent overwrite.").toBe("created");
  expect(envelope.definition.id).toBe(workflowId);
  expect(
    envelope.definition.graphSha256,
    "The server must return the content hash it stored.",
  ).toMatch(/^[0-9a-f]{64}$/);

  const details = page.getByRole("region", { name: workflowName, exact: true });
  await expect(details).toBeVisible();
  await evidence.shot("workflow-created");
  await details.getByRole("button", { name: "Close details" }).click();

  // Durability, from the user's side of the wire: throw the browser state away and look again.
  await page.reload();
  const projectPicker = page.getByRole("heading", { name: "Choose a project" });
  // The shell may restore the last workspace instead of re-showing the picker; both are legitimate,
  // so this branches on what actually rendered rather than asserting one of them.
  if (await projectPicker.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: `Open project ${project.name}` }).click();
  }
  await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
  await selectLiveWorkspaceTab(page, "Scientific Pipelines");

  const registry = page.getByRole("list", { name: "Scientific pipeline workflows" });
  await expect(
    registry.getByText(workflowName, { exact: true }),
    `"${workflowName}" must still be listed after a reload; if it is not, the write never left the browser.`,
  ).toBeVisible();
  const screenshot = await evidence.shot("workflow-survives-reload");

  testInfo.annotations.push({
    type: "wave-f-smoke",
    description:
      `project=${project.id} workflow=${workflowId} outcome=${envelope.outcome} ` +
      `revision=${String(envelope.definition.revision)} sha256=${envelope.definition.graphSha256.slice(0, 12)}… ` +
      `screenshot=${screenshot}`,
  });
});
