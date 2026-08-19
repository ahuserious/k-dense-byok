#!/usr/bin/env node
/**
 * End-to-end, unmocked smoke test on the cheapest free OpenRouter model, proving the BYOK
 * path with a real key.
 *
 * Two modes, and the difference between them is the whole point:
 *
 *   --mode product (default)
 *       Runs one completion through THIS REPOSITORY'S OWN BYOK chain — `setupModelRuntime`
 *       injecting `OPENROUTER_API_KEY` into the Pi provider, `resolveModel`,
 *       `assertModelAuthentication`, `ModelRuntime.complete` — via
 *       `scripts/smoke-openrouter-runtime.mjs` under the server's tsx. This is what proves
 *       the product's BYOK path works.
 *   --mode direct
 *       A bare HTTPS POST to <base>/chat/completions. It proves the network is up and the
 *       key is valid. It does NOT prove this repository's BYOK path, and every line of
 *       output says so. It exists as a fallback for an environment where the server's
 *       dependencies are not installed.
 *
 * The key comes from the environment (OPENROUTER_API_KEY) and from nowhere else: it is
 * never accepted as a command-line argument (that would put it in `ps` output and in
 * shell history), never printed, and never included in an error message — every byte this
 * script writes is scrubbed against every representation of the key first.
 *
 * The model is RESOLVED, never hardcoded: the live catalogue is fetched and the cheapest
 * strictly-free model is selected programmatically. With no free model, the script fails
 * closed and says so.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSecretRepresentation,
  scrubText,
  secretRepresentationsForValue,
} from "./hosted-evidence-secrets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDirectory, "..");

export const KEY_VARIABLE_NAME = "OPENROUTER_API_KEY";
export const BASE_URL_VARIABLE_NAME = "OPENROUTER_BASE_URL";
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const SKIP_MESSAGE =
  `SKIP: ${KEY_VARIABLE_NAME} is not set; the BYOK smoke test proves nothing without a real key.`;

export const MODE_CLAIMS = {
  product:
    "proves: this repository's own BYOK path — server/src/agent/models.ts setupModelRuntime() " +
    "injecting the key, resolveModel(), assertModelAuthentication(), ModelRuntime.complete().",
  direct:
    "proves: the network is reachable and the key is valid. It does NOT prove this " +
    "repository's BYOK path — nothing under server/src ran.",
};

export const USAGE = `smoke-openrouter — unmocked BYOK smoke test on the cheapest free OpenRouter model.

Usage:
  node scripts/smoke-openrouter.mjs [--mode product|direct] [options]
  node scripts/secrets-prefill.mjs -- node scripts/smoke-openrouter.mjs --require-key
  node scripts/smoke-openrouter.mjs --list-free
  node scripts/smoke-openrouter.mjs --help

Options:
  --mode <product|direct>  product (default) drives this repo's BYOK chain through
                           scripts/smoke-openrouter-runtime.mjs under server's tsx.
                           direct is a bare provider call and proves strictly less.
  --require-key            Absence of ${KEY_VARIABLE_NAME} becomes an error (exit 2)
                           instead of a skip. This is what CI uses when the secret is
                           supposed to be present.
  --model <id>             Skip catalogue resolution and use this model id. Prints that
                           resolution was skipped; the default path resolves the model.
  --max-candidates <n>     How many ranked free models to try before giving up (default 3).
  --max-tokens <n>         Completion cap (default 32).
  --prompt <text>          Probe prompt (default: a one-word reply request).
  --timeout-ms <n>         Per-request timeout (default 60000).
  --base-url <url>         Provider base URL; defaults to ${BASE_URL_VARIABLE_NAME} or
                           ${DEFAULT_BASE_URL}.
  --list-free              Print the ranked free model ids and exit 0 (network required).
  --help                   This text.

The key is read from ${KEY_VARIABLE_NAME} only. There is deliberately no --api-key option.

Exit codes:
  0  PASS, or SKIP because the key is absent and --require-key was not given
  1  the call failed or an assertion failed
  2  usage or environment error, including --require-key with the key absent

Assertions (on the RESPONSE, not on the request):
  · the completion text is non-empty
  · the model id the provider returned matches the one requested
  · token usage was recorded

Under node --test only the pure parts run. The live call is guarded by KADY_SMOKE_LIVE=1.
`;

class UsageError extends Error {}
class EnvironmentError extends Error {}

// -------------------------------------------------------------------- output guarding

/** Scrub every representation of the key out of anything this script prints. */
export function createGuardedWriters(key, streams = process) {
  const textRepresentations = [];
  const byteRepresentations = [];
  if (key) {
    for (const representation of secretRepresentationsForValue(key)) {
      textRepresentations.push({ name: KEY_VARIABLE_NAME, value: representation });
      byteRepresentations.push({
        name: KEY_VARIABLE_NAME,
        bytes: Buffer.from(representation, "utf8"),
      });
    }
  }
  const guard = (text) => {
    const scrubbed = scrubText(text, textRepresentations);
    if (
      byteRepresentations.length > 0 &&
      findSecretRepresentation(
        Buffer.from(scrubbed, "utf8"),
        byteRepresentations,
        "smoke-openrouter output",
      )
    ) {
      throw new Error("refusing to write output: the key survived scrubbing (this is a bug)");
    }
    return scrubbed;
  };
  return {
    out: (text) => streams.stdout.write(guard(text)),
    err: (text) => streams.stderr.write(guard(text)),
    guard,
  };
}

// ------------------------------------------------------------------ model resolution

/**
 * Rank the strictly-free models in an OpenRouter catalogue payload.
 *
 * "Strictly free" means every numeric field of `pricing` is zero — not merely a `:free`
 * suffix, and not merely zero prompt/completion while an image or request fee hides in
 * another field. Ties (and every entry here ties at $0) break on the smallest context
 * window first, then the id, so the choice is deterministic across runs.
 */
export function rankFreeModels(catalogue) {
  const entries = Array.isArray(catalogue?.data) ? catalogue.data : null;
  if (!entries) throw new EnvironmentError("model catalogue has no `data` array");
  const ranked = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (!id) continue;
    const pricing = entry.pricing ?? {};
    const prices = Object.values(pricing).map((value) => Number(value));
    if (prices.length === 0 || prices.some((price) => !Number.isFinite(price))) continue;
    const total = prices.reduce((sum, price) => sum + price, 0);
    if (total !== 0) continue;
    ranked.push({
      id,
      totalPrice: total,
      contextLength: Number(entry.context_length) || 0,
    });
  }
  ranked.sort(
    (left, right) =>
      left.totalPrice - right.totalPrice ||
      left.contextLength - right.contextLength ||
      left.id.localeCompare(right.id),
  );
  return ranked;
}

async function fetchCatalogue(baseUrl, key, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new EnvironmentError(
        `model catalogue request failed: HTTP ${response.status} from ${url}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(`model catalogue request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------ modes

export function tsxBinaryPath() {
  return path.join(REPO_ROOT, "server", "node_modules", ".bin", "tsx");
}

function runProductMode({ modelId, prompt, maxTokens, timeoutMs, environment }) {
  const tsx = tsxBinaryPath();
  if (!fs.existsSync(tsx)) {
    throw new EnvironmentError(
      `product mode needs the server's tsx at ${tsx}; run \`npm install\` in server/ ` +
        "or use --mode direct (which proves less — see --help)",
    );
  }
  const driver = path.join(scriptDirectory, "smoke-openrouter-runtime.mjs");
  const result = spawnSync(
    tsx,
    [driver, "--model", modelId, "--prompt", prompt, "--max-tokens", String(maxTokens)],
    { encoding: "utf-8", env: environment, timeout: timeoutMs + 30_000, cwd: REPO_ROOT },
  );
  if (result.error) {
    throw new EnvironmentError(`could not run the product-path driver: ${result.error.message}`);
  }
  const line = (result.stdout ?? "")
    .split("\n")
    .find((candidate) => candidate.startsWith("SMOKE_RESULT "));
  if (!line) {
    throw new EnvironmentError(
      `the product-path driver produced no result (exit ${result.status}); ` +
        `stderr: ${(result.stderr ?? "").trim().slice(0, 500)}`,
    );
  }
  const payload = JSON.parse(line.slice("SMOKE_RESULT ".length));
  if (payload.failed) {
    return { ok: false, message: payload.message };
  }
  return { ok: true, ...payload };
}

async function runDirectMode({ modelId, prompt, maxTokens, timeoutMs, baseUrl, key }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: "You are a reachability probe. Answer in one word." },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    const elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, message: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      modelRequested: modelId,
      modelReturned: payload?.model ?? "",
      stopReason: payload?.choices?.[0]?.finish_reason ?? null,
      textLength: text.length,
      textPrefix: text.slice(0, 200),
      usage: {
        input: payload?.usage?.prompt_tokens ?? 0,
        output: payload?.usage?.completion_tokens ?? 0,
        total: payload?.usage?.total_tokens ?? 0,
        costUsd: 0,
      },
      elapsedMs,
    };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------- assertions

/** Normalize for comparison: providers may answer `vendor/model` for `vendor/model:free`. */
function normalizeModelId(id) {
  return String(id ?? "").trim().toLowerCase().replace(/:free$/, "");
}

export function evaluateAssertions(result) {
  const assertions = [
    {
      name: "the completion text is non-empty",
      pass: result.textLength > 0,
      detail: `${result.textLength} characters`,
    },
    {
      name: "the returned model id matches the requested one",
      pass: normalizeModelId(result.modelReturned) === normalizeModelId(result.modelRequested),
      detail: `requested=${result.modelRequested} returned=${result.modelReturned}`,
    },
    {
      name: "token usage was recorded",
      pass: (result.usage?.output ?? 0) > 0 && (result.usage?.total ?? 0) > 0,
      detail:
        `input=${result.usage?.input ?? 0} output=${result.usage?.output ?? 0} ` +
        `total=${result.usage?.total ?? 0} costUsd=${result.usage?.costUsd ?? 0}`,
    },
  ];
  return { assertions, pass: assertions.every((assertion) => assertion.pass) };
}

// ------------------------------------------------------------------------- argv/main

export function parseArguments(argv) {
  const options = {
    mode: "product",
    requireKey: false,
    model: null,
    maxCandidates: 3,
    maxTokens: 32,
    prompt: "Reply with the single word: pong.",
    timeoutMs: 60_000,
    baseUrl: null,
    listFree: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--api-key" || argument === "--key" || argument === "--token") {
      throw new UsageError(
        `${argument} does not exist and never will: a key on the command line lands in ` +
          `ps output and shell history. Set ${KEY_VARIABLE_NAME} in the environment ` +
          "(scripts/secrets-prefill.mjs does exactly that).",
      );
    }
    if (argument.startsWith("sk-")) {
      throw new UsageError(
        "refusing to run: an argument looks like an API key. Keys are read from " +
          `${KEY_VARIABLE_NAME}, never from the command line.`,
      );
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--require-key") {
      options.requireKey = true;
      continue;
    }
    if (argument === "--list-free") {
      options.listFree = true;
      continue;
    }
    const value = argv[index + 1];
    const needsValue = [
      "--mode",
      "--model",
      "--max-candidates",
      "--max-tokens",
      "--prompt",
      "--timeout-ms",
      "--base-url",
    ];
    if (needsValue.includes(argument)) {
      if (value === undefined || (value.startsWith("-") && argument !== "--prompt")) {
        throw new UsageError(`${argument} requires a value`);
      }
      if (argument === "--mode") {
        if (value !== "product" && value !== "direct") {
          throw new UsageError("--mode must be product or direct");
        }
        options.mode = value;
      } else if (argument === "--model") options.model = value;
      else if (argument === "--prompt") options.prompt = value;
      else if (argument === "--base-url") options.baseUrl = value;
      else {
        const numeric = Number(value);
        if (!Number.isInteger(numeric) || numeric <= 0) {
          throw new UsageError(`${argument} must be a positive integer`);
        }
        if (argument === "--max-candidates") options.maxCandidates = numeric;
        else if (argument === "--max-tokens") options.maxTokens = numeric;
        else options.timeoutMs = numeric;
      }
      index += 1;
      continue;
    }
    throw new UsageError(`unknown option: ${argument}`);
  }
  return options;
}

export async function run(argv, environment = process.env, streams = process) {
  let options;
  const key = environment[KEY_VARIABLE_NAME] ?? "";
  const writers = createGuardedWriters(key, streams);
  try {
    options = parseArguments(argv);
  } catch (error) {
    writers.err(`smoke-openrouter: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    writers.out(USAGE);
    return 0;
  }

  if (!key) {
    if (options.requireKey) {
      writers.err(
        `smoke-openrouter: ${KEY_VARIABLE_NAME} is not set and --require-key was given. ` +
          "The BYOK smoke test cannot run.\n",
      );
      return 2;
    }
    writers.out(`${SKIP_MESSAGE}\n`);
    return 0;
  }

  const baseUrl = options.baseUrl ?? environment[BASE_URL_VARIABLE_NAME] ?? DEFAULT_BASE_URL;

  try {
    let candidates;
    if (options.model) {
      candidates = [{ id: options.model, contextLength: 0, totalPrice: 0 }];
      writers.out(
        `MODEL RESOLUTION: skipped — --model ${options.model} was given explicitly.\n`,
      );
    } else {
      const catalogue = await fetchCatalogue(baseUrl, key, options.timeoutMs);
      const ranked = rankFreeModels(catalogue);
      if (ranked.length === 0) {
        writers.err(
          "smoke-openrouter: no strictly-free model resolved from the live catalogue " +
            `(${baseUrl}). Refusing to fall back to a paid model or to a hardcoded id.\n`,
        );
        return 1;
      }
      writers.out(
        `MODEL RESOLUTION: ${ranked.length} strictly-free model(s) in the live catalogue; ` +
          `ranked cheapest-first, will try up to ${options.maxCandidates}.\n`,
      );
      candidates = ranked.slice(0, options.maxCandidates);
      if (options.listFree) {
        for (const entry of ranked) {
          writers.out(`  ${entry.id} (context ${entry.contextLength})\n`);
        }
        return 0;
      }
    }

    writers.out(`MODE: ${options.mode}\n`);
    writers.out(`  ${MODE_CLAIMS[options.mode]}\n`);

    const totalStartedAt = process.hrtime.bigint();
    let result = null;
    for (const candidate of candidates) {
      writers.out(`ATTEMPT: ${candidate.id}\n`);
      const attempt =
        options.mode === "product"
          ? runProductMode({
              modelId: candidate.id,
              prompt: options.prompt,
              maxTokens: options.maxTokens,
              timeoutMs: options.timeoutMs,
              environment,
            })
          : await runDirectMode({
              modelId: candidate.id,
              prompt: options.prompt,
              maxTokens: options.maxTokens,
              timeoutMs: options.timeoutMs,
              baseUrl,
              key,
            });
      if (attempt.ok) {
        result = attempt;
        break;
      }
      writers.out(`  candidate failed: ${attempt.message}\n`);
    }
    const totalElapsedMs = Math.round(Number(process.hrtime.bigint() - totalStartedAt) / 1e6);

    if (!result) {
      writers.err(
        `smoke-openrouter: every one of the ${candidates.length} candidate model(s) failed.\n`,
      );
      writers.out("RESULT: FAIL\n");
      return 1;
    }

    const { assertions, pass } = evaluateAssertions(result);
    writers.out(`MODEL: ${result.modelRequested}\n`);
    if (result.modelResolvedRef) {
      writers.out(`RESOLVED REF: ${result.modelResolvedRef}\n`);
    }
    writers.out(`STOP REASON: ${result.stopReason}\n`);
    writers.out(`REPLY (model output, first 200 chars): ${JSON.stringify(result.textPrefix)}\n`);
    for (const assertion of assertions) {
      writers.out(`ASSERT ${assertion.name}: ${assertion.pass ? "PASS" : "FAIL"} — ${assertion.detail}\n`);
    }
    writers.out(`ELAPSED: ${result.elapsedMs} ms for the call, ${totalElapsedMs} ms total\n`);
    writers.out(`RESULT: ${pass ? "PASS" : "FAIL"}\n`);
    return pass ? 0 : 1;
  } catch (error) {
    writers.err(`smoke-openrouter: ${error.message}\n`);
    writers.out("RESULT: FAIL\n");
    return error instanceof EnvironmentError ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}

export { UsageError, EnvironmentError };
