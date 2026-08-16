#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureVendoredDistBuildContext,
  checkVendoredDist,
  printVendoredDistStatus,
  writeVendoredDistManifest,
} from "./vendored-dist-check.mjs";
import { scrubSensitiveEnvironment } from "./vendored-dist-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

function parseArguments(argv) {
  let mode = "force";
  let root = defaultRepositoryRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--if-stale") {
      if (mode === "force-explicit") throw new Error("--if-stale and --force are mutually exclusive.");
      mode = "if-stale";
    } else if (argument === "--force") {
      if (mode === "if-stale") throw new Error("--if-stale and --force are mutually exclusive.");
      mode = "force-explicit";
    } else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a path.");
      root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { ifStale: mode === "if-stale", root };
}

function fail(message, exitCode = 1) {
  console.error(`vendored-dist-build: FAIL (${message})`);
  process.exit(exitCode);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}

const buildEnvironment = scrubSensitiveEnvironment(process.env);
const vendoredRoot = path.join(options.root, "server", "vendor", "pipeline-engine");
const beforeBuild = checkVendoredDist(options.root, buildEnvironment);
if (options.ifStale && beforeBuild.ok) {
  printVendoredDistStatus(beforeBuild);
  console.log("vendored-dist-build: SKIP (dist manifest and outputs are already valid)");
  process.exit(0);
}

if (options.ifStale) printVendoredDistStatus(beforeBuild);
let buildContext;
try {
  buildContext = captureVendoredDistBuildContext(options.root, buildEnvironment);
} catch (error) {
  fail(`build inputs could not be fingerprinted: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`vendored-dist-build: running \`bun run build:web\` in ${vendoredRoot}`);
const build = spawnSync("bun", ["run", "build:web"], {
  cwd: vendoredRoot,
  env: buildEnvironment,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.error) fail(`could not start bun: ${build.error.message}`, 1);
if (build.status !== 0) {
  if (build.signal) console.error(`vendored-dist-build: build terminated by ${build.signal}`);
  process.exit(build.status ?? 1);
}

try {
  writeVendoredDistManifest(options.root, buildEnvironment, buildContext);
} catch (error) {
  fail(`build completed but the manifest could not be written: ${error instanceof Error ? error.message : String(error)}`);
}

const afterBuild = checkVendoredDist(options.root, buildEnvironment);
printVendoredDistStatus(afterBuild);
if (!afterBuild.ok) {
  fail(`build completed but full manifest/output validation failed (${afterBuild.status}: ${afterBuild.message})`);
}
console.log("vendored-dist-build: PASS");
