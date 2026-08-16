import { expect, test as base } from "@stablyai/playwright-test";
import type { Page } from "@playwright/test";

export interface LiveProject {
  id: string;
  name: string;
  archived: boolean;
}

/**
 * Chromium reports every non-2xx subresource load as a browser console error,
 * including a `fetch` whose refusal the page deliberately handled. A live test
 * that proves a refusal contract must therefore declare each status it expects.
 * The declaration is an exact multiset: an undeclared console error or
 * `pageerror` still fails, and a declared status the browser never reported
 * fails too, so a stale declaration cannot quietly widen the guard.
 */
const REFUSED_RESOURCE_CONSOLE_ERROR =
  /^console\.error: Failed to load resource: the server responded with a status of (\d{3})\b/;

export interface LiveWorkspace {
  page: Page;
  project: LiveProject;
  projectsResponseUrl: string;
  /** Declare one browser fetch this test expects the server to refuse. */
  expectRefusedResourceStatus: (status: number) => void;
}

export const test = base.extend<{
  refusedResourceStatuses: number[];
  liveWorkspace: LiveWorkspace;
  runtimeErrors: void;
}>({
  refusedResourceStatuses: async ({}, use) => {
    await use([]);
  },
  runtimeErrors: [async ({ page, refusedResourceStatuses }, use) => {
    const failures: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    await use();
    const undeclaredExpectation = [...refusedResourceStatuses];
    const unexpected: string[] = [];
    for (const failure of failures) {
      const match = REFUSED_RESOURCE_CONSOLE_ERROR.exec(failure);
      const declaredAt = match ? undeclaredExpectation.indexOf(Number(match[1])) : -1;
      if (declaredAt === -1) unexpected.push(failure);
      else undeclaredExpectation.splice(declaredAt, 1);
    }
    expect(
      unexpected,
      `The unmocked browser must finish without undeclared runtime errors; ` +
        `declared refused statuses: ${refusedResourceStatuses.join(", ") || "none"}.`,
    ).toEqual([]);
    expect(
      undeclaredExpectation,
      `Every declared refused status must be observed; browser errors: ${JSON.stringify(failures)}.`,
    ).toEqual([]);
  }, { auto: true }],
  liveWorkspace: async ({ page, refusedResourceStatuses }, use) => {
    const projectsResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/projects" && response.request().method() === "GET";
    });
    await page.goto("/");
    const projectsResponse = await projectsResponsePromise;
    expect(
      projectsResponse.status(),
      `GET ${projectsResponse.url()} returned ${projectsResponse.status()}.`,
    ).toBe(200);
    const projects = await projectsResponse.json() as LiveProject[];
    const project = projects.find((candidate) => candidate.id === "default" && !candidate.archived)
      ?? projects.find((candidate) => !candidate.archived);
    expect(project, `Expected an active project; observed ${JSON.stringify(projects)}.`).toBeDefined();

    await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
    await page.getByRole("button", { name: `Open project ${project!.name}` }).click();
    await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
    await use({
      page,
      project: project!,
      projectsResponseUrl: projectsResponse.url(),
      expectRefusedResourceStatus: (status: number) => {
        refusedResourceStatuses.push(status);
      },
    });
  },
});

export { expect };

export async function selectLiveWorkspaceTab(page: Page, name: string): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Project workspace" });
  await navigation.getByRole("button", { name, exact: true }).click();
  await expect(navigation.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
}
