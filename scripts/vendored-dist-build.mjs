#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureVendoredDistBuildContext,
  checkVendoredDist,
  printVendoredDistStatus,
  vendoredInstallStatus,
  writeVendoredInstallStamp,
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

function acquireBuildLock(vendoredRoot) {
  const lockDirectory = path.join(vendoredRoot, "node_modules");
  const lockPath = path.join(lockDirectory, ".vendored-dist-build.lock");
  fs.mkdirSync(lockDirectory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      fs.closeSync(descriptor);
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs <= 10 * 60 * 1000 || attempt > 0) {
        fail(`another vendored dist build holds ${lockPath}`);
      }
      console.warn(`vendored-dist-build: WARNING reclaiming stale build lock older than 10 minutes: ${lockPath}`);
      fs.unlinkSync(lockPath);
    }
  }
  fail(`could not acquire vendored dist build lock: ${lockPath}`);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}

const buildEnvironment = scrubSensitiveEnvironment(process.env);
const vendoredRoot = path.join(options.root, "server", "vendor", "pipeline-engine");
const buildLockPath = acquireBuildLock(vendoredRoot);
let buildLockHeld = true;
function releaseBuildLock() {
  if (!buildLockHeld) return;
  buildLockHeld = false;
  try {
    fs.unlinkSync(buildLockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`vendored-dist-build: could not release build lock: ${error.message}`);
  }
}
process.on("exit", releaseBuildLock);

let installStatus;
try {
  installStatus = vendoredInstallStatus(options.root, buildEnvironment);
} catch (error) {
  fail(`dependency install stamp could not be computed: ${error instanceof Error ? error.message : String(error)}`);
}
if (installStatus.needsInstall) {
  console.log(`vendored-dist-build: dependency stamp stale; running \`bun install --frozen-lockfile\` in ${vendoredRoot}`);
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: vendoredRoot,
    env: buildEnvironment,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.error) fail(`could not start bun install: ${install.error.message}`);
  if (install.status !== 0) process.exit(install.status ?? 1);
  try {
    writeVendoredInstallStamp(options.root, buildEnvironment);
  } catch (error) {
    fail(`dependencies installed but the install stamp could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`vendored-dist-build: dependency stamp written to ${installStatus.path}`);
}

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

let afterBuildContext;
try {
  afterBuildContext = captureVendoredDistBuildContext(options.root, buildEnvironment);
} catch (error) {
  fail(`post-build inputs could not be fingerprinted: ${error instanceof Error ? error.message : String(error)}`);
}
if (
  buildContext.inputsSha256 !== afterBuildContext.inputsSha256 ||
  buildContext.gitHead !== afterBuildContext.gitHead ||
  JSON.stringify(buildContext.buildEnv) !== JSON.stringify(afterBuildContext.buildEnv) ||
  buildContext.installStampSha256 !== afterBuildContext.installStampSha256
) {
  fail(
    `build inputs changed while Bun was running; manifest not written ` +
      `(before ${buildContext.inputsSha256}, after ${afterBuildContext.inputsSha256})`,
  );
}

try {
  writeVendoredDistManifest(options.root, buildEnvironment, afterBuildContext);
} catch (error) {
  fail(`build completed but the manifest could not be written: ${error instanceof Error ? error.message : String(error)}`);
}

const afterBuild = checkVendoredDist(options.root, buildEnvironment);
printVendoredDistStatus(afterBuild);
if (!afterBuild.ok) {
  fail(`build completed but full manifest/output validation failed (${afterBuild.status}: ${afterBuild.message})`);
}
releaseBuildLock();
console.log("vendored-dist-build: PASS");
