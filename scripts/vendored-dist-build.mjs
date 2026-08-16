#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkVendoredDist,
  printVendoredDistStatus,
} from "./vendored-dist-check.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const vendoredRoot = path.join(repositoryRoot, "server", "vendor", "pipeline-engine");

function parseArguments(argv) {
  let mode = "force";
  for (const argument of argv) {
    if (argument === "--if-stale") {
      if (mode === "force-explicit") throw new Error("--if-stale and --force are mutually exclusive.");
      mode = "if-stale";
    } else if (argument === "--force") {
      if (mode === "if-stale") throw new Error("--if-stale and --force are mutually exclusive.");
      mode = "force-explicit";
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { ifStale: mode === "if-stale" };
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

const beforeBuild = checkVendoredDist(repositoryRoot);
if (options.ifStale && beforeBuild.ok) {
  printVendoredDistStatus(beforeBuild);
  console.log("vendored-dist-build: SKIP (dist is already fresh)");
  process.exit(0);
}

if (options.ifStale) printVendoredDistStatus(beforeBuild);
console.log(`vendored-dist-build: running \`bun run build:web\` in ${vendoredRoot}`);
const build = spawnSync("bun", ["run", "build:web"], {
  cwd: vendoredRoot,
  env: process.env,
  stdio: "inherit",
});
if (build.error) fail(`could not start bun: ${build.error.message}`, 1);
if (build.status !== 0) {
  if (build.signal) console.error(`vendored-dist-build: build terminated by ${build.signal}`);
  process.exit(build.status ?? 1);
}

const afterBuild = checkVendoredDist(repositoryRoot);
printVendoredDistStatus(afterBuild);
if (!afterBuild.ok) fail("build completed but the vendored dist is still missing or stale");
console.log("vendored-dist-build: PASS");

