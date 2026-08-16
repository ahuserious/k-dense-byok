import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

function requiredNonDefaultPort(environmentName: string, defaultPort: string): string {
  const value = process.env[environmentName];
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${environmentName} must be an explicit valid port for the @live-alt leg.`);
  }
  if (value === defaultPort) {
    throw new Error(`${environmentName} must be non-default for the @live-alt leg; received ${value}.`);
  }
  return value;
}

const baseURL = process.env.KADY_E2E_BASE_URL;
if (!baseURL) throw new Error("KADY_E2E_BASE_URL is required for the @live-alt leg.");
requiredNonDefaultPort("KADY_PORT", "18000");
requiredNonDefaultPort("KADY_PIPELINE_ENGINE_PORT", "13091");
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
