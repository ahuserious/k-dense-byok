#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRONG_REASON_PATTERNS = [
  /No test files found/i,
  /Failed to load (?:config|url|custom Reporter)/i,
  /Startup Error/i,
  /Cannot find (?:module|package)/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Failed to resolve import/i,
  /Transform failed/i,
  /test suite failed to (?:run|collect)/i,
  /collection error/i,
];

function parseExpectedRegex(value) {
  const literal = value.match(/^\/(.*)\/([dgimsuvy]*)$/);
  try {
    return literal ? new RegExp(literal[1], literal[2]) : new RegExp(value, "i");
  } catch (error) {
    throw new Error(`Invalid expected regex: ${error.message}`);
  }
}

function parseArguments(argv) {
  const explainIndex = argv.indexOf("--explain");
  const explain = explainIndex !== -1;
  const positional = argv.filter((argument) => argument !== "--explain");
  if (positional.length !== 3) {
    throw new Error(
      "Usage: right-reason.mjs <testfile> <base> <expected-regex> [--explain]",
    );
  }
  const [testfile, base, expectedRegexText] = positional;
  if (path.isAbsolute(testfile)) throw new Error("testfile must be repository-relative");
  const normalizedTestfile = testfile.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalizedTestfile.includes("../") ||
    !(normalizedTestfile.startsWith("server/test/") || normalizedTestfile.startsWith("web/src/")) ||
    !normalizedTestfile.endsWith(".test.ts") && !normalizedTestfile.endsWith(".test.tsx")
  ) {
    throw new Error("testfile must be a server/test or web/src .test.ts/.test.tsx file");
  }
  const absoluteTestfile = path.join(repoRoot, normalizedTestfile);
  if (!fs.statSync(absoluteTestfile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Test file does not exist at HEAD: ${normalizedTestfile}`);
  }
  if (!base.trim() || base.startsWith("-")) throw new Error("base must be a commit-ish");
  return {
    explain,
    testfile: normalizedTestfile,
    absoluteTestfile,
    base,
    expectedRegexText,
    expectedRegex: parseExpectedRegex(expectedRegexText),
  };
}

function packageForTest(testfile, root) {
  const packageName = testfile.startsWith("server/") ? "server" : "web";
  const packageRoot = path.join(root, packageName);
  return {
    packageName,
    packageRoot,
    relativeTestfile: path.relative(packageRoot, path.join(root, testfile)),
  };
}

function vitestExecutable(packageRoot) {
  const executable = path.join(
    packageRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  if (!fs.existsSync(executable)) throw new Error(`Vitest executable is missing: ${executable}`);
  return executable;
}

function linkNodeModules(sourceRoot, worktreeRoot, packageName) {
  const source = path.join(sourceRoot, packageName, "node_modules");
  const target = path.join(worktreeRoot, packageName, "node_modules");
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Cannot link missing dependency directory: ${source}`);
  }
  if (fs.existsSync(target)) throw new Error(`Refusing to replace existing dependency path: ${target}`);
  fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

function runSingleTest(root, testfile) {
  const packageInfo = packageForTest(testfile, root);
  const executable = vitestExecutable(packageInfo.packageRoot);
  const result = spawnSync(
    executable,
    ["run", packageInfo.relativeTestfile, "--configLoader", "runner"],
    {
      cwd: packageInfo.packageRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export function assertExpectedFailure(result, expectedRegex) {
  if (result.status === 0) throw new Error("Base test unexpectedly passed; the test does not prove the regression");
  const wrongReason = WRONG_REASON_PATTERNS.find((pattern) => pattern.test(result.output));
  if (wrongReason) {
    throw new Error(`Base test failed for an import/collection reason (${wrongReason}):\n${result.output}`);
  }
  if (!expectedRegex.test(result.output)) {
    throw new Error(`Base failure did not match ${expectedRegex}:\n${result.output}`);
  }
}

export function assertHeadPass(result) {
  if (result.status !== 0) {
    throw new Error(`HEAD test did not pass (status=${result.status}, signal=${result.signal ?? "none"}):\n${result.output}`);
  }
}

function explainPlan(options) {
  const packageInfo = packageForTest(options.testfile, "<throwaway-worktree>");
  console.log("right-reason: EXPLAIN ONLY — no Git command or test process was executed");
  console.log(`1. git worktree add --detach <repo>/.r1-worktrees/right-reason-* ${options.base}`);
  console.log(`2. copy HEAD ${options.testfile} into the detached base worktree`);
  console.log(`3. symlink ${packageInfo.packageName}/node_modules when the target is absent`);
  console.log(`4. run only ${packageInfo.relativeTestfile} at base; require nonzero status matching ${options.expectedRegex}`);
  console.log("5. reject startup, import-resolution, transform, no-test, and collection failures");
  console.log(`6. run only ${options.testfile} at HEAD; require status 0`);
  console.log("7. git worktree remove --force in finally");
}

function removeWorktree(worktree) {
  execFileSync("git", ["worktree", "remove", "--force", worktree], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parent = path.dirname(worktree);
  try {
    fs.rmdirSync(parent);
  } catch {
    // Other concurrent right-reason runs may still own sibling worktrees.
  }
}

function execute(options) {
  const parent = path.join(repoRoot, ".r1-worktrees");
  const worktree = path.join(
    parent,
    `right-reason-${process.pid}-${Date.now().toString(36)}`,
  );
  fs.mkdirSync(parent, { recursive: true });
  let added = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, options.base], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    added = true;
    const packageName = packageForTest(options.testfile, repoRoot).packageName;
    linkNodeModules(repoRoot, worktree, packageName);
    const baseTestfile = path.join(worktree, options.testfile);
    fs.mkdirSync(path.dirname(baseTestfile), { recursive: true });
    fs.copyFileSync(options.absoluteTestfile, baseTestfile);

    const baseResult = runSingleTest(worktree, options.testfile);
    assertExpectedFailure(baseResult, options.expectedRegex);
    console.log(`right-reason: base failure matched ${options.expectedRegex}`);

    const headResult = runSingleTest(repoRoot, options.testfile);
    assertHeadPass(headResult);
    console.log("right-reason: PASS — expected base failure and HEAD pass observed");
  } finally {
    if (added) removeWorktree(worktree);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.explain) explainPlan(options);
  else execute(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`right-reason: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
