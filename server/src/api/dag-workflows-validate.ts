import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { validateWorkflowGraphDocument } from "../workflows/validate.ts";

/**
 * `POST /dag-workflows/validate` — evaluate a typed document without writing.
 *
 * Contract decisions worth stating once, because they look like bugs if you
 * expect the usual REST reflexes:
 *
 *   * An INVALID document is a successful evaluation. It answers
 *     `200 {ok:false, issues}`. 4xx is reserved for transport, project scope,
 *     size, and an unparseable body — never for "your workflow has a problem",
 *     because a client that treats validation failure as a transport error
 *     cannot show the author which node is wrong.
 *   * The route performs ZERO writes. `dag-workflows-validate.test.ts` asserts
 *     the definition store is byte-identical before and after.
 *   * Auth/scope parity with `PUT /dag-workflows/:id` is structural: both are
 *     registered on the same Fastify instance behind the same project-scope
 *     `onRequest` hook, so an unknown project id is rejected identically.
 *
 * Body cap: 1 MiB, the SAME number the host↔iframe bridge enforces
 * (web/src/lib/builder-bridge.ts `BUILDER_BRIDGE_MAX_PAYLOAD_BYTES`). Reconciled
 * deliberately so a document that survives the bridge can never be rejected by
 * size here. It is lower than the store's 4 MiB document ceiling; a document
 * between the two saves through PUT but cannot be validated over the bridge —
 * such a document cannot reach the canvas in the first place.
 */
export const VALIDATE_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

export interface DagWorkflowValidationIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The canonical form the graph hash is taken over.
 *
 * This MUST stay byte-identical to `canonicalize` in
 * server/src/workflows/store.ts (private there) and to `canonicalDocumentJson`
 * in web/src/lib/typed-canvas-adapter.ts. Two tests pin it: one compares this
 * route's `graphSha256` with the one the store minted for the same document,
 * and one compares it with the browser implementation over a shared fixture.
 */
function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Document contains a non-finite number.");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Document must contain only JSON values.");
  if (ancestors.has(value)) throw new TypeError("Document contains a circular reference.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Document must contain plain JSON objects.");
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`Document field ${key} is undefined.`);
      output[key] = canonicalize(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalGraphJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function graphSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalGraphJson(value)).digest("hex");
}

function badRequest(reply: FastifyReply, detail: string) {
  reply.code(400);
  reply.header("Cache-Control", "no-store");
  return { detail, code: "INVALID_VALIDATE_REQUEST" };
}

interface ValidateRoute {
  Body: { document?: unknown; options?: unknown } | null;
}

/**
 * Mounted from the dag-workflows router so the two share a registration order,
 * a prefix, and every hook. Kept in its own module so the vendored-facing
 * surface is reviewable on its own.
 */
export function registerDagWorkflowValidateRoute(app: FastifyInstance): void {
  app.post<ValidateRoute>(
    "/dag-workflows/validate",
    { bodyLimit: VALIDATE_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!isRecord(request.body)) {
        return badRequest(reply, "The request body must be a JSON object.");
      }
      const { document } = request.body;
      if (!isRecord(document)) {
        return badRequest(reply, "document must be a JSON object.");
      }
      if (request.body.options !== undefined && !isRecord(request.body.options)) {
        return badRequest(reply, "options must be a JSON object when present.");
      }

      const validation = validateWorkflowGraphDocument(document);
      reply.header("Cache-Control", "no-store");
      if (!validation.ok) {
        return {
          ok: false as const,
          issues: validation.issues.map((issue): DagWorkflowValidationIssue => ({
            code: issue.code,
            // The typed validator has no warning channel: every issue it
            // reports blocks a save. `severity` exists so the client renders
            // one shape, and so a future warning does not need a wire change.
            severity: "error" as const,
            path: issue.path,
            message: issue.message,
          })),
        };
      }
      return {
        ok: true as const,
        document: validation.document,
        graphSha256: graphSha256(validation.document),
        warnings: [] as DagWorkflowValidationIssue[],
      };
    },
  );
}
