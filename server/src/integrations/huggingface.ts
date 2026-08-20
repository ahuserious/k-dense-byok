/**
 * Hugging Face model query (matrix row 49), the interface matrix row 6 builds on.
 *
 * Row 49 says "CLI". This module deliberately queries the HTTP API instead for
 * the model-search path, because a `huggingface-cli` binary that may not be
 * installed is a fail-closed dependency the Modal preset editor cannot rely on.
 * CLI presence is still reported, as an honest state that gates nothing.
 *
 * Fail-closed egress (#44 / #57 / #64): with HF_TOKEN absent this module throws
 * before a request is constructed, so an unconfigured install reaches nothing.
 * The search endpoint happens to be public; gating it anyway is the point —
 * "it's only a public endpoint" is how silent-default-host defects get written.
 *
 * The token variable NAME is not a free choice. The vendored pipeline engine
 * already pins it: packages/providers/src/community/pi/pi-vendor-map.generated.ts
 * maps vendor "huggingface" -> HF_TOKEN, and packages/core/src/credentials/
 * delivery.test.ts guards against exactly the drift to HUGGINGFACE_API_KEY.
 */
import { lookPath } from "../binaries.ts";

/** The token variable NAME. Its value is never read here, only forwarded. */
export const HUGGING_FACE_TOKEN_ENV_VAR = "HF_TOKEN";

/** Reached only after the token is present. No unconfigured install contacts it. */
export const HUGGING_FACE_API_BASE = "https://huggingface.co";

export const HUGGING_FACE_CLI_BINARY = "huggingface-cli";

export const HUGGING_FACE_NOT_CONFIGURED_MESSAGE =
  `Hugging Face is not configured. Set ${HUGGING_FACE_TOKEN_ENV_VAR} to search models.`;

/** Default page size, and the ceiling a caller may ask for. */
export const DEFAULT_MODEL_SEARCH_LIMIT = 20;
export const MAX_MODEL_SEARCH_LIMIT = 50;

/**
 * One model row as row 6's chooser consumes it. Unknown fields are null rather
 * than absent so a caller can render without optional chaining and a malformed
 * upstream row cannot throw in render phase (#62).
 */
export interface HuggingFaceModelSummary {
  id: string;
  pipelineTag: string | null;
  libraryName: string | null;
  gated: "manual" | "auto" | false;
  downloads: number | null;
  likes: number | null;
}

export class HuggingFaceNotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED";
  readonly envVar = HUGGING_FACE_TOKEN_ENV_VAR;
  constructor() {
    super(HUGGING_FACE_NOT_CONFIGURED_MESSAGE);
    this.name = "HuggingFaceNotConfiguredError";
  }
}

export class HuggingFaceRequestError extends Error {
  readonly code = "UPSTREAM_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "HuggingFaceRequestError";
  }
}

export function huggingFaceConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const token = environment[HUGGING_FACE_TOKEN_ENV_VAR];
  return Boolean(token && token.trim());
}

export interface HuggingFaceCliProbe {
  binary: string;
  found: boolean;
  /** Populated only when found. Never placed in an error body (#71). */
  path: string | null;
}

/**
 * Whether the Hugging Face CLI exists on this machine. Informational only —
 * nothing in the query path consults it, and its absence disables nothing.
 */
export function probeHuggingFaceCli(): HuggingFaceCliProbe {
  const resolvedPath = lookPath(HUGGING_FACE_CLI_BINARY);
  return {
    binary: HUGGING_FACE_CLI_BINARY,
    found: resolvedPath !== null,
    path: resolvedPath,
  };
}

/** Injectable so tests can assert that the unconfigured path attempts zero requests. */
export interface HuggingFaceSearchDeps {
  fetchImpl?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
}

export interface HuggingFaceSearchOptions {
  search: string;
  limit?: number;
}

/** HF returns `gated` as "manual" | "auto" | false; anything else is treated as ungated. */
function normalizeGated(raw: unknown): "manual" | "auto" | false {
  if (raw === "manual" || raw === "auto") return raw;
  return false;
}

function normalizeString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function normalizeNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Rows whose `id` is missing are dropped rather than rendered as an empty
 * chooser entry — a model id the caller cannot dispatch with is not a result.
 */
function normalizeModel(raw: unknown): HuggingFaceModelSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeString(record.id) ?? normalizeString(record.modelId);
  if (!id) return null;
  return {
    id,
    pipelineTag: normalizeString(record.pipeline_tag),
    libraryName: normalizeString(record.library_name),
    gated: normalizeGated(record.gated),
    downloads: normalizeNumber(record.downloads),
    likes: normalizeNumber(record.likes),
  };
}

export function clampModelSearchLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_MODEL_SEARCH_LIMIT;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > MAX_MODEL_SEARCH_LIMIT) return MAX_MODEL_SEARCH_LIMIT;
  return floored;
}

/**
 * The URL a configured search issues. Exported so a test can assert the exact
 * outbound shape without performing the request.
 */
export function huggingFaceSearchUrl(search: string, limit: number): string {
  const url = new URL("/api/models", HUGGING_FACE_API_BASE);
  url.searchParams.set("search", search);
  url.searchParams.set("limit", String(limit));
  // `gated` is returned ONLY when explicitly expanded — a bare ?search= response
  // omits it, which would silently render every gated repo as ungated.
  for (const field of ["gated", "pipeline_tag", "library_name", "downloads", "likes"]) {
    url.searchParams.append("expand[]", field);
  }
  return url.toString();
}

/**
 * Search Hugging Face models by name. Throws HuggingFaceNotConfiguredError —
 * before constructing a request — when HF_TOKEN is absent.
 */
export async function searchHuggingFaceModels(
  options: HuggingFaceSearchOptions,
  deps: HuggingFaceSearchDeps = {},
): Promise<HuggingFaceModelSummary[]> {
  const environment = deps.environment ?? process.env;
  const token = environment[HUGGING_FACE_TOKEN_ENV_VAR]?.trim();
  // The fail-closed gate is the first statement that could reach the network.
  if (!token) throw new HuggingFaceNotConfiguredError();

  const search = options.search.trim();
  if (!search) throw new HuggingFaceRequestError("search must be a non-empty string");
  const limit = clampModelSearchLimit(options.limit);
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(huggingFaceSearchUrl(search, limit), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    // The underlying cause can carry a local path or the request headers; the
    // user-facing text names the next action instead (#71).
    throw new HuggingFaceRequestError(
      "Hugging Face could not be reached. Check this machine's network access.",
    );
  }

  if (!response.ok) {
    throw new HuggingFaceRequestError(
      `Hugging Face search failed (${response.status}).`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HuggingFaceRequestError("Hugging Face returned a response that was not JSON.");
  }
  // A malformed-but-200 body degrades to an empty result rather than throwing
  // somewhere a caller cannot catch it (#62).
  if (!Array.isArray(payload)) return [];
  return payload
    .map(normalizeModel)
    .filter((model): model is HuggingFaceModelSummary => model !== null);
}
