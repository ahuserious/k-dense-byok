import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KEY_VARIABLE_NAME,
  MODE_CLAIMS,
  SKIP_MESSAGE,
  completionTextFrom,
  evaluateAssertions,
  modelIdMatches,
  parseArguments,
  rankFreeModels,
  tsxBinaryPath,
} from "./smoke-openrouter.mjs";
// Importable under plain `node` because the driver loads `server/src/agent/models.ts`
// lazily. `createProviderWireObserver` is a pure function over text: no runtime is
// constructed, no network is touched, and importing this module starts nothing.
import { createProviderWireObserver } from "./smoke-openrouter-runtime.mjs";

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

test("each mode PRINTS its claim, before any network work, in the run's own output", () => {
  // The previous version of this test asserted that MODE_CLAIMS.product matched a
  // substring of itself, which cannot fail while the constant exists. What matters is
  // that a reader of the OUTPUT is told what the run proves — so the claim is read back
  // out of a real run. Port 1 on loopback refuses instantly: no egress, no waiting, and
  // the run dies at the catalogue fetch, which is after the claim is printed.
  const environment = {
    [KEY_VARIABLE_NAME]: `sk-or-v1-${crypto.randomBytes(24).toString("hex")}`,
    OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1",
  };
  for (const mode of ["product", "direct"]) {
    const result = runSmoke(["--mode", mode, "--require-key", "--timeout-ms", "3000"], environment);
    assert.notEqual(result.status, 0, `${mode}: a refused connection must not pass`);
    assert.ok(
      result.stdout.includes(`MODE: ${mode}\n`),
      `${mode}: the run did not print which mode it was`,
    );
    assert.ok(
      result.stdout.includes(MODE_CLAIMS[mode]),
      `${mode}: the run did not print what it proves`,
    );
  }
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
    modelReturned: "vendor/model:free",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: 0 },
  });
  assert.equal(good.pass, true);

  // The paid substitution. `vendor/model` is the PAID twin of `vendor/model:free`, so a
  // provider answering the bare id for a :free request is exactly the failure this row
  // exists to catch — and the previous normalizer stripped the suffix from both sides and
  // called it a match.
  const paidTwin = evaluateAssertions({
    modelRequested: "vendor/model:free",
    modelReturned: "vendor/model",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: 0 },
  });
  assert.equal(paidTwin.pass, false, "a paid substitution must not pass");

  // A non-zero cost fails even when everything else is perfect: the row is "cheapest FREE
  // model", and rankFreeModels requires every pricing field to be zero before the call.
  const charged = evaluateAssertions({
    modelRequested: "vendor/model:free",
    modelReturned: "vendor/model:free",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: 0.00012 },
  });
  assert.equal(charged.pass, false, "a charged call must not pass a free-model smoke test");

  // An unreported cost is not a zero cost.
  const noCost = evaluateAssertions({
    modelRequested: "vendor/model:free",
    modelReturned: "vendor/model:free",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: null },
  });
  assert.equal(noCost.pass, false, "an unknown cost must not be read as free");

  const emptyText = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "vendor/model",
    textLength: 0,
    usage: { input: 10, output: 3, total: 13, costUsd: 0 },
  });
  assert.equal(emptyText.pass, false);

  const wrongModel = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "someone-else/model",
    textLength: 4,
    usage: { input: 10, output: 3, total: 13, costUsd: 0 },
  });
  assert.equal(wrongModel.pass, false);

  const noUsage = evaluateAssertions({
    modelRequested: "vendor/model",
    modelReturned: "vendor/model",
    textLength: 4,
    usage: { input: null, output: null, total: null, costUsd: 0 },
  });
  assert.equal(noUsage.pass, false);
  const usageAssertion = noUsage.assertions.find((assertion) =>
    assertion.name.includes("token usage"),
  );
  assert.equal(usageAssertion.detail, "the provider reported no complete token-usage figure");
});

test("an absent returned model id FAILS rather than being filled in from the request", () => {
  // This is the round-2 finding the round-3 review proved was never fixed in the mode that
  // is the gate. The driver used to report `message.model?.id ?? model.id`, and the
  // runtime's `message.model` never carries the provider's answer — so the assertion
  // compared the requested id with itself and could not fail. Both the null and the
  // detail sentence are asserted: a caller reading the output has to be able to tell
  // "no substitution" apart from "no answer to check".
  for (const missing of [null, undefined, ""]) {
    const result = evaluateAssertions({
      modelRequested: "vendor/model:free",
      modelReturned: missing,
      textLength: 4,
      usage: { input: 10, output: 3, total: 13, costUsd: 0 },
    });
    assert.equal(result.pass, false, `a ${JSON.stringify(missing)} returned id must not pass`);
    const idAssertion = result.assertions.find((assertion) =>
      assertion.name.includes("returned model id"),
    );
    assert.equal(idAssertion.pass, false);
    assert.equal(
      idAssertion.detail,
      "the runtime surfaced no provider model id, so a substitution cannot be ruled out",
    );
    // And it must not have leaked the requested id into the detail as evidence.
    assert.ok(!idAssertion.detail.includes("vendor/model:free"));
  }
});

test("completionTextFrom prefers content, falls back to reasoning, and names the field", () => {
  // Direct mode read `choices[0].message.content` only, and today's cheapest free models
  // are reasoning models that spend the whole token budget on reasoning and return an
  // empty content with finish_reason=length — so the labelled-lesser mode failed its own
  // non-empty-text assertion against every top-ranked free model.
  assert.deepEqual(completionTextFrom({ content: "pong", reasoning: "thinking" }), {
    text: "pong",
    field: "content",
  });
  assert.deepEqual(completionTextFrom({ content: "", reasoning: "thinking" }), {
    text: "thinking",
    field: "reasoning",
  });
  // Neither field is still a failure: the assertion is about the model answering at all.
  assert.deepEqual(completionTextFrom({ content: "", reasoning: "" }), {
    text: "",
    field: "content",
  });
  assert.deepEqual(completionTextFrom(undefined), { text: "", field: "content" });
  // A non-string in either field is ignored rather than stringified into a false pass.
  assert.deepEqual(completionTextFrom({ content: 42, reasoning: null }), {
    text: "",
    field: "content",
  });
});

test("the wire observer reads the provider's own model id and usage out of SSE frames", async () => {
  // The plumbing behind the assertion above. The frames below are the shape OpenRouter
  // sends: the model id on every chunk, the cost only in the final usage frame, which is
  // why the observer has to keep reading to the end rather than stopping at the first.
  const observer = createProviderWireObserver();
  let pending = "";
  pending = observer.consumeSseText(
    pending + 'data: {"model":"vendor/model:free","choices":[{"delta":{"content":"po"}}]}\n',
  );
  // A frame split across chunk boundaries must not be lost or double-counted.
  pending = observer.consumeSseText(pending + 'data: {"model":"vendor/model:fr');
  pending = observer.consumeSseText(
    pending +
      'ee","usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"cost":0.0}}\n',
  );
  observer.consumeSseText(`${pending}data: [DONE]\n`);

  assert.equal(observer.observed.modelId, "vendor/model:free");
  assert.deepEqual(observer.observed.usage, { input: 10, output: 3, total: 13, costUsd: 0 });
  assert.equal(observer.observed.frameCount, 2, "[DONE] is not a frame");

  // A provider that answers with no model id and no cost leaves both null, which is what
  // makes the assertions fail closed instead of falling back.
  const silent = createProviderWireObserver();
  silent.consumeSseText('data: {"choices":[{"delta":{}}]}\ndata: not json\n\n');
  assert.equal(silent.observed.modelId, null);
  assert.deepEqual(silent.observed.usage, {
    input: null,
    output: null,
    total: null,
    costUsd: null,
  });

  // Types are checked, not coerced: a string cost and a null model id are not answers.
  const malformed = createProviderWireObserver();
  malformed.consumeSseText('data: {"model":null,"usage":{"cost":"0"}}\n');
  assert.equal(malformed.observed.modelId, null);
  assert.deepEqual(malformed.observed.usage, {
    input: null,
    output: null,
    total: null,
    costUsd: null,
  });

  // Exercise the actual fetch-clone path too, not only its parser. The response returned
  // to the provider adapter remains readable while the observer drains its clone.
  const wireBody =
    'data: {"model":"vendor/model:free","choices":[{"delta":{"content":"pong"}}]}\n' +
    'data: {"model":"vendor/model:free","usage":{"prompt_tokens":8,' +
    '"completion_tokens":2,"total_tokens":10,"cost":0}}\n' +
    "data: [DONE]\n";
  const throughFetch = createProviderWireObserver(async () => new Response(wireBody));
  const original = await throughFetch.fetchImplementation("https://example.invalid");
  assert.equal(await original.text(), wireBody, "the provider adapter's response was altered");
  const fetched = await throughFetch.waitForObservation();
  assert.equal(fetched.error, null);
  assert.equal(fetched.modelId, "vendor/model:free");
  assert.deepEqual(fetched.usage, { input: 8, output: 2, total: 10, costUsd: 0 });
});

test("product mode's driver is the server's tsx, and it is present in this clone", () => {
  const tsx = tsxBinaryPath();
  assert.match(tsx, /server\/node_modules\/\.bin\/tsx$/);
  // The half of the name after the comma. Without this the test asserted a string shape
  // and nothing about the clone, so product mode could be unrunnable and this still pass.
  assert.ok(fs.existsSync(tsx), `product mode's driver is missing: ${tsx}`);
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

test("modelIdMatches is exact for a :free request and tolerant only without the suffix", () => {
  assert.equal(modelIdMatches("vendor/model:free", "vendor/model:free"), true);
  assert.equal(modelIdMatches("vendor/model:free", "VENDOR/MODEL:FREE "), true, "case and space are cosmetic");
  assert.equal(modelIdMatches("vendor/model:free", "vendor/model"), false, "the paid twin is not a match");
  assert.equal(modelIdMatches("vendor/model:free", "someone-else/model:free"), false);
  // No suffix requested: there is no paid twin to confuse, and a provider answering the
  // :free variant is serving something cheaper than asked for.
  assert.equal(modelIdMatches("vendor/model", "vendor/model:free"), true);
  assert.equal(modelIdMatches("vendor/model", "vendor/model"), true);
  assert.equal(modelIdMatches("vendor/model", "someone-else/model"), false);
});
