import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const playwrightCli = path.join(repositoryRoot, "node_modules/@playwright/test/cli.js");

function collectConfig(configFile, environment) {
  const childEnvironment = { ...process.env };
  for (const name of [
    "KADY_E2E_BASE_URL",
    "KADY_PORT",
    "KADY_PIPELINE_ENGINE_PORT",
    "NEXT_PUBLIC_ADK_API_URL",
    "NEXT_PUBLIC_PIPELINE_ENGINE_URL",
  ]) {
    delete childEnvironment[name];
  }
  Object.assign(childEnvironment, environment);

  const result = spawnSync(process.execPath, [
    playwrightCli,
    "test",
    "--list",
    "--config",
    configFile,
  ], {
    cwd: repositoryRoot,
    env: childEnvironment,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("cloud collection resolves the web-root-only global setup", () => {
  const result = collectConfig("playwright.cloud.config.ts", {
    KADY_E2E_BASE_URL: "https://example.test",
  });
  assert.equal(result.status, 0, result.output);
  assert.ok(
    result.output.includes(
      `E2E globalSetup resolved: ${path.join(repositoryRoot, "e2e/global-setup.cloud.ts")}`,
    ),
    result.output,
  );
  assert.match(result.output, /Total: 246 tests in 6 files/);
});

test("live-alt rejects default ports hidden by leading zeroes", () => {
  const result = collectConfig("playwright.live-alt.config.ts", {
    KADY_E2E_BASE_URL: "http://127.0.0.1:13600",
    KADY_PORT: "018000",
    KADY_PIPELINE_ENGINE_PORT: "013091",
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /KADY_PORT must be non-default for the @live-alt leg; received 018000 \(resolved port 18000\)\./,
  );
});

test("live-alt rejects a conflicting effective backend origin", () => {
  const result = collectConfig("playwright.live-alt.config.ts", {
    KADY_E2E_BASE_URL: "http://127.0.0.1:13600",
    KADY_PORT: "18600",
    KADY_PIPELINE_ENGINE_PORT: "13691",
    NEXT_PUBLIC_ADK_API_URL: "http://127.0.0.1:18000",
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /Effective backend browser origin must use KADY_PORT=18600 for the @live-alt leg; resolved http:\/\/127\.0\.0\.1:18000 \(port 18000\)\./,
  );
});
