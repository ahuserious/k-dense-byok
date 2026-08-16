import { defineConfig } from "@playwright/test";

import { e2eServiceOrigin } from "./e2e/service-origins";
import baseConfig from "./playwright.config";

function requiredNonDefaultPort(environmentName: string, defaultPort: number): number {
  const value = process.env[environmentName];
  const parsedPort = value && /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error(`${environmentName} must be an explicit valid port for the @live-alt leg.`);
  }
  if (parsedPort === defaultPort) {
    throw new Error(
      `${environmentName} must be non-default for the @live-alt leg; ` +
        `received ${value} (resolved port ${String(parsedPort)}).`,
    );
  }
  if (value !== String(parsedPort)) {
    throw new Error(
      `${environmentName} must use canonical decimal form for the @live-alt leg; received ${value}.`,
    );
  }
  return parsedPort;
}

function requireEffectivePort(
  service: "backend" | "engine",
  configuredBaseUrl: string,
  environmentName: string,
  expectedPort: number,
): void {
  const effectiveOrigin = e2eServiceOrigin(service, configuredBaseUrl);
  const resolvedUrl = new URL(effectiveOrigin);
  const effectivePort = resolvedUrl.port === ""
    ? resolvedUrl.protocol === "https:" ? 443 : 80
    : Number.parseInt(resolvedUrl.port, 10);
  if (effectivePort !== expectedPort) {
    throw new Error(
      `Effective ${service} browser origin must use ${environmentName}=${String(expectedPort)} ` +
        `for the @live-alt leg; resolved ${effectiveOrigin} (port ${String(effectivePort)}).`,
    );
  }
}

const baseURL = process.env.KADY_E2E_BASE_URL;
if (!baseURL) throw new Error("KADY_E2E_BASE_URL is required for the @live-alt leg.");
const backendPort = requiredNonDefaultPort("KADY_PORT", 18_000);
const enginePort = requiredNonDefaultPort("KADY_PIPELINE_ENGINE_PORT", 13_091);
requireEffectivePort("backend", baseURL, "KADY_PORT", backendPort);
requireEffectivePort("engine", baseURL, "KADY_PIPELINE_ENGINE_PORT", enginePort);
const baseProject = baseConfig.projects?.[0];

export default defineConfig({
  ...baseConfig,
  grep: /@live-alt/,
  projects: [
    {
      ...baseProject,
      name: "live-alt",
      use: { ...baseConfig.use, ...baseProject?.use, baseURL },
    },
  ],
});
