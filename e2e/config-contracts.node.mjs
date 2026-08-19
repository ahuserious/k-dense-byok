import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";

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
  const waveFLines = result.output
    .split("\n")
    .filter((line) => line.includes("wave-f/harness/"));
  const chromiumCollectedWaveF = waveFLines.filter((line) => line.includes("[chromium]"));
  assert.deepEqual(
    chromiumCollectedWaveF,
    [],
    `The chromium project must ignore e2e/wave-f/**.\n${result.output}`,
  );
  assert.match(result.output, /Total: 269 tests in 10 files/);
  assert.match(
    result.output,
    /E2E inventory verified: 269 total = 234 executing-substantive \+ 35 thin; 3 fixme \+ 0 skip\./,
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
