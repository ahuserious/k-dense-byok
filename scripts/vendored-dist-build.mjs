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
  captureProcessIdentity,
  recoverVendoredDistBuildLock,
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
      if (mode !== "force") throw new Error("--if-stale, --force, and --recover-lock are mutually exclusive.");
      mode = "if-stale";
    } else if (argument === "--force") {
      if (mode !== "force") throw new Error("--if-stale, --force, and --recover-lock are mutually exclusive.");
      mode = "force-explicit";
    } else if (argument === "--recover-lock") {
      if (mode !== "force") throw new Error("--if-stale, --force, and --recover-lock are mutually exclusive.");
      mode = "recover-lock";
    } else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a path.");
      root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { ifStale: mode === "if-stale", recoverLock: mode === "recover-lock", root };
}

function fail(message, exitCode = 1) {
  console.error(`vendored-dist-build: FAIL (${message})`);
  process.exitCode = exitCode;
  throw new Error("vendored-dist-build-failed");
}

function runMutatingCommand(command, arguments_, options, buildLock, phase) {
  return new Promise((resolve, reject) => {
    const gatePath = path.join(path.dirname(buildLock.lockPath), `${buildLock.token}-${phase}.go`);
    fs.rmSync(gatePath, { force: true });
    const gateArguments = process.platform === "win32"
      ? [
          "--input-type=module",
          "-e",
          `import fs from "node:fs"; import { spawn } from "node:child_process";
const timer = setInterval(() => {
  if (!fs.existsSync(process.argv[1])) return;
  clearInterval(timer);
  const child = spawn(process.argv[2], JSON.parse(process.argv[3]), { stdio: "inherit", shell: true });
  child.once("exit", (code) => process.exit(code ?? 1));
}, 10);`,
          gatePath,
          command,
          JSON.stringify(arguments_),
        ]
      : [
          "-c",
          'while [ ! -f "$1" ]; do sleep 0.01; done; shift; exec "$@"',
          "kady-vendored-dist-gate",
          gatePath,
          command,
          ...arguments_,
        ];
    const child = spawn(process.platform === "win32" ? process.execPath : "sh", gateArguments, {
      ...options,
      stdio: "inherit",
      shell: false,
    });
    const cleanup = () => fs.rmSync(gatePath, { force: true });
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("spawn", () => {
      const identity = captureProcessIdentity(child.pid);
      if (!identity) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        cleanup();
        reject(new Error(`could not capture ${phase} worker identity`));
        return;
      }
      try {
        buildLock.publishWorker({
          pid: child.pid,
          identity,
          phase,
          startedAt: new Date().toISOString(),
        });
        fs.writeFileSync(gatePath, "go\n", { mode: 0o600, flag: "wx" });
      } catch (error) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        cleanup();
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      cleanup();
      try {
        buildLock.clearWorker(child.pid);
        resolve({ code: code ?? 1, signal });
      } catch (error) {
        reject(error);
      }
    });
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

function promoteStagingDirectory(stagingDirectory, distDirectory, token, assertOwned) {
  const backupDirectory = `${distDirectory}.previous-${token}`;
  let movedExisting = false;
  try {
    assertOwned("dist promotion start");
    if (fs.existsSync(distDirectory)) {
      fs.renameSync(distDirectory, backupDirectory);
      movedExisting = true;
      assertOwned("dist promotion after backup rename");
    }
    assertOwned("dist promotion before publish rename");
    fs.renameSync(stagingDirectory, distDirectory);
    assertOwned("dist promotion after publish rename");
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
if (options.recoverLock) {
  try {
    const result = await recoverVendoredDistBuildLock(options.root);
    if (result.recovered) {
      console.log(`vendored-dist-build: recovered lock owned by pid ${result.record.pid}`);
    } else {
      console.log("vendored-dist-build: no build lock exists");
    }
    console.log("vendored-dist-build: PASS");
    process.exit(0);
  } catch (error) {
    console.error(`vendored-dist-build: FAIL (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  }
}
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
    const install = await runMutatingCommand("bun", ["install", "--frozen-lockfile"], {
      cwd: vendoredRoot,
      env: buildEnvironment,
    }, buildLock, "install");
    if (install.code !== 0) fail(`bun install exited ${install.code}${install.signal ? ` (${install.signal})` : ""}`, install.code);
    buildLock.assertOwned("dependency installation completion");
    const installInputsAfter = expectedVendoredInstallStamp(options.root, buildEnvironment);
    if (installInputsBefore.sha256 !== installInputsAfter.sha256) {
      fail("dependency inputs changed while bun install was running; install stamp not written");
    }
    buildLock.assertOwned("dependency stamp write");
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
    const build = await runMutatingCommand(
      "bun",
      ["run", "build", "--", "--outDir", stagingDirectory],
      { cwd: webRoot, env: buildEnvironment },
      buildLock,
      "build",
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
    const promotion = promoteStagingDirectory(
      stagingDirectory,
      distDirectory,
      buildLock.token,
      (operation) => buildLock.assertOwned(operation),
    );
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
    buildLock.assertOwned("dist promotion cleanup");
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
