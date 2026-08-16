import {
  expect,
  request,
  type FullConfig,
} from "@playwright/test";

const WEB_READY_TIMEOUT_MS = 90_000;
const EXPECTED_HTML_MARKER = "<title>K-Dense BYOK</title>";

export default async function cloudGlobalSetup(config: FullConfig): Promise<void> {
  const resolvedUse = config.projects[0]?.use;
  const configuredBaseUrl = resolvedUse?.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Playwright cloud global setup requires a string baseURL.");
  }

  const requestContext = await request.newContext({
    baseURL: configuredBaseUrl,
    extraHTTPHeaders: resolvedUse.extraHTTPHeaders,
  });
  try {
    await expect.poll(async () => {
      try {
        const response = await requestContext.get("/", { timeout: 5_000 });
        const body = await response.text();
        return `${response.status()}:${String(body.includes(EXPECTED_HTML_MARKER))}`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, {
      message: `Cloud web root did not return 200 with ${EXPECTED_HTML_MARKER}`,
      timeout: WEB_READY_TIMEOUT_MS,
      intervals: [250, 500, 1_000],
    }).toBe("200:true");
  } finally {
    await requestContext.dispose();
  }

  process.stdout.write(`E2E cloud warm-up ready: web=${new URL(configuredBaseUrl).origin}\n`);
}
