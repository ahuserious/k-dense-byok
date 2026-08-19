import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KEY_VARIABLE_NAME,
  MODE_CLAIMS,
  SKIP_MESSAGE,
  evaluateAssertions,
  parseArguments,
  rankFreeModels,
  tsxBinaryPath,
} from "./smoke-openrouter.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "smoke-openrouter.mjs",
);

/**
 * Everything below is hermetic: no network, no dependence on KADY_SOCKET_TESTS, and no
 * real key. The one live leg is guarded by KADY_SMOKE_LIVE=1 at the bottom of this file.
 */
function runSmoke(args, environment = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...environment },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const FIXTURE_CATALOGUE = {
  data: [
    { id: "paid/expensive", context_length: 8000, pricing: { prompt: "0.00001", completion: "0.00003" } },
    { id: "free/large-context:free", context_length: 1000000, pricing: { prompt: "0", completion: "0" } },
    { id: "free/small-context:free", context_length: 8000, pricing: { prompt: "0", completion: "0" } },
    {
      id: "free/hidden-image-fee:free",
      context_length: 4000,
      pricing: { prompt: "0", completion: "0", image: "0.002" },
    },
    { id: "free/no-pricing:free", context_length: 4000, pricing: {} },
    { id: "free/unparseable:free", context_length: 4000, pricing: { prompt: "free" } },
    { id: "free/alphabetically-later:free", context_length: 8000, pricing: { prompt: "0", completion: "0" } },
  ],
};

test("rankFreeModels selects strictly-free models, cheapest and smallest context first", () => {
  const ranked = rankFreeModels(FIXTURE_CATALOGUE);
  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ["free/alphabetically-later:free", "free/small-context:free", "free/large-context:free"],
  );
});

test("rankFreeModels rejects a model whose fee hides in a non-prompt pricing field", () => {
  const ranked = rankFreeModels(FIXTURE_CATALOGUE).map((entry) => entry.id);
  assert.ok(!ranked.includes("free/hidden-image-fee:free"));
  assert.ok(!ranked.includes("free/no-pricing:free"));
  assert.ok(!ranked.includes("free/unparseable:free"));
  assert.ok(!ranked.includes("paid/expensive"));
});

test("rankFreeModels fails closed on a catalogue with no data array", () => {
  assert.throws(() => rankFreeModels({}), /no `data` array/);
  assert.deepEqual(rankFreeModels({ data: [] }), []);
});

test("an absent key is a legible SKIP with exit 0 and never says PASS", () => {
  const result = runSmoke([]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), SKIP_MESSAGE);
  assert.ok(!result.stdout.includes("PASS"), "the skip path must never print PASS");
});

test("--require-key turns an absent key into exit 2", () => {
  const result = runSmoke(["--require-key"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not set and --require-key was given/);
  assert.ok(!result.stdout.includes("PASS"));
});

test("a key may never be passed on the command line", () => {
  for (const argument of ["--api-key", "--key", "--token"]) {
    const result = runSmoke([argument, "whatever"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ps output and shell history/);
  }
  const keyShaped = runSmoke(["sk-thisisnotarealkey000000000000"]);
  assert.equal(keyShaped.status, 2);
  assert.match(keyShaped.stderr, /looks like an API key/);
});

test("argument validation rejects unknown options and bad values", () => {
  assert.throws(() => parseArguments(["--mode", "sideways"]), /--mode must be product or direct/);
  assert.throws(() => parseArguments(["--max-tokens", "0"]), /positive integer/);
  assert.throws(() => parseArguments(["--nonsense"]), /unknown option/);
  assert.equal(parseArguments([]).mode, "product");
  assert.equal(parseArguments(["--mode", "direct"]).mode, "direct");
});

test("each mode's printed claim states exactly what it proves", () => {
  assert.match(MODE_CLAIMS.product, /this repository's own BYOK path/);
  assert.match(MODE_CLAIMS.direct, /does NOT prove this/);
});

test("no mode prints the key, including the failure path", () => {
  const sentinel = `sk-or-v1-${crypto.randomBytes(24).toString("hex")}`;
  const environment = {
    [KEY_VARIABLE_NAME]: sentinel,
    // Port 1 on loopback refuses instantly: a failure path with no egress and no waiting.
    OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1",
  };

  const help = runSmoke(["--help"], environment);
  assert.equal(help.status, 0);
  assert.ok(!help.stdout.includes(sentinel));

  const failure = runSmoke(["--timeout-ms", "3000"], environment);
  assert.notEqual(failure.status, 0, "a refused connection must not pass");
  assert.ok(!failure.stdout.includes(sentinel), "stdout leaked the key");
  assert.ok(!failure.stderr.includes(sentinel), "stderr leaked the key");
  assert.match(failure.stderr, /model catalogue request failed/);

  const usage = runSmoke(["--nonsense"], environment);
  assert.equal(usage.status, 2);
  assert.ok(!usage.stdout.includes(sentinel));
  assert.ok(!usage.stderr.includes(sentinel));
});

test("evaluateAssertions checks the response, not the request", () => {
  const good = evaluateAssertions({
    modelRequested: "vendor/model:free",
    modelReturned: "vendor/model",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: 0 },
  });
  assert.equal(good.pass, true);

  const emptyText = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "vendor/model",
    textLength: 0,
    usage: { input: 10, output: 3, total: 13 },
  });
  assert.equal(emptyText.pass, false);

  const wrongModel = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "someone-else/model",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13 },
  });
  assert.equal(wrongModel.pass, false);

  const noUsage = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "vendor/model",
    textLength: 4,
    usage: { input: 0, output: 0, total: 0 },
  });
  assert.equal(noUsage.pass, false);
});

test("product mode's driver is the server's tsx, and it is present in this clone", () => {
  const tsx = tsxBinaryPath();
  assert.match(tsx, /server\/node_modules\/\.bin\/tsx$/);
});

// The live leg. Off by default so `node --test scripts/*.test.mjs` stays hermetic; the
// lane runs it explicitly, and CI runs the script itself rather than this test.
test("live: the product BYOK path completes on a free model", { skip: !process.env.KADY_SMOKE_LIVE }, () => {
  const result = spawnSync(process.execPath, [scriptPath, "--require-key"], {
    encoding: "utf-8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RESULT: PASS/);
});
