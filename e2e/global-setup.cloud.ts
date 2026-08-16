import {
  expect,
  request,
  type FullConfig,
} from "@playwright/test";

const WEB_REQUEST_TIMEOUT_MS = 90_000;
const EXPECTED_HTML_MARKER = "<title>K-Dense BYOK</title>";
const ALLOWED_HTTP_ORIGIN_ENVIRONMENT_NAME = "KADY_E2E_CLOUD_ALLOWED_HTTP_ORIGIN";

function requireOriginUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an absolute origin without credentials, path, query, or hash.`);
  }
  return url;
}

export function configuredCloudOrigin(config: FullConfig): string {
  const configuredBaseUrl = config.projects[0]?.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Playwright cloud global setup requires a string baseURL.");
  }
  const configuredUrl = requireOriginUrl(configuredBaseUrl, "Playwright cloud baseURL");
  if (configuredUrl.protocol === "https:") return configuredUrl.origin;

  const explicitlyAllowedOrigin = process.env[ALLOWED_HTTP_ORIGIN_ENVIRONMENT_NAME];
  if (configuredUrl.protocol === "http:" && explicitlyAllowedOrigin) {
    const allowedUrl = requireOriginUrl(
      explicitlyAllowedOrigin,
      ALLOWED_HTTP_ORIGIN_ENVIRONMENT_NAME,
    );
    if (allowedUrl.protocol === "http:" && allowedUrl.origin === configuredUrl.origin) {
      return configuredUrl.origin;
    }
  }
  throw new Error(
    `Playwright cloud baseURL must use https; received ${configuredUrl.origin}. ` +
      `For an intentional local contract probe, set ${ALLOWED_HTTP_ORIGIN_ENVIRONMENT_NAME} ` +
      "to that exact http origin.",
  );
}

export default async function cloudGlobalSetup(config: FullConfig): Promise<void> {
  const resolvedUse = config.projects[0]?.use;
  const configuredOrigin = configuredCloudOrigin(config);

  const requestContext = await request.newContext({
    baseURL: configuredOrigin,
    extraHTTPHeaders: resolvedUse.extraHTTPHeaders,
    maxRedirects: 0,
  });
  try {
    const response = await requestContext.get("/", {
      failOnStatusCode: false,
      timeout: WEB_REQUEST_TIMEOUT_MS,
    });
    const responseOrigin = new URL(response.url()).origin;
    expect(
      responseOrigin,
      `Cloud web root response escaped its configured origin: ${response.url()}.`,
    ).toBe(configuredOrigin);
    expect(
      response.status(),
      `Cloud web root must return 200 without redirects; observed ${response.status()} ` +
        `from ${response.url()} with Location=${response.headers().location ?? "none"}.`,
    ).toBe(200);
    const body = await response.text();
    expect(
      body.includes(EXPECTED_HTML_MARKER),
      `Cloud web root at ${response.url()} did not contain ${EXPECTED_HTML_MARKER}.`,
    ).toBe(true);
  } finally {
    await requestContext.dispose();
  }

  process.stdout.write(`E2E cloud warm-up ready: web=${configuredOrigin} redirects=disabled\n`);
}
