import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { REPO_ROOT } from "../config.ts";
import {
  MAX_LEGACY_PIPELINE_WORKFLOW_BYTES,
  previewLegacyPipelineWorkflow,
} from "./legacy-pipeline-import.ts";
import { WORKFLOW_GRAPH_SCHEMA_VERSION, type WorkflowGraphDocument } from "./schema.ts";
import { WorkflowStore } from "./store.ts";
import { validateWorkflowGraphDocument } from "./validate.ts";

/**
 * Seeded pipelines committed in-repo, imported from the DAG-Pipelines branch and
 * de-branded in the landing commit.
 *
 * This module owns no parser and no translator. A seed file is handed to one of
 * the two translators the runtime already has:
 *
 *   - a document whose root declares `schemaVersion: "1.0"` is a typed
 *     NodeSpec v1 `WorkflowGraphDocument` and goes to `validateWorkflowGraphDocument`;
 *   - anything else is the upstream legacy pipeline dialect and goes to
 *     `previewLegacyPipelineWorkflow`, the same translator behind
 *     `POST /dag-workflow-imports/legacy-pipeline/preview`.
 *
 * Both dialects then land through the same `WorkflowStore.saveDefinition` the
 * Builder and the API write with, so a seeded workflow is indistinguishable from
 * a user-authored one once it is in the project — which is the whole point:
 * `GET /dag-workflows` lists it with no endpoint change and the Scientific
 * Pipelines panel renders it with no client change.
 */
export const SEED_PIPELINES_DIR = path.join(REPO_ROOT, "server", "seed", "pipelines");

/** Same shape the store enforces; a seed file name has to be a legal workflow id. */
const SEED_WORKFLOW_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Recorded on every seeded document so a stored definition can name its source bytes. */
export const SEED_PIPELINE_PROVENANCE_SOURCE = "seed-pipelines";

export type SeedPipelineDialect = "typed-nodespec-v1" | "legacy-pipeline-yaml";

export type SeedPipelineStatus = "seeded" | "skipped-existing" | "rejected";

export interface SeedPipelineOutcome {
  /** Seed file name, e.g. `research-starter.yaml`. */
  readonly file: string;
  /** Workflow id the seed lands under — the file name without its extension. */
  readonly workflowId: string;
  readonly dialect: SeedPipelineDialect;
  readonly status: SeedPipelineStatus;
  /** sha256 of the seed file's bytes, exactly as committed. */
  readonly sourceSha256: string;
  /** Present on `rejected`; one entry per blocking issue, already formatted. */
  readonly issues: readonly string[];
}

export interface SeedPipelineReport {
  readonly seeded: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly outcomes: readonly SeedPipelineOutcome[];
}

export interface SeedProjectPipelinesOptions {
  /** Override the committed seed directory. Tests use this; production does not. */
  readonly seedDir?: string;
  /** Override the store. Tests use this; production does not. */
  readonly store?: WorkflowStore;
}

export type TranslateSeedPipelineResult =
  | {
      readonly ok: true;
      readonly dialect: SeedPipelineDialect;
      readonly sourceSha256: string;
      readonly document: WorkflowGraphDocument;
    }
  | {
      readonly ok: false;
      readonly dialect: SeedPipelineDialect;
      readonly sourceSha256: string;
      readonly issues: readonly string[];
    };

function sha256(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

/**
 * Inspect the root well enough to pick a dialect, and no further. A parse
 * failure here is not decided as an error: the legacy translator has its own
 * strict parse with its own message, and a malformed legacy file should fail
 * with that message rather than this function's.
 */
function declaresTypedSchemaVersion(source: string): boolean {
  let parsed: unknown;
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0) return false;
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return (parsed as Record<string, unknown>).schemaVersion === WORKFLOW_GRAPH_SCHEMA_VERSION;
}

function parseTypedSeed(source: string): unknown {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors[0]?.message ?? "YAML parse failed.");
  }
  if (document.warnings.length > 0) {
    throw new Error(document.warnings[0]?.message ?? "YAML produced a parser warning.");
  }
  return document.toJS({ maxAliasCount: 0 });
}

/**
 * Stamp the seed's own bytes onto the document. `provenance` is an existing,
 * optional, validation-neutral field on `WorkflowGraphDocumentSchema`; writing
 * it here means a stored definition can be traced back to the exact committed
 * file, which is what the seed test asserts on.
 */
function withSeedProvenance(
  document: WorkflowGraphDocument,
  file: string,
  sourceSha256: string,
): WorkflowGraphDocument {
  return {
    ...document,
    provenance: {
      source: SEED_PIPELINE_PROVENANCE_SOURCE,
      id: file,
      sha256: sourceSha256,
    },
  };
}

/**
 * Turn one seed file's bytes into a validated typed document, using only the
 * translators that already exist. Pure: no filesystem, no store.
 */
export function translateSeedPipeline(
  source: string,
  workflowId: string,
  file: string,
): TranslateSeedPipelineResult {
  const sourceSha256 = sha256(source);
  const typed = declaresTypedSchemaVersion(source);
  const dialect: SeedPipelineDialect = typed ? "typed-nodespec-v1" : "legacy-pipeline-yaml";

  if (Buffer.byteLength(source, "utf8") > MAX_LEGACY_PIPELINE_WORKFLOW_BYTES) {
    return {
      ok: false,
      dialect,
      sourceSha256,
      issues: [
        `/: seed pipeline exceeds ${MAX_LEGACY_PIPELINE_WORKFLOW_BYTES} bytes.`,
      ],
    };
  }

  if (typed) {
    let parsed: unknown;
    try {
      parsed = parseTypedSeed(source);
    } catch (error) {
      return {
        ok: false,
        dialect,
        sourceSha256,
        issues: [`/: ${error instanceof Error ? error.message : "parse failed"}`],
      };
    }
    const validation = validateWorkflowGraphDocument(parsed);
    if (!validation.ok) {
      return {
        ok: false,
        dialect,
        sourceSha256,
        issues: validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
      };
    }
    if (validation.document.id !== workflowId) {
      return {
        ok: false,
        dialect,
        sourceSha256,
        issues: [
          `/id: seed file ${file} declares id ${validation.document.id}; a seed's id must equal its file name.`,
        ],
      };
    }
    return {
      ok: true,
      dialect,
      sourceSha256,
      document: withSeedProvenance(validation.document, file, sourceSha256),
    };
  }

  let preview;
  try {
    preview = previewLegacyPipelineWorkflow({
      source,
      workflowId,
      reasoning: "high",
    });
  } catch (error) {
    return {
      ok: false,
      dialect,
      sourceSha256,
      issues: [`/: ${error instanceof Error ? error.message : "legacy translation failed"}`],
    };
  }
  if (!preview.graph) {
    return {
      ok: false,
      dialect,
      sourceSha256,
      issues: preview.blockers.map((blocker) => `${blocker.path}: ${blocker.message}`),
    };
  }
  return {
    ok: true,
    dialect,
    sourceSha256,
    document: withSeedProvenance(preview.graph, file, sourceSha256),
  };
}

/** Committed seed files, in a stable order so two runs report identically. */
export function listSeedPipelineFiles(seedDir: string = SEED_PIPELINES_DIR): string[] {
  if (!fs.existsSync(seedDir)) return [];
  return fs
    .readdirSync(seedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Populate a project's typed workflow library from the committed seeds.
 *
 * Non-clobbering, exactly like `copySkillDirs`: a workflow id the project
 * already holds is left alone, so a user's edits to a seeded pipeline survive
 * every later seed pass. Content problems are reported, never thrown — a
 * malformed seed must not be able to take project creation down.
 */
export function seedProjectPipelines(
  projectId: string,
  options: SeedProjectPipelinesOptions = {},
): SeedPipelineReport {
  const seedDir = options.seedDir ?? SEED_PIPELINES_DIR;
  const store = options.store ?? new WorkflowStore();
  const outcomes: SeedPipelineOutcome[] = [];

  for (const file of listSeedPipelineFiles(seedDir)) {
    const workflowId = file.slice(0, -".yaml".length);
    if (!SEED_WORKFLOW_ID_RE.test(workflowId)) {
      outcomes.push({
        file,
        workflowId,
        dialect: "legacy-pipeline-yaml",
        status: "rejected",
        sourceSha256: "",
        issues: [`/: seed file name ${file} is not a legal workflow id.`],
      });
      continue;
    }

    let source: string;
    try {
      source = fs.readFileSync(path.join(seedDir, file), "utf8");
    } catch (error) {
      outcomes.push({
        file,
        workflowId,
        dialect: "legacy-pipeline-yaml",
        status: "rejected",
        sourceSha256: "",
        issues: [`/: seed file could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown"}).`],
      });
      continue;
    }

    const translated = translateSeedPipeline(source, workflowId, file);
    if (!translated.ok) {
      outcomes.push({
        file,
        workflowId,
        dialect: translated.dialect,
        status: "rejected",
        sourceSha256: translated.sourceSha256,
        issues: translated.issues,
      });
      continue;
    }

    if (store.readDefinition(projectId, workflowId)) {
      outcomes.push({
        file,
        workflowId,
        dialect: translated.dialect,
        status: "skipped-existing",
        sourceSha256: translated.sourceSha256,
        issues: [],
      });
      continue;
    }

    try {
      store.saveDefinition(projectId, workflowId, translated.document);
      outcomes.push({
        file,
        workflowId,
        dialect: translated.dialect,
        status: "seeded",
        sourceSha256: translated.sourceSha256,
        issues: [],
      });
    } catch (error) {
      outcomes.push({
        file,
        workflowId,
        dialect: translated.dialect,
        status: "rejected",
        sourceSha256: translated.sourceSha256,
        issues: [`/: ${error instanceof Error ? error.message : "save failed"}`],
      });
    }
  }

  return {
    seeded: outcomes.filter((outcome) => outcome.status === "seeded").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped-existing").length,
    rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    outcomes,
  };
}
