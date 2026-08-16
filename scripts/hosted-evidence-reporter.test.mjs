import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const networkGuardUrl = pathToFileURL(
  path.join(import.meta.dirname, "hosted-evidence-network-guard.mjs"),
).href;

test("direct CI Playwright config and create-suite metadata exclude credentials", async () => {
  const apiKey = "reporter-api-key-sentinel";
  const projectId = "reporter-project-id-sentinel";
  const suiteName = "sds-outer-loop-ci-sentinel";
  process.env.STABLY_API_KEY = apiKey;
  process.env.STABLY_PROJECT_ID = projectId;
  process.env.E2E_SUITE_NAME = suiteName;
  process.env.KADY_E2E_BASE_URL = "http://127.0.0.1:13000";
  process.env.CI = "1";

  const playwrightCommon = await import(
    pathToFileURL(
      path.join(repositoryRoot, "node_modules/playwright/lib/common/index.js"),
    ).href
  );
  const loadedConfig = await playwrightCommon.configLoader.loadConfigFromFile(
    path.join(repositoryRoot, "playwright.config.ts"),
  );
  const fullConfig = loadedConfig.config;
  const serializedReporter = JSON.stringify(fullConfig.reporter);
  assert.equal(serializedReporter.includes(apiKey), false);
  assert.equal(serializedReporter.includes(projectId), false);

  // Reporter 2.1.16's extractConfigInfo copies FullConfig.reporter into the
  // create-suite body (dist/index-D8lS6VkX.mjs:9399,9577-9579). Model that exact
  // field boundary so this fails if credentials re-enter reporter options.
  const mockedCreateSuiteRequestBody = {
    projectSettings: {
      reporter: fullConfig.reporter,
    },
  };
  const serializedRequestBody = JSON.stringify(mockedCreateSuiteRequestBody);
  assert.equal(serializedRequestBody.includes(apiKey), false);
  assert.equal(serializedRequestBody.includes(projectId), false);
  assert.deepEqual(fullConfig.reporter.at(-1)?.[1], { suiteName });
  assert.equal(serializedRequestBody.includes(suiteName), true);

  // Execute the same direct Playwright entrypoint used by CI in list mode,
  // without credentials so the conditional Stably reporter is not attached.
  // The preload guard turns every outbound socket or DNS attempt into failure.
  const childEnvironment = {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${networkGuardUrl}`,
    ].filter(Boolean).join(" "),
  };
  delete childEnvironment.STABLY_API_KEY;
  delete childEnvironment.STABLY_PROJECT_ID;
  delete childEnvironment.STABLY_INTERNAL_DISABLE_REPORTING;
  const ciInvocation = spawnSync(
    "npx",
    ["playwright", "test", "--list", "--grep", "@live", "--trace", "on"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: childEnvironment,
    },
  );
  assert.equal(ciInvocation.status, 0, ciInvocation.stderr);
  assert.match(ciInvocation.stdout, /Total: 3 tests in 1 file/);
});

test("workflow and package pin the audited Stably versions", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.devDependencies["@stablyai/playwright-test"], "2.1.16");

  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/stably-cloud.yml"),
    "utf8",
  );
  assert.match(workflow, /npx --yes stably@4\.12\.28 install --with-deps/);
  assert.equal(
    workflow.match(/npx playwright test/g)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /stably@4\.12\.28 test/);
  assert.doesNotMatch(workflow, /--suiteName/);
  assert.equal(workflow.match(/--trace on/g)?.length, 2);
  assert.match(workflow, /E2E_SUITE_NAME=sds-outer-loop-ci-/);

  const reporterSource = fs.readFileSync(
    path.join(
      repositoryRoot,
      "node_modules/@stablyai/playwright-test/dist/index-D8lS6VkX.mjs",
    ),
    "utf8",
  );
  assert.match(
    reporterSource,
    /e\?\.apiKey \?\? process\.env\.STABLY_API_KEY/,
  );
  assert.match(
    reporterSource,
    /e\?\.projectId \?\? process\.env\.STABLY_PROJECT_ID/,
  );
  assert.match(reporterSource, /this\.suiteName = e\?\.suiteName/);
});

test("network guard fails before an outbound socket attempt", () => {
  const guardedProbe = spawnSync(
    process.execPath,
    [
      `--import=${networkGuardUrl}`,
      "--input-type=module",
      "--eval",
      'import net from "node:net"; net.connect({ host: "127.0.0.1", port: 9 });',
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(guardedProbe.status, 0);
  assert.match(
    guardedProbe.stderr,
    /hosted-evidence network guard blocked net\.connect/,
  );
});
