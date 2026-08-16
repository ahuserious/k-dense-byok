import {
  chromium,
  expect,
  request,
  type APIRequestContext,
  type FullConfig,
} from "@playwright/test";

import { e2eAppOrigin, e2eServiceOrigin } from "./service-origins";

const SERVICE_READY_TIMEOUT_MS = 90_000;

async function waitForOk(
  context: APIRequestContext,
  url: string,
  label: string,
): Promise<void> {
  await expect.poll(async () => {
    try {
      const response = await context.get(url, { timeout: 5_000 });
      return String(response.status());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, {
    message: `${label} did not become ready at ${url}`,
    timeout: SERVICE_READY_TIMEOUT_MS,
    intervals: [250, 500, 1_000],
  }).toBe("200");
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const configuredBaseUrl = config.projects[0]?.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Playwright global setup requires a string baseURL.");
  }
  const appOrigin = e2eAppOrigin(configuredBaseUrl);
  const backendOrigin = e2eServiceOrigin("backend", configuredBaseUrl);
  const engineOrigin = e2eServiceOrigin("engine", configuredBaseUrl);
  const requestContext = await request.newContext();
  try {
    await Promise.all([
      waitForOk(requestContext, `${appOrigin}/`, "Web root"),
      waitForOk(requestContext, `${backendOrigin}/health`, "Backend health"),
      waitForOk(requestContext, `${engineOrigin}/api/health`, "Pipeline engine health"),
    ]);
  } finally {
    await requestContext.dispose();
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(appOrigin, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible({
      timeout: SERVICE_READY_TIMEOUT_MS,
    });
    const openProject = page.getByRole("button", { name: /^Open project / }).first();
    await expect(openProject).toBeVisible({ timeout: SERVICE_READY_TIMEOUT_MS });
    await openProject.click();
    const navigation = page.getByRole("navigation", { name: "Project workspace" });
    await expect(navigation).toBeVisible({ timeout: SERVICE_READY_TIMEOUT_MS });
    await navigation.getByRole("button", { name: "Builder", exact: true }).click();
    const builderFrame = page.frameLocator('iframe[title="DAG Builder"]');
    await expect(builderFrame.getByPlaceholder("workflow-name")).toBeVisible({
      timeout: SERVICE_READY_TIMEOUT_MS,
    });
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `E2E warm-up ready: web=${appOrigin} backend=${backendOrigin} engine=${engineOrigin} rendered=workspace+builder\n`,
  );
}
