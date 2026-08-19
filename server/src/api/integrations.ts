/**
 * Integration registry endpoints (matrix rows 48, 49, 50).
 *
 *   GET  /integrations                        → every declared integration's state
 *   POST /integrations/:id/register           → write a known MCP connector's mcp.json entry
 *   GET  /integrations/huggingface/models     → search Hugging Face models
 *   GET  /integrations/modal/cli              → the Modal CLI's local state
 *
 * Registration note: these routes are registered from registerMcpRoutes() in
 * ./mcp.ts, which server/src/index.ts:262 already calls. That is deliberate —
 * lane F12 does not own index.ts, and a route that is never registered cannot
 * satisfy the "reachable in the UI" gate. See INTEGRATION.md at the clone root.
 *
 * Every route holds the fail-closed rule (#44 / #57 / #64): an unconfigured
 * integration answers 503 with the variable NAME it needs and reaches nothing.
 * No response body ever contains a credential value or a filesystem path in its
 * error text (#71).
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import { readMcpConfig, readMcpDisabled, writeMcpConfig } from "../agent/mcp.ts";
import { findIntegration, listIntegrationStatuses } from "../integrations/registry.ts";
import {
  HuggingFaceNotConfiguredError,
  HuggingFaceRequestError,
  MAX_MODEL_SEARCH_LIMIT,
  searchHuggingFaceModels,
} from "../integrations/huggingface.ts";
import {
  INFRANODUS_MCP_SERVER_NAME,
  INFRANODUS_NOT_CONFIGURED_MESSAGE,
  INFRANODUS_TOOL_PREFIX,
  infranodusMcpConfig,
} from "../integrations/infranodus.ts";
import { probeModalCli, runModalCli } from "../integrations/modal-cli.ts";

/** Only MCP-backed integrations have something to register. */
const REGISTRABLE_MCP_INTEGRATIONS = new Set(["infranodus"]);

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/integrations", async () => {
    return { integrations: listIntegrationStatuses({ paths: activePaths() }) };
  });

  app.post<{ Params: { id: string } }>("/integrations/:id/register", async (req, reply) => {
    const definition = findIntegration(req.params.id);
    if (!definition || !REGISTRABLE_MCP_INTEGRATIONS.has(definition.id)) {
      reply.code(404);
      return { code: "UNKNOWN_INTEGRATION", detail: `No registrable integration "${req.params.id}"` };
    }

    // Unconfigured means nothing is written at all. An entry carrying an empty
    // key would be a connector that looks registered and reaches nothing.
    const config = infranodusMcpConfig();
    if (config === null) {
      reply.code(503);
      return {
        code: "NOT_CONFIGURED",
        envVar: definition.envVars[0].name,
        detail: INFRANODUS_NOT_CONFIGURED_MESSAGE,
      };
    }

    // Disabling a connector MOVES its entry from mcp.json into
    // mcp-disabled.json, so a name absent from mcp.json may still be configured
    // and merely switched off. Writing it again here would land the SAME name in
    // BOTH stores, which agent/mcp.ts's moveServer() then refuses to resolve in
    // either direction (409, "Remove one of them first"), and the connector list
    // offers no remove for a disabled row — a wedge the user cannot exit.
    //
    // This refuses rather than moving the entry back, because the disabled copy
    // is the USER's: they may have hand-edited its command, args or key through
    // PUT /mcp, and silently replacing it with the registry's default entry
    // would discard that edit. The connector list directly above this section
    // already has the toggle that performs the move correctly.
    if (INFRANODUS_MCP_SERVER_NAME in readMcpDisabled(activePaths())) {
      reply.code(409);
      return {
        code: "ALREADY_DISABLED",
        serverName: INFRANODUS_MCP_SERVER_NAME,
        detail:
          `${definition.displayName} is already configured but disabled. ` +
          "Enable it in the connector list above.",
      };
    }

    // Read-modify-write the whole map so every other connector survives, through
    // the existing atomic writer. No second config file, no second write path.
    const servers = readMcpConfig(activePaths());
    servers[INFRANODUS_MCP_SERVER_NAME] = config;
    writeMcpConfig(activePaths(), servers);
    return {
      ok: true,
      serverName: INFRANODUS_MCP_SERVER_NAME,
      toolPrefix: INFRANODUS_TOOL_PREFIX,
    };
  });

  app.get<{ Querystring: { search?: string; limit?: string } }>(
    "/integrations/huggingface/models",
    async (req, reply) => {
      const search = (req.query.search ?? "").trim();
      if (!search) {
        reply.code(400);
        return { code: "INVALID_REQUEST", detail: "search must be a non-empty string" };
      }
      const rawLimit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      if (rawLimit !== undefined && !Number.isFinite(rawLimit)) {
        reply.code(400);
        return {
          code: "INVALID_REQUEST",
          detail: `limit must be a number between 1 and ${MAX_MODEL_SEARCH_LIMIT}`,
        };
      }
      try {
        const models = await searchHuggingFaceModels({ search, limit: rawLimit });
        return { models };
      } catch (error) {
        if (error instanceof HuggingFaceNotConfiguredError) {
          reply.code(503);
          return { code: error.code, envVar: error.envVar, detail: error.message };
        }
        if (error instanceof HuggingFaceRequestError) {
          reply.code(502);
          return { code: error.code, detail: error.message };
        }
        // Nothing else is expected here; report it without echoing the cause,
        // which can carry request headers or a local path.
        reply.code(502);
        return { code: "UPSTREAM_ERROR", detail: "Hugging Face search failed." };
      }
    },
  );

  // The Modal row's installation-and-workspace detail, rendered by
  // web/src/components/integrations/integrations-section.tsx. It is a route of
  // its own rather than a field on GET /integrations because both readings spawn
  // a process: keeping them here means the registry listing stays a pure read,
  // and both spawns are async and memoised so neither blocks the event loop.
  //
  // `profile` is always present, never null, so the panel can state WHY the
  // workspace is unavailable instead of rendering an empty line. runModalCli
  // fails closed on the shared credential module before PATH is consulted, so an
  // unconfigured install still spawns nothing here.
  app.get("/integrations/modal/cli", async () => {
    const [cli, profile] = await Promise.all([probeModalCli(), runModalCli("profile")]);
    return { cli, profile };
  });
}
