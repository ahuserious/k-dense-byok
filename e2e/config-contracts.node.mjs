import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { TARGETS, checkJobTimeoutBudget } from "./check-job-timeout-budget.mjs";
import cloudGlobalSetup from "./global-setup.cloud.ts";

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
  // 250 in 7 files, not the 246 in 6 this assertion carried until Wave F. The overlay's grepInvert
  // drops the 3 @live items in live-backend.spec.ts, and that file with them: 253 - 3 = 250, 8 - 1 = 7.
  // The old pair was already failing on a clean tree at the Wave-F base sha b702a8b -- it was a stale
  // number, not a regression -- and the test below is what stops it going stale again.
  assert.match(result.output, /Total: 250 tests in 7 files/);
});

test("cloud collection never grows when a Wave-F lane adds a spec, because it declares its projects", () => {
  // This is the structural half of the pin above. playwright.cloud.config.ts used to spread
  // baseConfig wholesale and inherit whatever project list the committed config had; the Wave-F tier
  // added a second project (`wave-f`, testDir ./e2e/wave-f) and five lanes are about to add specs
  // under it. Without an explicit project list, every one of those specs would have joined a
  // public-origin collection that cannot serve them -- the Wave-F tier is unmocked and this topology
  // deliberately does not expose the backend -- and the total above would have moved once per lane.
  const result = collectConfig("playwright.cloud.config.ts", {
    KADY_E2E_BASE_URL: "https://example.test",
  });
  assert.equal(result.status, 0, result.output);
  assert.ok(
    !result.output.includes("[wave-f]"),
    `The cloud overlay must not collect the unmocked Wave-F tier.\n${result.output}`,
  );
  assert.ok(
    !/wave-f\//.test(result.output),
    `The cloud overlay must not collect anything under e2e/wave-f/.\n${result.output}`,
  );
});

test("the @live-alt leg still derives from the mocked chromium project, not from whatever is at index 0", () => {
  // playwright.live-alt.config.ts used to take baseConfig.projects[0] positionally. With a second
  // project in the committed config, a reorder would silently have pointed the @live-alt leg at the
  // Wave-F tier -- which has its own testDir and would have collected zero @live-alt items while
  // still exiting 0. It now resolves by name; this pins both the resolution and the resulting count.
  const result = collectConfig("playwright.live-alt.config.ts", {
    KADY_E2E_BASE_URL: "http://127.0.0.1:13600",
    KADY_PORT: "18600",
    KADY_PIPELINE_ENGINE_PORT: "13691",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[live-alt\] › live-backend\.spec\.ts/);
  assert.ok(
    !result.output.includes("wave-f/"),
    `The @live-alt leg must not collect the Wave-F tier.\n${result.output}`,
  );
  assert.match(result.output, /Total: 3 tests in 1 file/);
});

test("the default collection holds every item exactly once across both projects", () => {
  // The Wave-F tier is a second project over a subdirectory of the first project's testDir. The
  // `testIgnore: "wave-f/**"` on `chromium` is the only thing stopping every Wave-F item from being
  // collected twice, and a duplicate collection is precisely the kind of drift that inflates a
  // "218 substantive items" claim without adding a single new assertion.
  const result = collectConfig("playwright.config.ts", {});
  assert.equal(result.status, 0, result.output);
  // `wave-f/`, not `wave-f/harness/`. `harness/` is F10's own directory; filtering on it would let
  // a future `testIgnore` edit that stops covering `wave-f/f1/**` sail through this assertion while
  // F1's items were collected twice. The `Total:` pin below would catch that only until the next
  // lane bumped the total, which every lane is instructed to do. The invariant is "no Wave-F item
  // is collected by chromium", so the filter has to be every Wave-F item.
  const waveFLines = result.output
    .split("\n")
    .filter((line) => line.includes("wave-f/"));
  const chromiumCollectedWaveF = waveFLines.filter((line) => line.includes("[chromium]"));
  assert.deepEqual(
    chromiumCollectedWaveF,
    [],
    `The chromium project must ignore e2e/wave-f/**.\n${result.output}`,
  );
  assert.match(result.output, /Total: 272 tests in 11 files/);
  assert.match(
    result.output,
    /E2E inventory verified: 272 total = 234 executing-substantive \+ 38 thin; 3 fixme \+ 0 skip\./,
  );
});

test("live-alt accepts canonical alternate ports and effective origins", () => {
  const result = collectConfig("playwright.live-alt.config.ts", {
    KADY_E2E_BASE_URL: "http://127.0.0.1:13600",
    KADY_PORT: "18600",
    KADY_PIPELINE_ENGINE_PORT: "13691",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Total: 3 tests in 1 file/);
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

test("live-alt rejects a conflicting effective engine origin", () => {
  const result = collectConfig("playwright.live-alt.config.ts", {
    KADY_E2E_BASE_URL: "http://127.0.0.1:13600",
    KADY_PORT: "18600",
    KADY_PIPELINE_ENGINE_PORT: "13691",
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: "http://127.0.0.1:13091",
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /Effective engine browser origin must use KADY_PIPELINE_ENGINE_PORT=13691 for the @live-alt leg; resolved http:\/\/127\.0\.0\.1:13091 \(port 13091\)\./,
  );
});

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("cloud root probe rejects redirects without requesting the redirect target", async (t) => {
  let backendRequests = 0;
  let backendOrigin = "";
  const backendServer = http.createServer((_request, response) => {
    backendRequests += 1;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("backend must remain unreachable");
  });
  const publicServer = http.createServer((_request, response) => {
    response.writeHead(302, { Location: backendOrigin });
    response.end();
  });
  let backendListening = false;
  let publicListening = false;
  const previousAllowedOrigin = process.env.KADY_E2E_CLOUD_ALLOWED_HTTP_ORIGIN;

  try {
    let backendAddress;
    try {
      backendAddress = await listenOnLoopback(backendServer);
      backendListening = true;
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        t.skip(`sandbox denied redirect-sentinel listen(): ${error.code}`);
        return;
      }
      throw error;
    }
    backendOrigin = `http://127.0.0.1:${String(backendAddress.port)}`;

    let publicAddress;
    try {
      publicAddress = await listenOnLoopback(publicServer);
      publicListening = true;
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        t.skip(`sandbox denied redirect-sentinel listen(): ${error.code}`);
        return;
      }
      throw error;
    }
    const publicOrigin = `http://127.0.0.1:${String(publicAddress.port)}`;
    process.env.KADY_E2E_CLOUD_ALLOWED_HTTP_ORIGIN = publicOrigin;

    await assert.rejects(
      cloudGlobalSetup({ projects: [{ use: { baseURL: publicOrigin } }] }),
      /Cloud web root must return 200 without redirects; observed 302/,
    );
    assert.equal(backendRequests, 0, "redirect target received a backend request");
  } finally {
    if (previousAllowedOrigin === undefined) {
      delete process.env.KADY_E2E_CLOUD_ALLOWED_HTTP_ORIGIN;
    } else {
      process.env.KADY_E2E_CLOUD_ALLOWED_HTTP_ORIGIN = previousAllowedOrigin;
    }
    if (publicListening) await closeServer(publicServer);
    if (backendListening) await closeServer(backendServer);
  }
});

// --- Job phase budgets -------------------------------------------------------------------------
//
// `check-job-timeout-budget.mjs` runs as the first step of both budgeted jobs, so a violation is a
// ten-second CI failure. These tests are the LOCAL half: they read each job's declared phase
// variables straight out of its workflow file and drive the same check over them, so a budget that
// no longer fits is caught before the branch is pushed, and so the parameterisation itself has
// coverage (round 1's `wave-f` job documented five phases, declared two, and enforced none).

/**
 * The `env:` block of a job, read the same deliberately-unclever way the checker reads the job's
 * `timeout-minutes`: `jobs:` at column 0, the job id at two spaces, its keys at four, and its `env:`
 * entries at six. Scanning stops at the next key at the job's own indent.
 */
function readJobEnvironment(workflowPath, jobId) {
  const lines = fs.readFileSync(path.join(repositoryRoot, workflowPath), "utf8").split("\n");
  const jobHeader = lines.indexOf(`  ${jobId}:`);
  assert.notEqual(jobHeader, -1, `no job \`${jobId}\` in ${workflowPath}`);
  const environment = {};
  let insideEnvironment = false;
  for (let index = jobHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,2}\S/.test(line)) break;
    if (/^ {4}env:\s*$/.test(line)) { insideEnvironment = true; continue; }
    if (/^ {4}\S/.test(line)) { insideEnvironment = false; continue; }
    if (!insideEnvironment) continue;
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*"?([^"\n]*?)"?\s*$/.exec(line);
    if (match) environment[match[1]] = match[2];
  }
  return environment;
}

for (const targetName of Object.keys(TARGETS)) {
  const target = TARGETS[targetName];
  test(`the ${targetName} job's declared phase budgets fit under its own job ceiling`, () => {
    const environment = readJobEnvironment(target.workflowPath, target.jobId);
    // Every phase must have a variable IN THE WORKFLOW FILE. A phase documented only in a comment
    // is the exact decoration this check exists to stop -- `collectPhaseMinutes` throws on it.
    const result = checkJobTimeoutBudget({ targetName, environment });
    assert.ok(
      result.marginMinutes >= 1,
      `${target.workflowPath} job \`${target.jobId}\`:\n${result.report}`,
    );
  });

  test(`the ${targetName} job's budget check fails when a phase budget outgrows the ceiling`, () => {
    const environment = readJobEnvironment(target.workflowPath, target.jobId);
    const inflated = { ...environment };
    const lastPhase = target.phases[target.phases.length - 1];
    // One phase raised past the whole ceiling: the check has to reject it. Without this, a green
    // "budgets fit" test proves nothing about whether the checker can ever say no.
    inflated[lastPhase.variable] = "600";
    assert.throws(
      () => checkJobTimeoutBudget({ targetName, environment: inflated }),
      /leaving -?\d+m of margin/,
    );
  });
}
