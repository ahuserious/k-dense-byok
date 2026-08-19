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
import {
  assertModelAuthentication,
  modelReference,
  resolveModel,
  setupModelRuntime,
} from "../server/src/agent/models.ts";

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

  const startedAt = process.hrtime.bigint();
  const message = await runtime.complete(
    model,
    {
      systemPrompt: "You are a reachability probe. Answer in one word.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    { maxTokens },
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const text = (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const usage = message.usage ?? {};
  return {
    modelRequested: modelId,
    modelResolvedRef: modelReference(model),
    modelReturned: message.model?.id ?? model.id,
    stopReason: message.stopReason ?? null,
    errorMessage: message.errorMessage ?? null,
    textLength: text.length,
    textPrefix: text.slice(0, MAX_REPORTED_TEXT),
    usage: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      total: usage.totalTokens ?? 0,
      costUsd: usage.cost?.total ?? 0,
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
