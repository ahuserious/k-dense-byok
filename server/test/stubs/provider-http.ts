import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROVIDER_HTTP_CASSETTE_VERSION = 1 as const;

export type ProviderHttpMode = "record" | "replay";

export interface ProviderHttpRequestSnapshot {
  method: string;
  url: string;
  contentType?: string;
  bodySha256: string;
  bodyBase64: string;
}

export interface ProviderHttpResponseSnapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyBase64: string;
}

export interface ProviderHttpInteraction {
  request: ProviderHttpRequestSnapshot;
  response: ProviderHttpResponseSnapshot;
}

export interface ProviderHttpCassette {
  version: typeof PROVIDER_HTTP_CASSETTE_VERSION;
  provider: string;
  interactions: ProviderHttpInteraction[];
}

export interface ProviderHttpHarness {
  fetch: typeof globalThis.fetch;
  assertExhausted(): void;
  save(): void;
}

interface ProviderHttpHarnessOptions {
  cassettePath: string;
  provider: string;
  mode?: ProviderHttpMode;
  upstreamFetch?: typeof globalThis.fetch;
}

const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|token|secret|signature|authorization)/i;
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "openai-model",
  "x-request-id",
]);

function bodyHash(bodyBase64: string): string {
  return crypto.createHash("sha256").update(bodyBase64, "base64").digest("hex");
}

function sanitizedUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.toString();
}

async function snapshotRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<ProviderHttpRequestSnapshot> {
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? Buffer.alloc(0)
      : Buffer.from(await request.clone().arrayBuffer());
  const bodyBase64 = body.toString("base64");
  const contentType = request.headers.get("content-type") ?? undefined;
  return {
    method: request.method,
    url: sanitizedUrl(request.url),
    ...(contentType ? { contentType } : {}),
    bodySha256: bodyHash(bodyBase64),
    bodyBase64,
  };
}

async function snapshotResponse(response: Response): Promise<ProviderHttpResponseSnapshot> {
  const headers = [...response.headers.entries()]
    .filter(([name]) => SAFE_RESPONSE_HEADERS.has(name.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyBase64: Buffer.from(await response.clone().arrayBuffer()).toString("base64"),
  };
}

function readCassette(cassettePath: string, provider: string): ProviderHttpCassette {
  const parsed = JSON.parse(fs.readFileSync(cassettePath, "utf-8")) as ProviderHttpCassette;
  if (
    parsed.version !== PROVIDER_HTTP_CASSETTE_VERSION ||
    parsed.provider !== provider ||
    !Array.isArray(parsed.interactions)
  ) {
    throw new Error(`Invalid provider HTTP cassette: ${cassettePath}`);
  }
  return parsed;
}

function writeCassette(cassettePath: string, cassette: ProviderHttpCassette): void {
  fs.mkdirSync(path.dirname(cassettePath), { recursive: true });
  const temporaryPath = `${cassettePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(cassette, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, cassettePath);
}

function mismatchMessage(
  interactionIndex: number,
  expected: ProviderHttpRequestSnapshot,
  actual: ProviderHttpRequestSnapshot,
): string {
  return [
    `Provider HTTP replay mismatch at interaction ${interactionIndex + 1}.`,
    `Expected: ${JSON.stringify(expected)}`,
    `Actual:   ${JSON.stringify(actual)}`,
  ].join("\n");
}

/**
 * Create an ordered cassette harness. Replay is the safe default. Recording
 * requires both LIVE_TESTS=1 and RECORD_PROVIDER_HTTP=1 so a gate command can
 * never turn into a paid provider call because of a single stray variable.
 */
export function createProviderHttpHarness(
  options: ProviderHttpHarnessOptions,
): ProviderHttpHarness {
  const mode = options.mode ?? "replay";
  if (
    mode === "record" &&
    (process.env.LIVE_TESTS !== "1" || process.env.RECORD_PROVIDER_HTTP !== "1")
  ) {
    throw new Error(
      "Provider HTTP recording requires LIVE_TESTS=1 and RECORD_PROVIDER_HTTP=1.",
    );
  }

  const cassette: ProviderHttpCassette =
    mode === "replay"
      ? readCassette(options.cassettePath, options.provider)
      : {
          version: PROVIDER_HTTP_CASSETTE_VERSION,
          provider: options.provider,
          interactions: [],
        };
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);
  let replayIndex = 0;

  const harnessFetch: typeof globalThis.fetch = async (input, init) => {
    const request = await snapshotRequest(input, init);
    if (mode === "record") {
      const response = await upstreamFetch(input, init);
      cassette.interactions.push({
        request,
        response: await snapshotResponse(response),
      });
      return response;
    }

    const interaction = cassette.interactions[replayIndex];
    if (!interaction) {
      throw new Error(
        `Provider HTTP replay received unexpected interaction ${replayIndex + 1}: ` +
          `${request.method} ${request.url}`,
      );
    }
    if (JSON.stringify(interaction.request) !== JSON.stringify(request)) {
      throw new Error(mismatchMessage(replayIndex, interaction.request, request));
    }
    replayIndex += 1;
    return new Response(Buffer.from(interaction.response.bodyBase64, "base64"), {
      status: interaction.response.status,
      statusText: interaction.response.statusText,
      headers: interaction.response.headers,
    });
  };

  return {
    fetch: harnessFetch,
    assertExhausted() {
      if (mode === "replay" && replayIndex !== cassette.interactions.length) {
        throw new Error(
          `Provider HTTP replay consumed ${replayIndex} of ` +
            `${cassette.interactions.length} interactions.`,
        );
      }
    },
    save() {
      if (mode !== "record") {
        throw new Error("Only a recording harness can save a cassette.");
      }
      writeCassette(options.cassettePath, cassette);
    },
  };
}
