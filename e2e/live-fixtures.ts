import { expect, test as base } from "@stablyai/playwright-test";
import type { Page } from "@playwright/test";

export interface LiveProject {
  id: string;
  name: string;
  archived: boolean;
}

export interface LiveWorkspace {
  page: Page;
  project: LiveProject;
  projectsResponseUrl: string;
}

export const test = base.extend<{
  liveWorkspace: LiveWorkspace;
  runtimeErrors: void;
}>({
  runtimeErrors: [async ({ page }, use) => {
    const failures: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    await use();
    expect(failures, "The unmocked browser must finish without runtime errors.").toEqual([]);
  }, { auto: true }],
  liveWorkspace: async ({ page }, use) => {
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
    await use({ page, project: project!, projectsResponseUrl: projectsResponse.url() });
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
