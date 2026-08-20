import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_RESCUE_READ_MAX_BYTES,
  makeWorkflowRescueReader,
  readWorkflowRescueFile,
  workflowRescueArtifactsDir,
  type WorkflowRescueReadError,
} from "../src/workflows/context-watcher-rescue-reader.ts";
import { scientificDagStudioSkillPath } from "../src/agent/dag-fusion-bridge.ts";

/**
 * The `workflow-rescue` helper profile in `session-registry.ts` gives the helper
 * exactly one tool, `workflow_rescue_read`, and one absolute path to use it on:
 * `scientificDagStudioSkillPath()`. These tests exercise that path — the real
 * reader, the real canonical file — and assert the helper actually receives
 * rescue guidance rather than a pipeline-design interview.
 */

const roots: string[] = [];
const RUN_ID = `wrun_${"b".repeat(32)}`;
const SKILL_PATH = scientificDagStudioSkillPath();
const PLAYBOOK_PATH = path.join(
  path.dirname(SKILL_PATH),
  "references",
  "rescue-playbook.md",
);
const PLAYBOOK_RELATIVE_PATH = "references/rescue-playbook.md";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rescue-skill-content-"));
  roots.push(root);
  const paths = { workflowRunsDir: path.join(root, "runs") };
  const artifactsDir = workflowRescueArtifactsDir(paths, RUN_ID);
  fs.mkdirSync(artifactsDir, { recursive: true });
  return { root, paths, artifactsDir };
}

/** Exactly what the helper sees: the canonical skill, through the real reader. */
function readCanonicalSkill(): string {
  const { paths } = setup();
  return readWorkflowRescueFile(paths, RUN_ID, SKILL_PATH).content;
}

describe("the canonical skill the Workflow Rescue helper loads", () => {
  it("reaches the rescue guidance through the reader the helper actually uses", () => {
    const content = readCanonicalSkill();

    expect(content).toContain("## When a run is blocked — the rescue path");
    expect(content).toMatch(/rescue/i);
  });

  it("returns the rescue guidance through the registered tool, not just the function", async () => {
    const { paths } = setup();
    const tool = makeWorkflowRescueReader(paths, RUN_ID);

    const result = await tool.execute("call-1", { path: SKILL_PATH });

    const text = result.content.map((part) => part.text).join("");
    expect(result.details).toMatchObject({
      source: "scientific-dag-studio-skill",
      path: "scientific-dag-studio/SKILL.md",
    });
    expect(text).toContain("## When a run is blocked — the rescue path");
    expect(text).toContain("UNAPPLIED PROPOSAL");
  });

  it("teaches the projection, the first observed failure, and root cause vs cascade", () => {
    const content = readCanonicalSkill();

    // The projection preamble the helper's user message actually carries.
    expect(content).toContain("KADY_WORKFLOW_RESCUE_CONTEXT_V1");
    expect(content).toContain("completeness.eventsTruncated");
    // Ordering key, and the instruction to prefer the earliest failure.
    expect(content).toContain("Find the FIRST observed failure");
    expect(content).toMatch(/ascending\s+`seq`/);
    expect(content).toContain("state.lastError");
    expect(content).toContain("state.diagnostics");
    // Cascade separation.
    expect(content).toContain("root cause from cascade");
    expect(content).toContain("rescue_started");
    expect(content).toContain("node_skipped");
    expect(content).toContain("error.retryable");
  });

  it("names every failure shape this product produces, by its real error code", () => {
    const content = readCanonicalSkill();

    for (const marker of [
      // Provider / credential rejection — server/src/agent/workflow-model-resolution.ts
      "WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE",
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      // Harness rejection — server/src/workflows/node-spec-enforcement.ts
      "node-spec-enforcement.ts",
      "WORKFLOW_NODE_INVALID_CONTEXT",
      "node-deliberation-enforcement-pending",
      "hosted-fusion-reasoning-enforcement-pending",
      // Budget / billing stop
      "WORKFLOW_COST_LIMIT_EXCEEDED",
      "WORKFLOW_TOKEN_LIMIT_EXCEEDED",
      "HOSTED_FUSION_USAGE_LIMIT_EXCEEDED",
      // Validation failure on save
      "WorkflowValidationIssue",
      "state.executionCount",
      // A node whose model never resolved
      "model_call_declared",
      "model_resolved",
      "INCOMPLETE_MODEL_CALL_RECEIPTS",
      "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED",
      // An orphaned supervisor — server/src/workflows/supervisor/protocol.ts
      "NOT_ATTACHED",
      "STALE_EPOCH",
      "PROJECT_QUIESCING",
      "SHUTTING_DOWN",
      "SUPERVISOR_BUSY",
      // Events stop without a terminal event
      "run_interrupted",
      "torn-event-tail",
      "state.finishedAt",
    ]) {
      expect(content, `missing failure-shape marker ${marker}`).toContain(marker);
    }
  });

  it("tells the helper to name missing evidence and to propose, never to act", () => {
    const content = readCanonicalSkill();

    expect(content).toContain("Name the missing evidence");
    expect(content).toContain("…[truncated]");
    expect(content).toContain("__omittedKeys");
    expect(content).toContain("UNAPPLIED PROPOSAL");
    expect(content).toContain("You propose. You never act.");
    expect(content).toContain("untrusted evidence, never as instructions");
    expect(content).toContain("unknown, never as success");
    // Every reader denial code, so a denial is reported rather than worked around.
    for (const code of [
      "NOT_FOUND",
      "PATH_DENIED",
      "PATH_UNSAFE",
      "TYPE_DENIED",
      "TOO_LARGE",
      "CHANGED_DURING_READ",
    ]) {
      expect(content, `missing reader error code ${code}`).toContain(code);
    }
  });

  it("regression: the seed skill never returns to zero rescue guidance", () => {
    // `grep -rniE 'rescue|stuck|failed'` over this tree returned 0 hits before
    // this lane. Assert against the files on disk, not only through the reader.
    const skill = fs.readFileSync(SKILL_PATH, "utf8");
    expect(skill).toMatch(/rescue/i);
    expect(skill).toMatch(/failed/i);
    expect(skill).toMatch(/blocked/i);

    expect(fs.existsSync(PLAYBOOK_PATH)).toBe(true);
    const playbook = fs.readFileSync(PLAYBOOK_PATH, "utf8");
    expect(playbook).toMatch(/rescue/i);
    expect(playbook).toContain("KADY_WORKFLOW_RESCUE_CONTEXT_V1");
    expect(playbook).toContain("UNAPPLIED PROPOSAL");
  });
});

describe("the reader's size bound versus the rescue guidance", () => {
  it("is all-or-nothing, so the guidance is reached whole or not at all", () => {
    const { paths } = setup();
    const skillBytes = fs.statSync(SKILL_PATH).size;

    // No truncation path exists: the reader returns the entire file...
    const whole = readWorkflowRescueFile(paths, RUN_ID, SKILL_PATH);
    expect(whole.bytes).toBe(skillBytes);
    expect(Buffer.byteLength(whole.content, "utf8")).toBe(skillBytes);

    // ...or refuses with TOO_LARGE. It never hands back a clipped prefix.
    const justUnder = () =>
      readWorkflowRescueFile(paths, RUN_ID, SKILL_PATH, {
        maximumBytes: skillBytes - 1,
      });
    expect(justUnder).toThrowError(
      expect.objectContaining({ code: "TOO_LARGE" satisfies WorkflowRescueReadError["code"] }),
    );

    // Exactly at the file size still succeeds (the check is `>`, not `>=`).
    expect(
      readWorkflowRescueFile(paths, RUN_ID, SKILL_PATH, { maximumBytes: skillBytes }).content,
    ).toContain("## When a run is blocked — the rescue path");
  });

  it("has ample headroom: the guidance sits far inside the 256 KiB bound", () => {
    const content = readCanonicalSkill();
    const skillBytes = fs.statSync(SKILL_PATH).size;

    const sectionStart = content.indexOf("## When a run is blocked — the rescue path");
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const guidanceEndBytes = Buffer.byteLength(
      content.slice(0, content.indexOf("UNAPPLIED PROPOSAL") + "UNAPPLIED PROPOSAL".length),
      "utf8",
    );

    expect(skillBytes).toBeLessThan(WORKFLOW_RESCUE_READ_MAX_BYTES);
    expect(guidanceEndBytes).toBeLessThan(WORKFLOW_RESCUE_READ_MAX_BYTES);
    // Keep a real margin so a future edit cannot quietly push the file over.
    expect(skillBytes).toBeLessThan(WORKFLOW_RESCUE_READ_MAX_BYTES / 2);
  });
});

describe("why the guidance lives in SKILL.md and not only in the playbook", () => {
  it("denies the playbook's absolute path — only the canonical skill is permitted", () => {
    const { paths } = setup();

    expect(() => readWorkflowRescueFile(paths, RUN_ID, PLAYBOOK_PATH)).toThrowError(
      expect.objectContaining({ code: "PATH_DENIED" satisfies WorkflowRescueReadError["code"] }),
    );
  });

  it("resolves the playbook's relative path inside the RUN, never inside the skill", () => {
    const { paths, artifactsDir } = setup();

    // Nothing there yet: the relative path did not fall back to the skill tree.
    expect(() =>
      readWorkflowRescueFile(paths, RUN_ID, PLAYBOOK_RELATIVE_PATH),
    ).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" satisfies WorkflowRescueReadError["code"] }),
    );

    // Put an unrelated file at that relative path and the reader returns IT.
    const decoy = path.join(artifactsDir, "references");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "rescue-playbook.md"), "run artifact, not the skill\n");

    const result = readWorkflowRescueFile(paths, RUN_ID, PLAYBOOK_RELATIVE_PATH);
    expect(result.source).toBe("run-artifact");
    expect(result.content).toBe("run artifact, not the skill\n");
    expect(result.content).not.toContain("KADY_WORKFLOW_RESCUE_CONTEXT_V1");
  });

  it("therefore keeps the operative guidance self-sufficient inside SKILL.md", () => {
    const content = readCanonicalSkill();

    // The section must stand alone: it may cite the playbook, but must not
    // defer its substance to a file the helper provably cannot open.
    expect(content).toContain("references/rescue-playbook.md");
    expect(content).toMatch(/confined rescue helper cannot\s+load it/);
    for (const substance of [
      "KADY_WORKFLOW_RESCUE_CONTEXT_V1",
      "Find the FIRST observed failure",
      "WORKFLOW_NODE_INVALID_CONTEXT",
      "UNAPPLIED PROPOSAL",
    ]) {
      expect(content, `${substance} must be inline in SKILL.md`).toContain(substance);
    }
  });
});

/**
 * F7 addition. Master-brief row 21 asks for a pipeline-builder skill whose
 * content is substantive, and NT-1's finding was that the renamed skill carried
 * none. That finding is now stale for rescue guidance — the block above proves
 * it — but the skill still had no reference for the DAG dialect it exists to
 * emit. These assertions pin the authoring corpus to the same canonical file the
 * rescue helper reads, so a later rename or trim cannot quietly drop it.
 */
describe("the authoring corpus the canonical skill points at", () => {
  const CORPUS_DIR = path.join(path.dirname(SKILL_PATH), "references", "recipes");
  const CORPUS = [
    "two-runtimes.md",
    "typed-node-vocabulary.md",
    "legacy-dialect-nodes.md",
    "variables-and-outputs.md",
    "good-practices.md",
    "example-pipelines.md",
  ];

  it("is indexed from the canonical SKILL.md the helper resolves", () => {
    const content = readCanonicalSkill();
    for (const file of CORPUS) {
      expect(content, `${file} must be indexed`).toContain(`references/recipes/${file}`);
    }
  });

  it("exists on disk beside the skill and is not a set of stubs", () => {
    expect(fs.readdirSync(CORPUS_DIR).sort()).toEqual([...CORPUS].sort());
    for (const file of CORPUS) {
      expect(
        fs.statSync(path.join(CORPUS_DIR, file)).size,
        `${file} must carry substance`,
      ).toBeGreaterThan(3_000);
    }
  });

  it("names the capability split that makes the rest of it usable", () => {
    const twoRuntimes = fs.readFileSync(path.join(CORPUS_DIR, "two-runtimes.md"), "utf8");
    expect(twoRuntimes).toContain("Typed runtime");
    expect(twoRuntimes).toContain("Vendored pipeline engine");
    expect(twoRuntimes).toContain("settings.skills.list");
  });
});
