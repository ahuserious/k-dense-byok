const DEFAULT_APP_URL = "http://127.0.0.1:13000";
const DEFAULT_BACKEND_PORT = "18000";
const DEFAULT_ENGINE_PORT = "13091";

type Service = "backend" | "engine";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function e2eAppOrigin(configuredBaseUrl?: string): string {
  return new URL(
    configuredBaseUrl ?? process.env.KADY_E2E_BASE_URL ?? DEFAULT_APP_URL,
  ).origin;
}

export function e2eServiceOrigin(
  service: Service,
  configuredBaseUrl?: string,
): string {
  const environmentName = service === "backend"
    ? "NEXT_PUBLIC_ADK_API_URL"
    : "NEXT_PUBLIC_PIPELINE_ENGINE_URL";
  const explicitlyConfiguredOrigin = process.env[environmentName];
  if (explicitlyConfiguredOrigin) return new URL(explicitlyConfiguredOrigin).origin;

  const appOrigin = new URL(e2eAppOrigin(configuredBaseUrl));
  // A public preview reverse-proxies both browser-facing services at the served
  // origin. The local hermetic preview exposes each service on its owned port.
  if (!isLoopbackHostname(appOrigin.hostname)) return appOrigin.origin;

  appOrigin.port = service === "backend"
    ? process.env.KADY_PORT ?? DEFAULT_BACKEND_PORT
    : process.env.KADY_PIPELINE_ENGINE_PORT ?? DEFAULT_ENGINE_PORT;
  return appOrigin.origin;
}
