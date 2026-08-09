import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_RESCUE_READ_TOOL,
  WorkflowRescueReadError,
  makeWorkflowRescueReader,
  readWorkflowRescueFile,
  workflowRescueArtifactsDir,
} from "../src/workflows/context-watcher-rescue-reader.ts";
import { scientificDagStudioSkillPath } from "../src/agent/dag-fusion-bridge.ts";

const roots: string[] = [];
const RUN_ID = `wrun_${"a".repeat(32)}`;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-rescue-reader-"));
  roots.push(root);
  const paths = { workflowRunsDir: path.join(root, "runs") };
  const artifactsDir = workflowRescueArtifactsDir(paths, RUN_ID);
  fs.mkdirSync(artifactsDir, { recursive: true });
  return { root, paths, artifactsDir };
}

function expectDenied(callback: () => unknown, code: WorkflowRescueReadError["code"]): void {
  expect(callback).toThrowError(expect.objectContaining({ code }));
}

describe("Workflow Rescue confined reader", () => {
  it("registers a custom reader rather than Pi's unrestricted built-in read", () => {
    const { paths } = setup();
    const tool = makeWorkflowRescueReader(paths, RUN_ID);
    expect(tool.name).toBe(WORKFLOW_RESCUE_READ_TOOL);
    expect(tool.name).not.toBe("read");
  });

  it("denies operating-system, home, and home-relative paths", () => {
    const { paths } = setup();
    expectDenied(() => readWorkflowRescueFile(paths, RUN_ID, "/etc/hosts"), "PATH_DENIED");
    expectDenied(
      () => readWorkflowRescueFile(paths, RUN_ID, path.join(os.homedir(), ".env")),
      "PATH_DENIED",
    );
    expectDenied(() => readWorkflowRescueFile(paths, RUN_ID, "~/.env"), "PATH_DENIED");
  });

  it("denies a symlink that escapes the selected run artifacts directory", () => {
    const { root, paths, artifactsDir } = setup();
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(artifactsDir, "escape.txt"));

    expectDenied(
      () => readWorkflowRescueFile(paths, RUN_ID, "escape.txt"),
      "PATH_UNSAFE",
    );
  });

  it("reads an allowed in-run text artifact", () => {
    const { paths, artifactsDir } = setup();
    fs.writeFileSync(path.join(artifactsDir, "failure.json"), '{"code":"E_TEST"}\n');

    expect(readWorkflowRescueFile(paths, RUN_ID, "failure.json")).toEqual({
      content: '{"code":"E_TEST"}\n',
      bytes: 18,
      source: "run-artifact",
      displayPath: "failure.json",
    });
  });

  it("reads only the canonical Scientific DAG Studio absolute skill path", () => {
    const { paths } = setup();
    const result = readWorkflowRescueFile(
      paths,
      RUN_ID,
      scientificDagStudioSkillPath(),
    );
    expect(result.source).toBe("scientific-dag-studio-skill");
    expect(result.displayPath).toBe("scientific-dag-studio/SKILL.md");
    expect(result.content).toContain("# Scientific DAG Studio");
    expectDenied(
      () => readWorkflowRescueFile(
        paths,
        RUN_ID,
        `${path.dirname(scientificDagStudioSkillPath())}/../scientific-dag-studio/SKILL.md`,
      ),
      "PATH_DENIED",
    );
  });

  it("enforces the byte cap before returning content", () => {
    const { paths, artifactsDir } = setup();
    fs.writeFileSync(path.join(artifactsDir, "large.txt"), "123456789");

    expectDenied(
      () => readWorkflowRescueFile(
        paths,
        RUN_ID,
        "large.txt",
        { maximumBytes: 8 },
      ),
      "TOO_LARGE",
    );
  });
});
