import {
  chromium,
  expect,
  request,
  type APIRequestContext,
  type FullConfig,
} from "@playwright/test";

import { e2eAppOrigin, e2eServiceOrigin } from "./service-origins";

const SERVICE_READY_TIMEOUT_MS = 90_000;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function configuredFilterExcludesLive(config: FullConfig): boolean {
  const filters = config.grepInvert === null
    ? []
    : Array.isArray(config.grepInvert) ? config.grepInvert : [config.grepInvert];
  return filters.some((filter) => new RegExp(filter.source, filter.flags).test("@live"));
}

function shouldWarmService(
  config: FullConfig,
  appOrigin: string,
  serviceOrigin: string,
): boolean {
  if (process.env.KADY_E2E_WARMUP_SERVICES === "1") return true;
  if (configuredFilterExcludesLive(config)) return false;
  const app = new URL(appOrigin);
  const service = new URL(serviceOrigin);
  return isLoopbackHostname(service.hostname) || service.hostname === app.hostname;
}

/**
 * `/api/preview-health` is written into the frontend by the hermetic preview
 * projection (scripts/preview-environment.mjs) and returns 200 only while that
 * generation's source snapshot is bound and undrifted. It is not part of the
 * committed web app: a hosted deployment, the public-URL overlay topology, and
 * a plain `next dev` frontend all serve 404 there, so probing it
 * unconditionally would fail setup for a baseURL that never had the route.
 *
 * The route lives at the app origin itself rather than at a separate service
 * port, so `shouldWarmService` cannot decide it — its loopback/same-hostname
 * test is trivially true for the app origin. The gate is therefore the same
 * live-topology condition plus the one shape `e2eServiceOrigin` already treats
 * as the local hermetic preview: a loopback app origin. Set
 * `KADY_E2E_PREVIEW_HEALTH=0` for a loopback frontend that is not a preview
 * projection, or `=1` to demand the probe for a preview served elsewhere.
 */
function shouldWarmPreviewHealth(config: FullConfig, appOrigin: string): boolean {
  const configured = process.env.KADY_E2E_PREVIEW_HEALTH;
  if (configured === "0") return false;
  if (configured === "1") return true;
  if (!isLoopbackHostname(new URL(appOrigin).hostname)) return false;
  if (process.env.KADY_E2E_WARMUP_SERVICES === "1") return true;
  return !configuredFilterExcludesLive(config);
}

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
  const resolvedUse = config.projects[0]?.use;
  const configuredBaseUrl = resolvedUse?.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Playwright global setup requires a string baseURL.");
  }
  const extraHTTPHeaders = resolvedUse.extraHTTPHeaders;
  const appOrigin = e2eAppOrigin(configuredBaseUrl);
  const backendOrigin = e2eServiceOrigin("backend", configuredBaseUrl);
  const engineOrigin = e2eServiceOrigin("engine", configuredBaseUrl);
  const serviceWarmups = [
    ...(shouldWarmService(config, appOrigin, backendOrigin)
      ? [{ url: `${backendOrigin}/health`, label: "Backend health" }]
      : []),
    ...(shouldWarmService(config, appOrigin, engineOrigin)
      ? [{ url: `${engineOrigin}/api/health`, label: "Pipeline engine health" }]
      : []),
    ...(shouldWarmPreviewHealth(config, appOrigin)
      ? [{ url: `${appOrigin}/api/preview-health`, label: "Preview health" }]
      : []),
  ];
  const requestContext = await request.newContext({
    baseURL: configuredBaseUrl,
    extraHTTPHeaders,
  });
  try {
    await Promise.all([
      waitForOk(requestContext, "/", "Web root"),
      ...serviceWarmups.map(({ url, label }) => waitForOk(requestContext, url, label)),
    ]);
  } finally {
    await requestContext.dispose();
  }

  const browser = await chromium.launch();
  try {
    const browserContext = await browser.newContext({
      baseURL: configuredBaseUrl,
      extraHTTPHeaders,
    });
    const page = await browserContext.newPage();
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    await page.goto("/", { waitUntil: "domcontentloaded" });
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
    expect(
      runtimeErrors,
      "Cold warm-up browser runtime errors must fail before workers start.",
    ).toEqual([]);
    await browserContext.close();
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `E2E warm-up ready: web=${appOrigin} services=${serviceWarmups.map(({ label }) => label).join("+") || "skipped"} rendered=workspace+builder\n`,
  );
}
