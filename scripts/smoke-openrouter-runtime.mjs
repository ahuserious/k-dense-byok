#!/usr/bin/env node
/**
 * The product-path driver behind `smoke-openrouter.mjs --mode product`.
 *
 * Run under the server's `tsx` (it imports TypeScript from `server/src/`), never directly:
 *
 *   server/node_modules/.bin/tsx scripts/smoke-openrouter-runtime.mjs --model <id> …
 *
 * It performs one completion through THIS REPOSITORY'S OWN BYOK chain, the same chain a
 * chat turn or a LaTeX-assist call takes (`server/src/latex/assist.ts:122`):
 *
 *   ModelRuntime.create → setupModelRuntime (server/src/agent/models.ts:365-366, which is
 *   where `OPENROUTER_API_KEY` becomes `setRuntimeApiKey("openrouter", …)`) →
 *   new ModelRegistry → resolveModel("openrouter/<id>") → assertModelAuthentication →
 *   ModelRuntime.complete()
 *
 * Two deliberate narrowings versus `server/src/agent/session-registry.ts`:
 *
 *   · `credentials` is an in-memory CredentialStore instead of `authPath`. The key
 *     therefore never touches disk, the owner's real Pi auth store is never read, and the
 *     smoke test cannot pass off a previously stored credential — it passes only if the
 *     key in THIS process's environment reached the provider.
 *   · `modelsPath: null` and `allowModelNetwork: false`, so `create()` writes no catalogue
 *     cache and makes no network call of its own. The only request this driver makes is
 *     the completion itself.
 *
 * Output is a single `SMOKE_RESULT <json>` line on stdout. It contains the model ids, the
 * token usage, the elapsed time and a truncated prefix of the model's own reply. It never
 * contains the key.
 *
 * WHY THIS FILE OBSERVES THE WIRE ITSELF
 *
 * The runtime's `AssistantMessage` cannot answer either of the two questions the smoke
 * test's assertions ask, and both of its fields look like it can:
 *
 *   · `message.model` is assigned from the model this process REQUESTED — the provider
 *     adapter sets `output.model = model.id` when it builds the message
 *     (`@earendil-works/pi-ai/dist/api/openai-completions.js:110`) and never overwrites it
 *     from the response. Reading it back and comparing it to the requested id is comparing
 *     a value to itself, so a paid substitution on the wire would compare equal.
 *   · `message.usage.cost` is COMPUTED, not received: `parseChunkUsage` builds an all-zero
 *     cost object and hands it to `calculateCost(model, usage)`
 *     (same file, :1128-1130), which multiplies token counts by the LOCAL catalogue's
 *     rates. Under this driver's `modelsPath: null, allowModelNetwork: false` runtime the
 *     catalogue carries no rates at all, so a genuinely paid model resolves to an all-zero
 *     cost table and would report `costUsd = 0`.
 *
 * The runtime's own `onResponse` hook carries only `{status, headers}`, so it cannot supply
 * them either. What the runtime DOES expose is `StreamOptions.fetch`, forwarded verbatim
 * to the provider adapter by `ModelRuntime.prepareRequest`. So the driver passes a fetch
 * that CLONES the response and reads the provider's own SSE frames out of the clone.
 *
 * The hook does not change which code path runs: the same `setupModelRuntime → resolveModel →
 * assertModelAuthentication → ModelRuntime.complete` chain executes, through the same
 * provider adapter, with the same key injection and request payload. OpenRouter includes
 * usage in the final SSE frame; the observer only reads a copy of bytes that were going to
 * arrive anyway.
 *
 * When the wire does not answer, the fields are `null` and the caller's assertions FAIL.
 * A smoke test that says "I could not rule out a substitution" is worth more than one that
 * says PASS over a value that never arrived.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// Bare specifiers cannot be used here: this file lives in `scripts/`, so Node would
// resolve them against the repo-root node_modules, which does not carry the Pi runtime.
// `server/src/**` imports the same package by name and resolves it to this same copy.
import {
  ModelRegistry,
  ModelRuntime,
} from "../server/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

// `server/src/agent/models.ts` is imported LAZILY, inside completeThroughProductPath, and
// only for that reason: a static `import … from "….ts"` makes this whole module
// unimportable under plain `node`, which would put `createProviderWireObserver` — a pure
// function over text, and the thing the smoke test's two substitution assertions now rest
// on — out of reach of `node --test`. An observer that cannot be unit-tested is how the
// assertion it feeds ended up unable to fail in the first place. Under `tsx` (the only way
// this file is executed) the dynamic import resolves exactly as the static one did.
const loadModelsModule = () => import("../server/src/agent/models.ts");

const MAX_REPORTED_TEXT = 200;

/** A CredentialStore that lives and dies with this process. */
export function createInMemoryCredentialStore() {
  const byProvider = new Map();
  return {
    async read(providerId) {
      return byProvider.get(providerId);
    },
    async list() {
      return [...byProvider.entries()].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, fn) {
      const next = await fn(byProvider.get(providerId));
      if (next !== undefined) byProvider.set(providerId, next);
      return byProvider.get(providerId);
    },
    async delete(providerId) {
      byProvider.delete(providerId);
    },
  };
}

/**
 * Read the provider's own model id, token usage and cost out of the SSE frames it sent.
 *
 * `record` is deliberately tolerant about frame shape and deliberately strict about types:
 * a `model` that is not a non-empty string and a `cost` that is not a finite number are
 * both ignored, so a provider that answers `"model": null` leaves the observation `null`
 * and the assertion fails rather than passing on a shape coincidence.
 *
 * The observer never prints. It holds a model id and a number, and the caller decides what
 * to do with them; the key is in the REQUEST headers, which this code never touches.
 */
export function createProviderWireObserver(fetchImplementation = globalThis.fetch) {
  const observed = {
    modelId: null,
    usage: { input: null, output: null, total: null, costUsd: null },
    frameCount: 0,
    error: null,
  };

  const record = (frame) => {
    observed.frameCount += 1;
    if (typeof frame?.model === "string" && frame.model.length > 0) {
      observed.modelId = frame.model;
    }
    const usage = frame?.usage;
    if (usage && typeof usage === "object") {
      const finiteNonNegative = (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      observed.usage = {
        input: finiteNonNegative(usage.prompt_tokens),
        output: finiteNonNegative(usage.completion_tokens),
        total: finiteNonNegative(usage.total_tokens),
        costUsd: finiteNonNegative(usage.cost),
      };
    }
  };

  /** Feed one decoded body chunk in; returns the unconsumed tail to prepend next time. */
  const consumeSseText = (text) => {
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        record(JSON.parse(payload));
      } catch {
        // A frame this driver cannot parse is not an error: the provider adapter is
        // parsing the real stream, and a malformed observation must not fail the call.
      }
    }
    return tail;
  };

  const readCloneInBackground = async (clone) => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of clone.body) {
      pending = consumeSseText(pending + decoder.decode(chunk, { stream: true }));
    }
    consumeSseText(`${pending}\n`);
  };

  // The clone is drained CONCURRENTLY with the adapter's own read of the original — a
  // tee whose second branch is left unread stalls the first — so the last frame can still
  // be in flight when `complete()` resolves. Every drain is tracked and awaited before the
  // observation is read, or the cost frame (which arrives last) would be missed at random.
  const drains = [];

  const observeFetch = async (input, init) => {
    const response = await fetchImplementation(input, init);
    // `clone()` tees the body; the original Response object is handed back untouched, so
    // the provider adapter sees exactly what it would have seen without this observer.
    if (!response.body) return response;
    let clone;
    try {
      clone = response.clone();
    } catch (error) {
      observed.error = `response could not be cloned: ${error.message}`;
      return response;
    }
    drains.push(
      readCloneInBackground(clone).catch((error) => {
        observed.error = `provider stream could not be observed: ${error.message}`;
      }),
    );
    return response;
  };

  /** Settle every in-flight drain, bounded so a stalled clone cannot hang the smoke test. */
  const waitForObservation = async (timeoutMs = 5_000) => {
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(() => {
        observed.error ??= `provider stream was still arriving after ${timeoutMs} ms`;
        resolve();
      }, timeoutMs);
    });
    await Promise.race([Promise.all(drains), bound]);
    clearTimeout(timer);
    return observed;
  };

  return { observed, fetchImplementation: observeFetch, waitForObservation, consumeSseText };
}

function parseArguments(argv) {
  const options = { model: null, prompt: "Reply with the single word: pong.", maxTokens: 32 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--model" || argument === "--prompt" || argument === "--max-tokens") {
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--model") options.model = value;
      else if (argument === "--prompt") options.prompt = value;
      else options.maxTokens = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.model) throw new Error("--model is required");
  if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error("--max-tokens must be a positive integer");
  }
  return options;
}

export async function completeThroughProductPath({ model: modelId, prompt, maxTokens }) {
  const { assertModelAuthentication, modelReference, resolveModel, setupModelRuntime } =
    await loadModelsModule();
  const runtime = await ModelRuntime.create({
    credentials: createInMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  // The BYOK injection point: reads OPENROUTER_API_KEY from the environment this process
  // was given and hands it to the provider. Nothing else in this file touches the key.
  await setupModelRuntime(runtime);
  const registry = new ModelRegistry(runtime);
  const model = resolveModel(`openrouter/${modelId}`, registry);
  await assertModelAuthentication(model, runtime);

  const observer = createProviderWireObserver();
  const startedAt = process.hrtime.bigint();
  const message = await runtime.complete(
    model,
    {
      systemPrompt: "You are a reachability probe. Answer in one word.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    { maxTokens, fetch: observer.fetchImplementation },
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const observed = await observer.waitForObservation();

  const text = (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const usage = message.usage ?? {};
  // An observation error makes every wire-derived field unknown even if an earlier frame
  // happened to carry a plausible value. Partial evidence is not proof.
  const wireObservationComplete = observed.error === null;
  return {
    modelRequested: modelId,
    modelResolvedRef: modelReference(model),
    // Both of these come from the PROVIDER'S FRAMES or they come back null. There is
    // deliberately no `?? model.id` and no `?? 0`: the previous fallbacks made the
    // caller's two substitution assertions compare the requested id against itself and
    // read a locally-computed zero as a wire-confirmed zero, so neither could ever fail.
    modelReturned: wireObservationComplete ? observed.modelId : null,
    observation: {
      // What the caller needs to say honestly where each number came from.
      source: "provider SSE frames observed through StreamOptions.fetch",
      frameCount: observed.frameCount,
      error: observed.error,
      requestModifiedWith: "nothing",
      // Kept beside the observed figure, never in place of it: this is the number the
      // runtime computed from its LOCAL cost table, which reads all-zero for a paid model
      // under `allowModelNetwork: false`. It is reported so a divergence is visible.
      runtimeComputedCostUsd: usage.cost?.total ?? null,
    },
    stopReason: message.stopReason ?? null,
    errorMessage: message.errorMessage ?? null,
    textLength: text.length,
    textPrefix: text.slice(0, MAX_REPORTED_TEXT),
    usage: {
      input: wireObservationComplete ? observed.usage.input : null,
      output: wireObservationComplete ? observed.usage.output : null,
      total: wireObservationComplete ? observed.usage.total : null,
      costUsd: wireObservationComplete ? observed.usage.costUsd : null,
    },
    elapsedMs: Math.round(elapsedMs),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await completeThroughProductPath(parseArguments(process.argv.slice(2)));
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`);
    process.exitCode = 0;
  } catch (error) {
    // The message is the provider's or the runtime's; the caller scrubs it before it is
    // printed, so a provider that echoes a header cannot leak through this path.
    process.stdout.write(
      `SMOKE_RESULT ${JSON.stringify({ failed: true, message: String(error?.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  }
}
