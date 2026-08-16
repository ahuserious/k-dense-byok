#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureVendoredDistBuildContext,
  checkVendoredDist,
  expectedVendoredInstallStamp,
  printVendoredDistStatus,
  validateVendoredDistOutputTree,
  vendoredInstallStatus,
  writeVendoredInstallStamp,
  writeVendoredDistManifest,
} from "./vendored-dist-check.mjs";
import {
  acquireVendoredDistBuildLock,
  scrubSensitiveEnvironment,
} from "./vendored-dist-environment.mjs";

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
  process.exitCode = exitCode;
  throw new Error("vendored-dist-build-failed");
}

function runCommand(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      ...options,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function sameBuildContext(before, after) {
  return (
    before.inputsSha256 === after.inputsSha256 &&
    before.gitHead === after.gitHead &&
    JSON.stringify(before.buildEnv) === JSON.stringify(after.buildEnv) &&
    before.installStampSha256 === after.installStampSha256
  );
}

function promoteStagingDirectory(stagingDirectory, distDirectory, token) {
  const backupDirectory = `${distDirectory}.previous-${token}`;
  let movedExisting = false;
  try {
    if (fs.existsSync(distDirectory)) {
      fs.renameSync(distDirectory, backupDirectory);
      movedExisting = true;
    }
    fs.renameSync(stagingDirectory, distDirectory);
    return { backupDirectory, movedExisting };
  } catch (error) {
    if (!fs.existsSync(distDirectory) && movedExisting && fs.existsSync(backupDirectory)) {
      fs.renameSync(backupDirectory, distDirectory);
    }
    throw error;
  }
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(`vendored-dist-build: FAIL (${error instanceof Error ? error.message : String(error)})`);
  process.exit(2);
}

const buildEnvironment = scrubSensitiveEnvironment(process.env);
const vendoredRoot = path.join(options.root, "server", "vendor", "pipeline-engine");
const webRoot = path.join(vendoredRoot, "packages", "web");
const distDirectory = path.join(webRoot, "dist");
let buildLock;
try {
  buildLock = await acquireVendoredDistBuildLock(options.root, {
    waitMs: Number(process.env.VENDORED_DIST_LOCK_WAIT_MS || 120_000),
  });
} catch (error) {
  console.error(`vendored-dist-build: FAIL (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}

let stagingDirectory = null;
try {
  let installStatus = vendoredInstallStatus(options.root, buildEnvironment);
  if (installStatus.needsInstall) {
    const installInputsBefore = expectedVendoredInstallStamp(options.root, buildEnvironment);
    console.log(`vendored-dist-build: dependency stamp stale; running \`bun install --frozen-lockfile\` in ${vendoredRoot}`);
    buildLock.assertOwned("dependency installation");
    const install = await runCommand("bun", ["install", "--frozen-lockfile"], {
      cwd: vendoredRoot,
      env: buildEnvironment,
    });
    if (install.code !== 0) fail(`bun install exited ${install.code}${install.signal ? ` (${install.signal})` : ""}`, install.code);
    const installInputsAfter = expectedVendoredInstallStamp(options.root, buildEnvironment);
    if (installInputsBefore.sha256 !== installInputsAfter.sha256) {
      fail("dependency inputs changed while bun install was running; install stamp not written");
    }
    writeVendoredInstallStamp(options.root, buildEnvironment);
    installStatus = vendoredInstallStatus(options.root, buildEnvironment);
    console.log(`vendored-dist-build: dependency stamp written to ${installStatus.path} and node_modules/.bun-install-stamp`);
  }

  const beforeBuild = checkVendoredDist(options.root, buildEnvironment);
  if (options.ifStale && beforeBuild.ok) {
    printVendoredDistStatus(beforeBuild);
    console.log("vendored-dist-build: SKIP (dist manifest and outputs are already valid)");
    console.log("vendored-dist-build: PASS");
  } else {
    if (options.ifStale) printVendoredDistStatus(beforeBuild);
    const buildContext = captureVendoredDistBuildContext(options.root, buildEnvironment);
    stagingDirectory = path.join(vendoredRoot, "node_modules", `.vendored-dist-stage-${buildLock.token}`);
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    console.log(`vendored-dist-build: running \`bun run build -- --outDir ${stagingDirectory}\` in ${webRoot}`);
    const build = await runCommand(
      "bun",
      ["run", "build", "--", "--outDir", stagingDirectory],
      { cwd: webRoot, env: buildEnvironment },
    );
    if (build.code !== 0) fail(`build exited ${build.code}${build.signal ? ` (${build.signal})` : ""}`, build.code);

    const afterBuildContext = captureVendoredDistBuildContext(options.root, buildEnvironment);
    if (!sameBuildContext(buildContext, afterBuildContext)) {
      fail(
        `build inputs changed while Bun was running; manifest not written ` +
          `(before ${buildContext.inputsSha256}, after ${afterBuildContext.inputsSha256})`,
      );
    }
    const manifest = writeVendoredDistManifest(
      options.root,
      buildEnvironment,
      afterBuildContext,
      stagingDirectory,
    );
    validateVendoredDistOutputTree(options.root, stagingDirectory, manifest);
    buildLock.assertOwned("dist promotion");
    const promotion = promoteStagingDirectory(stagingDirectory, distDirectory, buildLock.token);
    stagingDirectory = null;

    const afterBuild = checkVendoredDist(options.root, buildEnvironment);
    printVendoredDistStatus(afterBuild);
    if (!afterBuild.ok) {
      if (promotion.movedExisting && fs.existsSync(promotion.backupDirectory)) {
        const rejectedDirectory = `${distDirectory}.rejected-${buildLock.token}`;
        fs.renameSync(distDirectory, rejectedDirectory);
        fs.renameSync(promotion.backupDirectory, distDirectory);
        fs.rmSync(rejectedDirectory, { recursive: true, force: true });
      } else {
        fs.rmSync(distDirectory, { recursive: true, force: true });
      }
      fail(`build completed but full manifest/output validation failed (${afterBuild.status}: ${afterBuild.message})`);
    }
    if (promotion.movedExisting) {
      fs.rmSync(promotion.backupDirectory, { recursive: true, force: true });
    }
    console.log("vendored-dist-build: PASS");
  }
} catch (error) {
  if (error?.message !== "vendored-dist-build-failed") {
    console.error(`vendored-dist-build: FAIL (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  }
} finally {
  if (stagingDirectory) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  buildLock.release();
}
