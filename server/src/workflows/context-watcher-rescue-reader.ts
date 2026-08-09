import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ProjectPaths } from "../projects.ts";
import { apiRelative, isWithin } from "../sandbox-fs.ts";
import { scientificDagStudioSkillPath } from "../agent/dag-fusion-bridge.ts";

export const WORKFLOW_RESCUE_READ_TOOL = "workflow_rescue_read";
export const WORKFLOW_RESCUE_READ_MAX_BYTES = 256 * 1024;

const RUN_ID_PATTERN = /^wrun_[a-f0-9]{32}$/;
const ALLOWED_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".lean",
  ".log",
  ".md",
  ".py",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const WorkflowRescueReadParams = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
  },
  { additionalProperties: false },
);

type WorkflowRescueReadInput = Static<typeof WorkflowRescueReadParams>;

export type WorkflowRescueReadErrorCode =
  | "INVALID_RUN_ID"
  | "PATH_DENIED"
  | "PATH_UNSAFE"
  | "TYPE_DENIED"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "CHANGED_DURING_READ";

export class WorkflowRescueReadError extends Error {
  constructor(readonly code: WorkflowRescueReadErrorCode, message: string) {
    super(message);
    this.name = "WorkflowRescueReadError";
  }
}

export interface WorkflowRescueReadOptions {
  skillPath?: string;
  maximumBytes?: number;
}

export interface WorkflowRescueReadResult {
  content: string;
  bytes: number;
  source: "run-artifact" | "scientific-dag-studio-skill";
  displayPath: string;
}

function fail(code: WorkflowRescueReadErrorCode, message: string): never {
  throw new WorkflowRescueReadError(code, message);
}

export function workflowRescueArtifactsDir(
  paths: Pick<ProjectPaths, "workflowRunsDir">,
  runId: string,
): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    return fail("INVALID_RUN_ID", "Workflow Rescue requires an exact native run id.");
  }
  return path.join(paths.workflowRunsDir, runId, "artifacts");
}

function assertAllowedType(file: string): void {
  if (!ALLOWED_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    fail("TYPE_DENIED", "Workflow Rescue may read only bounded text artifact types.");
  }
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = apiRelative(root, target);
  if (!relative || relative === ".." || relative.startsWith("../")) {
    fail("PATH_UNSAFE", "Workflow Rescue artifact path escapes its run directory.");
  }
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail("NOT_FOUND", "Workflow Rescue artifact does not exist.");
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      fail("PATH_UNSAFE", "Workflow Rescue refuses symbolic-link artifact paths.");
    }
  }
}

function noFollowFlag(): number {
  const flag = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;
  return typeof flag === "number" ? flag : 0;
}

function readStableTextFile(
  file: string,
  maximumBytes: number,
  source: WorkflowRescueReadResult["source"],
  displayPath: string,
  allowedRoot?: string,
): WorkflowRescueReadResult {
  assertAllowedType(file);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return fail("PATH_UNSAFE", "Workflow Rescue requires a single-link regular file.");
    }
    const openedRealPath = fs.realpathSync(file);
    const openedPathStats = fs.lstatSync(openedRealPath);
    if (
      openedPathStats.dev !== before.dev ||
      openedPathStats.ino !== before.ino ||
      (allowedRoot && !isWithin(allowedRoot, openedRealPath))
    ) {
      return fail("PATH_UNSAFE", "Workflow Rescue file identity escaped its allowed root.");
    }
    if (before.size > maximumBytes) {
      return fail(
        "TOO_LARGE",
        `Workflow Rescue files cannot exceed ${maximumBytes} bytes.`,
      );
    }
    const content = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      Buffer.byteLength(content, "utf8") !== before.size
    ) {
      return fail("CHANGED_DURING_READ", "Workflow Rescue artifact changed during read.");
    }
    return { content, bytes: before.size, source, displayPath };
  } catch (error) {
    if (error instanceof WorkflowRescueReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fail("NOT_FOUND", "Workflow Rescue file does not exist.");
    }
    return fail("PATH_UNSAFE", "Workflow Rescue could not safely open the requested file.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Read only the exact canonical skill file or a relative file beneath this
 * run's private artifacts directory. Every other absolute path is rejected
 * before filesystem resolution.
 */
export function readWorkflowRescueFile(
  paths: Pick<ProjectPaths, "workflowRunsDir">,
  runId: string,
  requestedPath: string,
  options: WorkflowRescueReadOptions = {},
): WorkflowRescueReadResult {
  if (!requestedPath || requestedPath.includes("\0")) {
    return fail("PATH_DENIED", "Workflow Rescue read path is invalid.");
  }
  const maximumBytes = options.maximumBytes ?? WORKFLOW_RESCUE_READ_MAX_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return fail("PATH_DENIED", "Workflow Rescue read byte limit is invalid.");
  }
  const skillPath = path.resolve(options.skillPath ?? scientificDagStudioSkillPath());
  const requestedAbsolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : undefined;
  if (requestedAbsolute) {
    if (requestedPath !== skillPath || requestedAbsolute !== skillPath) {
      return fail(
        "PATH_DENIED",
        "Workflow Rescue denies every absolute path except its canonical skill file.",
      );
    }
    let skillStats: fs.Stats;
    try {
      skillStats = fs.lstatSync(skillPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fail("NOT_FOUND", "The canonical Scientific DAG Studio skill is missing.");
      }
      throw error;
    }
    if (
      skillStats.isSymbolicLink() ||
      !skillStats.isFile() ||
      fs.realpathSync(skillPath) !== skillPath
    ) {
      return fail("PATH_UNSAFE", "The canonical Scientific DAG Studio skill is unsafe.");
    }
    return readStableTextFile(
      skillPath,
      maximumBytes,
      "scientific-dag-studio-skill",
      "scientific-dag-studio/SKILL.md",
    );
  }
  if (/^(?:~|\$HOME)(?:[/\\]|$)/.test(requestedPath)) {
    return fail("PATH_DENIED", "Workflow Rescue denies home-relative paths.");
  }

  workflowRescueArtifactsDir(paths, runId);
  let workflowRunsStats: fs.Stats;
  try {
    workflowRunsStats = fs.lstatSync(paths.workflowRunsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fail("NOT_FOUND", "The workflow runs directory is missing.");
    }
    throw error;
  }
  if (workflowRunsStats.isSymbolicLink() || !workflowRunsStats.isDirectory()) {
    return fail("PATH_UNSAFE", "The workflow runs directory is unsafe.");
  }
  const realWorkflowRunsDir = fs.realpathSync(paths.workflowRunsDir);
  const artifactsDir = path.join(realWorkflowRunsDir, runId, "artifacts");
  let artifactsStats: fs.Stats;
  try {
    artifactsStats = fs.lstatSync(artifactsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fail("NOT_FOUND", "This workflow run has no readable artifacts directory.");
    }
    throw error;
  }
  if (artifactsStats.isSymbolicLink() || !artifactsStats.isDirectory()) {
    return fail("PATH_UNSAFE", "The workflow run artifacts directory is unsafe.");
  }
  assertNoSymlinkComponents(realWorkflowRunsDir, artifactsDir);
  const realArtifactsDir = fs.realpathSync(artifactsDir);
  if (!isWithin(realWorkflowRunsDir, realArtifactsDir)) {
    return fail("PATH_UNSAFE", "The workflow run artifacts directory escaped its root.");
  }
  const target = path.resolve(realArtifactsDir, requestedPath);
  if (!isWithin(realArtifactsDir, target) || target === realArtifactsDir) {
    return fail("PATH_DENIED", "Workflow Rescue artifact path escapes its run directory.");
  }
  assertNoSymlinkComponents(realArtifactsDir, target);
  const realTarget = fs.realpathSync(target);
  if (!isWithin(realArtifactsDir, realTarget)) {
    return fail("PATH_UNSAFE", "Workflow Rescue artifact resolves outside its run directory.");
  }
  return readStableTextFile(
    realTarget,
    maximumBytes,
    "run-artifact",
    apiRelative(realArtifactsDir, realTarget),
    realArtifactsDir,
  );
}

export function makeWorkflowRescueReader(
  paths: Pick<ProjectPaths, "workflowRunsDir">,
  runId: string,
  options: WorkflowRescueReadOptions = {},
) {
  return defineTool({
    name: WORKFLOW_RESCUE_READ_TOOL,
    label: "Workflow Rescue Read",
    description: [
      "Read one bounded text file for the selected workflow rescue.",
      "Relative paths resolve only inside that run's artifacts directory.",
      "The sole permitted absolute path is the canonical Scientific DAG Studio SKILL.md supplied in your system prompt.",
    ].join(" "),
    promptSnippet:
      "workflow_rescue_read: read the canonical Scientific DAG Studio skill or one selected-run artifact",
    promptGuidelines: [
      "Use only the canonical skill path from the system prompt or a relative selected-run artifact path.",
      "Do not request credentials, home-directory files, or files from another run.",
    ],
    parameters: WorkflowRescueReadParams,
    async execute(_toolCallId: string, input: WorkflowRescueReadInput) {
      const result = readWorkflowRescueFile(paths, runId, input.path, options);
      return {
        content: [{ type: "text" as const, text: result.content }],
        details: {
          source: result.source,
          path: result.displayPath,
          bytes: result.bytes,
        },
      };
    },
  });
}
