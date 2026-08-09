import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  ProjectTrustStore,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  dagFusionPackageDir,
  scientificDagStudioSkillPath,
  seedDagFusionPackage,
} from "../src/agent/dag-fusion-bridge.ts";

const LEAN_TOOLCHAIN = "leanprover/lean4:v4.32.2";
const MATHLIB_REVISION = "1".repeat(40);

function verifierScript(): string {
  return path.join(
    dagFusionPackageDir(),
    "skills",
    "byom-dag-fusion",
    "scripts",
    "verify-lean4.mjs",
  );
}

function verifierHelper(name: string): string {
  return path.join(
    dagFusionPackageDir(),
    "skills",
    "byom-dag-fusion",
    "scripts",
    name,
  );
}

function createPinnedLakeProject(root: string, revision = MATHLIB_REVISION): string {
  const project = path.join(root, "proof-project");
  const mathlib = path.join(project, ".lake", "packages", "mathlib");
  fs.mkdirSync(path.join(mathlib, ".git"), { recursive: true });
  fs.writeFileSync(path.join(project, "lean-toolchain"), `${LEAN_TOOLCHAIN}\n`);
  fs.writeFileSync(path.join(project, "lakefile.toml"), 'name = "proof"\n');
  fs.writeFileSync(
    path.join(project, "lake-manifest.json"),
    JSON.stringify({
      lakeDir: ".lake",
      packages: [{
        name: "mathlib",
        type: "git",
        url: "https://github.com/leanprover-community/mathlib4.git",
        rev: revision,
      }],
    }),
  );
  fs.writeFileSync(path.join(mathlib, "Mathlib.lean"), "import Mathlib.Algebra.Algebra.Basic\n");
  fs.writeFileSync(path.join(mathlib, ".git", "HEAD"), `${revision}\n`);
  return project;
}

function createFakeElan(
  root: string,
  axiomResult = "'claim' does not depend on any axioms",
): string {
  const elanHome = path.join(root, "trusted-elan");
  const elan = path.join(elanHome, "bin", "elan");
  fs.mkdirSync(path.dirname(elan), { recursive: true });
  fs.writeFileSync(
    elan,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'if [ "$1" = "toolchain" ] && [ "$2" = "list" ]; then',
      `  printf '%s\\n' '${LEAN_TOOLCHAIN}'`,
      "  exit 0",
      "fi",
      `if [ "$1" = "run" ] && [ "$2" = "${LEAN_TOOLCHAIN}" ] && [ "$3" = "lake" ] && [ "$4" = "--version" ]; then`,
      "  printf '%s\\n' 'Lake version 5.0.0 (Lean version 4.32.2)'",
      "  exit 0",
      "fi",
      `if [ "$1" = "run" ] && [ "$2" = "${LEAN_TOOLCHAIN}" ] && [ "$3" = "lake" ] && [ "$4" = "env" ] && [ "$5" = "lean" ]; then`,
      "  marker=''",
      "  while IFS= read -r line; do",
      "    case \"$line\" in",
      "      *BYOM_*_BEGIN*) marker=${line#*\\\"}; marker=${marker%_BEGIN\\\"*}; break ;;",
      "    esac",
      "  done < \"$6\"",
      "  [ -n \"$marker\" ]",
      "  printf '%s_BEGIN\\n' \"$marker\"",
      `  printf '%s\\n' ${JSON.stringify(axiomResult)}`,
      "  printf '%s_END\\n' \"$marker\"",
      "  exit 0",
      "fi",
      "exit 70",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return elanHome;
}

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(reset);
afterAll(reset);

describe("dag-fusion-drive package", () => {
  it("exposes the committed Scientific DAG Studio skill to the rescue session", () => {
    const skillPath = scientificDagStudioSkillPath();
    expect(skillPath).toBe(path.join(
      path.resolve(import.meta.dirname, ".."),
      "seed",
      "skills",
      "scientific-dag-studio",
      "SKILL.md",
    ));
    expect(fs.readFileSync(skillPath, "utf8")).toContain("# Scientific DAG Studio");
  });

  it("loads the byom-dag-fusion skill without diagnostics", () => {
    const result = loadSkillsFromDir({
      dir: path.join(dagFusionPackageDir(), "skills"),
      source: "package",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toContain("byom-dag-fusion");
  });

  it("stays private and packs runtime skill files without eval fixtures", () => {
    const packageDirectory = dagFusionPackageDir();
    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
    ) as { private?: boolean; version?: string };
    expect(packageManifest.private).toBe(true);
    expect(packageManifest.version).toMatch(/-dev\./);

    const packed = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const reports = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const packedPaths = reports[0]?.files.map((entry) => entry.path) ?? [];
    expect(packedPaths).toContain("runtime-contract.ts");
    expect(packedPaths).toContain("skills/byom-dag-fusion/SKILL.md");
    expect(packedPaths).toContain(
      "skills/byom-dag-fusion/scripts/verify-lean4.mjs",
    );
    expect(packedPaths.some((entry) => entry.includes("/evals/"))).toBe(false);
    expect(packedPaths.some((entry) => /(^|\/)test(s|[-_.\/])/.test(entry))).toBe(false);
  });

  it("seeds one canonical package path while preserving user packages", () => {
    const paths = ensureProjectExists("dag-package-test");
    const piDir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({ packages: ["user-package", "/stale/dag-fusion-drive"] }),
    );

    expect(seedDagFusionPackage(paths)).toBe(true);
    expect(seedDagFusionPackage(paths)).toBe(false);
    const settings = JSON.parse(
      fs.readFileSync(path.join(piDir, "settings.json"), "utf-8"),
    ) as { packages: string[] };
    expect(settings.packages).toEqual(["user-package", dagFusionPackageDir()]);
  });

  it("is discovered through the same project package settings Pi uses", async () => {
    const paths = ensureProjectExists("dag-loader-test");
    const agentDir = path.join(paths.root, "pi-agent");
    new ProjectTrustStore(agentDir).set(paths.sandbox, true);
    seedDagFusionPackage(paths);
    const loader = new DefaultResourceLoader({
      cwd: paths.sandbox,
      agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    expect(
      loaded.diagnostics.filter((diagnostic) =>
        diagnostic.path?.startsWith(dagFusionPackageDir()),
      ),
    ).toEqual([]);
    expect(loaded.skills.map((skill) => skill.name)).toContain("byom-dag-fusion");
  });

  it("rejects admitted proofs before invoking Lean", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-reject-"));
    const source = path.join(root, "Claim.lean");
    fs.writeFileSync(source, "theorem claim : True := by sorry\n");
    fs.writeFileSync(path.join(root, "lean-toolchain"), `${LEAN_TOOLCHAIN}\n`);
    fs.writeFileSync(path.join(root, "lakefile.toml"), "name = \"proof\"\n");
    const result = spawnSync(process.execPath, [verifierScript(), source, "claim", root], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain("forbidden token sorry");
  });

  it("does not mistake comments or strings for admitted proof tokens", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-comments-"));
    const source = path.join(root, "Claim.lean");
    fs.writeFileSync(
      source,
      [
        "-- Never use sorry or axiom here.",
        "/- Nested /- admit -/ comments are not declarations. -/",
        'def explanation := "sorry axiom admit"',
        "theorem claim : True := by trivial",
        "",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [
      verifierHelper("scan-lean-source.mjs"),
      source,
      "claim",
    ], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
  });

  it("rejects task-controlled Elan trust-root overrides", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-override-"));
    const project = createPinnedLakeProject(root);
    const source = path.join(root, "Claim.lean");
    fs.writeFileSync(source, "theorem claim : True := by trivial\n");
    const fakeElanHome = createFakeElan(root);
    const result = spawnSync(process.execPath, [verifierScript(), source, "claim", project], {
      encoding: "utf-8",
      env: { ...process.env, BYOM_DAG_FUSION_ELAN_HOME: fakeElanHome },
    });
    expect(result.status).toBe(66);
    expect(result.stderr).toContain("task-controlled Elan overrides are not accepted");
    expect(result.stdout).not.toContain("Lake version 5.0.0");
  });

  it("requires the named theorem to be declared by the admitted source", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-theorem-"));
    const source = path.join(root, "Claim.lean");
    fs.writeFileSync(source, "theorem claim : True := by trivial\n");
    const result = spawnSync(
      process.execPath,
      [verifierScript(), source, "differentClaim", root],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(65);
    expect(result.stderr).toContain("named theorem differentClaim is not declared");
  });

  it("rejects Mathlib revision drift before invoking Lean", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-mathlib-"));
    const project = createPinnedLakeProject(root);
    fs.writeFileSync(
      path.join(project, ".lake", "packages", "mathlib", ".git", "HEAD"),
      `${"2".repeat(40)}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        verifierHelper("inspect-lake-project.mjs"),
        path.join(project, "lake-manifest.json"),
        path.join(project, ".lake", "packages", "mathlib"),
      ],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match manifest");
  });

  it("rejects theorem dependencies outside Lean's standard foundational axioms", () => {
    const root = fs.mkdtempSync(path.join(PROJECTS_ROOT, "lean-axioms-"));
    const output = path.join(root, "lean-output.log");
    const marker = "BYOM_TEST_MARKER";
    fs.writeFileSync(
      output,
      `${marker}_BEGIN\n'claim' depends on axioms: [propext, Research.unchecked]\n${marker}_END\n`,
    );
    const result = spawnSync(
      process.execPath,
      [verifierHelper("check-lean-axioms.mjs"), output, "claim", marker],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported axioms: Research.unchecked");
  });
});
