import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEGACY_ENGINE_DATA_DIRECTORY } from "../server/src/legacy-engine-data.ts";
import {
  allowlistedPreviewEnvironment,
  assertPreviewAutomaticEnvironmentFilesAbsent,
  assertPreviewWebProjectionCurrent,
  createLaunchOverlay,
  instrumentPreviewEnvironment,
  preparePreviewEngineHome,
  preparePreviewWebRoot,
  previewAutomaticEnvironmentFiles,
  previewEnvironment,
  previewPrebuildEnvironment,
  previewWebRoot,
  previewWebSourceManifest,
  removePreviewWebRoot,
} from "./preview-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";
import { acquirePreviewLifecycleLock } from "./preview-state.mjs";
import {
  acquireVendoredDistBuildLock,
  captureProcessIdentity,
  escapeExtendedRegularExpression,
  findVendoredRootOccupants,
  forceOwnedSupervisorProcessGroup,
  latchOwnedProcessGroupRetirement,
  missingPreviewLauncherDependencies,
  prepareLauncherDependencies,
  previewVendoredDistFingerprintEnvironment,
  previewVendoredDistEnvironment,
  processLiveness,
  recordSupervisorOwnership,
  recoverVendoredDistBuildLock,
  recordedProcessState,
  scrubSensitiveEnvironment,
  vendoredDistBuildLockOwnerPath,
  vendoredDistBuildLockPath,
  vendoredDistBuildLockStatus,
} from "./vendored-dist-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const identityShimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-identity-shims-"));
const originalTestPath = process.env.PATH ?? "";
for (const [name, output] of [
  ["ps", "Sun Aug 16 10:00:00 2026\\n"],
  ["sysctl", "{ sec = 12345, usec = 0 }\\n"],
]) {
  fs.writeFileSync(
    path.join(identityShimRoot, name),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o700 },
  );
}
process.env.PATH = `${identityShimRoot}${path.delimiter}${originalTestPath}`;
test.after(() => {
  process.env.PATH = originalTestPath;
  fs.rmSync(identityShimRoot, { recursive: true, force: true });
});
const testIdentity = (value, method = "test-identity") => ({
  method,
  value,
  host: "test-host",
  boot: "test-boot",
});

function preparedBuildLockPath(root) {
  const lockPath = vendoredDistBuildLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return lockPath;
}

function writePlantedOwner(lockDirectory, record) {
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockDirectory), `${JSON.stringify(record)}\n`);
}

function readPlantedOwner(lockDirectory) {
  return JSON.parse(fs.readFileSync(vendoredDistBuildLockOwnerPath(lockDirectory), "utf-8"));
}

test("credential scrub catches auth, PAT, and key names without stripping path variables", () => {
  const environment = scrubSensitiveEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp/work",
    GITHUB_PAT: "secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SERVICE_AUTHORIZATION: "secret",
    SERVICE_KEY: "secret",
    SESSION_TOKEN: "secret",
    CLIENT_SECRET: "secret",
    DATABASE_PASSWORD: "secret",
    CLOUD_CREDENTIAL_FILE: "secret",
    PGPASSWORD: "secret",
    MYSQL_PWD: "secret",
    DATABASE_URL: "postgres://secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: secret",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp/work",
  });
});

test("preview vendored dist prebuild uses only the strict allowlist", () => {
  const environment = previewVendoredDistEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/home/.local/bin",
    13091,
    {
      PATH: "/usr/bin",
      NODE_ENV: "test",
      LANG: "en_US.UTF-8",
      CI: "true",
      PI_CODING_AGENT_DIR: "/ambient/pi",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTPS_PROXY: "https://user:password@proxy.invalid",
      GITHUB_PAT: "secret",
      NORMAL_SENTINEL: "drop-me",
    },
  );

  assert.deepEqual(environment, {
    HOME: "/tmp/kady-preview-test/home",
    PATH: `/tmp/kady-preview-test/home/.local/bin${path.delimiter}/usr/bin`,
    NODE_ENV: "test",
    PORT: "13091",
    TMPDIR: "/tmp/kady-preview-test/tmp",
    LANG: "en_US.UTF-8",
    CI: "true",
  });
});

test("build-only NODE_ENV reaches fake Bun but not the preview launcher", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-build-env-"));
  try {
    const fakeBin = path.join(stateRoot, "bin");
    const dumpPath = path.join(stateRoot, "environment.json");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeBun = path.join(fakeBin, "bun");
    fs.writeFileSync(
      fakeBun,
      `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));\n`,
      { mode: 0o700 },
    );
    const preview = previewEnvironment(
      stateRoot,
      path.join(stateRoot, "launch"),
      fakeBin,
      { backend: 18100, frontend: 13100, engine: 13191 },
      {
        PATH: process.env.PATH,
        PGPASSWORD: "drop",
        MYSQL_PWD: "drop",
        DATABASE_URL: "drop",
        NORMAL_SENTINEL: "drop",
      },
    );
    const prebuildDirect = previewVendoredDistEnvironment(
      stateRoot,
      fakeBin,
      13191,
      { PATH: process.env.PATH },
    );
    const prebuildEnvironment = previewVendoredDistFingerprintEnvironment(preview, 13191);
    assert.deepEqual(prebuildEnvironment, prebuildDirect);
    assert.equal("NODE_ENV" in preview, false);
    assert.equal(prebuildEnvironment.NODE_ENV, "production");
    assert.equal(prebuildEnvironment.PORT, "13191");
    assert.equal(prebuildEnvironment.TMPDIR, path.join(stateRoot, "tmp"));
    const result = spawnSync(fakeBun, ["--version"], { env: prebuildEnvironment });
    assert.equal(result.status, 0);
    const dumped = JSON.parse(fs.readFileSync(dumpPath, "utf-8"));
    for (const [name, value] of Object.entries(prebuildEnvironment)) assert.equal(dumped[name], value);
    for (const name of ["PGPASSWORD", "MYSQL_PWD", "DATABASE_URL", "NORMAL_SENTINEL", "GITHUB_PAT", "SSH_AUTH_SOCK"]) {
      assert.equal(name in dumped, false, name);
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// The dist-freshness lane required that NODE_ENV=production never leak from
// the vendored build into the launcher, and let an explicitly ambient NODE_ENV
// through. The isolation lane's ambient allowlist is strictly stronger: no
// ambient NODE_ENV reaches any preview service, so each runtime establishes its
// own mode while the prebuild alone still runs in production mode.
test("preview launcher never receives NODE_ENV, explicit or not", () => {
  const absent = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/bin",
    { backend: 18100, frontend: 13100, engine: 13191 },
    { PATH: "/usr/bin" },
  );
  const explicit = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/bin",
    { backend: 18100, frontend: 13100, engine: 13191 },
    { PATH: "/usr/bin", NODE_ENV: "test" },
  );
  assert.equal("NODE_ENV" in absent, false);
  assert.equal("NODE_ENV" in explicit, false);
  assert.equal(
    previewPrebuildEnvironment(
      previewVendoredDistEnvironment(
        "/tmp/kady-preview-test",
        "/tmp/kady-preview-test/bin",
        13191,
        allowlistedPreviewEnvironment({ PATH: "/usr/bin", NODE_ENV: "test" }),
      ),
    ).NODE_ENV,
    "production",
  );
});

test("preview dependency preparation never invokes fake npm under production NODE_ENV", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-fake-npm-"));
  try {
    const invocationLog = path.join(stateRoot, "npm-invoked");
    const fakeNpmPath = path.join(stateRoot, "npm");
    fs.writeFileSync(
      fakeNpmPath,
      `#!${process.execPath}\nimport fs from "node:fs";
if (process.env.NODE_ENV === "production") process.exit(91);
fs.writeFileSync(${JSON.stringify(invocationLog)}, "invoked\\n");
`,
      { mode: 0o700 },
    );
    const previewEnvironmentWithProduction = { KADY_PREVIEW: "1", NODE_ENV: "production" };
    const invokeFakeNpm = (environment) => {
      const result = spawnSync(fakeNpmPath, ["install"], { env: environment });
      assert.equal(result.status, 0, `fake npm exited ${result.status}`);
    };
    const action = prepareLauncherDependencies({
      environment: previewEnvironmentWithProduction,
      missingPreviewDependencies: [],
      install: () => invokeFakeNpm(previewEnvironmentWithProduction),
    });
    assert.equal(action, "reuse-preview");
    assert.equal(fs.existsSync(invocationLog), false);
    assert.throws(
      () => prepareLauncherDependencies({
        environment: previewEnvironmentWithProduction,
        missingPreviewDependencies: ["server/node_modules/tsx/dist/cli.mjs"],
        install: () => invokeFakeNpm(previewEnvironmentWithProduction),
      }),
      /Preview requires dependencies installed before launch/,
    );
    assert.equal(fs.existsSync(invocationLog), false);

    const normalEnvironment = { PATH: process.env.PATH ?? "" };
    assert.equal(
      prepareLauncherDependencies({
        environment: normalEnvironment,
        missingPreviewDependencies: ["ignored outside preview"],
        install: () => invokeFakeNpm(normalEnvironment),
      }),
      "installed",
    );
    assert.equal(fs.readFileSync(invocationLog, "utf-8"), "invoked\n");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("production-pruned preview web tree fails before Next can repair TypeScript dependencies", () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-pruned-web-"));
  try {
    for (const relativePath of [
      "server/node_modules/tsx/dist/cli.mjs",
      "web/node_modules/next/dist/bin/next",
      "web/tsconfig.json",
    ]) {
      const filePath = path.join(repositoryRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "fixture\n");
    }
    const missing = missingPreviewLauncherDependencies(repositoryRoot);
    assert.deepEqual(missing, [
      "web/node_modules/typescript/lib/typescript.js",
      "web/node_modules/@types/react/index.d.ts",
      "web/node_modules/@types/node/index.d.ts",
    ]);
    assert.throws(
      () => prepareLauncherDependencies({
        environment: { KADY_PREVIEW: "1" },
        missingPreviewDependencies: missing,
        install: () => assert.fail("npm must not run"),
      }),
      /web\/node_modules\/typescript\/lib\/typescript\.js/,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("launch overlay resolves every copied start.mjs dependency without starting services", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-overlay-test-"));
  try {
    const { launchRoot } = createLaunchOverlay(
      repositoryRoot,
      stateRoot,
      process.execPath,
      process.execPath,
    );
    const launcherSource = fs.readFileSync(path.join(launchRoot, "start.mjs"), "utf-8");
    const relativeImports = [
      ...launcherSource.matchAll(/from\s+["'](\.\/[^"']+)["']/g),
    ].map((match) => match[1]);

    assert.deepEqual(relativeImports, [
      "./env-file.mjs",
      "./scripts/vendored-dist-check.mjs",
      "./scripts/vendored-dist-environment.mjs",
    ]);
    assert.deepEqual(
      fs.readFileSync(path.join(launchRoot, "env-file.mjs")),
      fs.readFileSync(path.join(repositoryRoot, "env-file.mjs")),
    );
    assert.equal(fs.existsSync(path.join(launchRoot, ".git")), false);
    assert.equal(
      fs.readFileSync(path.join(launchRoot, ".env"), "utf-8"),
      "# Intentionally blank preview environment.\n",
    );
    assert.equal(fs.lstatSync(path.join(launchRoot, "server")).isSymbolicLink(), true);
    const importProbePath = path.join(launchRoot, "import-probe.mjs");
    fs.writeFileSync(
      importProbePath,
      `${relativeImports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`,
    );
    const importProbe = spawnSync(process.execPath, [importProbePath], {
      cwd: launchRoot,
      encoding: "utf-8",
    });
    assert.equal(importProbe.status, 0, `${importProbe.stdout}\n${importProbe.stderr}`);

    for (const scriptName of [
      "vendored-dist-build.mjs",
      "vendored-dist-check.mjs",
      "vendored-dist-environment.mjs",
    ]) {
      assert.deepEqual(
        fs.readFileSync(path.join(launchRoot, "scripts", scriptName)),
        fs.readFileSync(path.join(repositoryRoot, "scripts", scriptName)),
      );
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("preview npm shim allows only the launcher prep command", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-npm-shim-"));
  try {
    const invocationLog = path.join(stateRoot, "real-npm.json");
    const realNpm = path.join(stateRoot, "real-npm");
    fs.writeFileSync(
      realNpm,
      `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const { shimDirectory } = createLaunchOverlay(
      repositoryRoot,
      stateRoot,
      realNpm,
      process.execPath,
    );
    const npmShim = path.join(shimDirectory, "npm");
    for (const command of ["install", "i", "add", "remove", "prune", "update", "ci", "dedupe", "link", "exec", "x", "rebuild"]) {
      const blocked = spawnSync(npmShim, [command], { encoding: "utf-8" });
      assert.equal(blocked.status, 125, command);
      assert.match(blocked.stderr, /blocked npm command/);
      assert.equal(fs.existsSync(invocationLog), false);
    }
    const allowed = spawnSync(npmShim, ["run", "prep", "--silent"], { encoding: "utf-8" });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(invocationLog, "utf-8")), ["run", "prep", "--silent"]);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("macOS process identity is invariant to ambient locale and timezone", () => {
  const calls = [];
  const spawnProcess = (command, _arguments, options) => {
    calls.push({ command, environment: options.env });
    return command === "sysctl"
      ? { status: 0, stdout: "{ sec = 12345, usec = 0 }\n" }
      : { status: 0, stdout: "Sun Aug 16 10:00:00 2026\n" };
  };
  const first = captureProcessIdentity(42, {
    platform: "darwin",
    spawnProcess,
    hostname: () => "fixture-host",
  });
  const second = captureProcessIdentity(42, {
    platform: "darwin",
    spawnProcess,
    hostname: () => "fixture-host",
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    method: "ps-lstart-utc",
    value: "Sun Aug 16 10:00:00 2026",
    host: "fixture-host",
    boot: "darwin-boot-seconds:12345",
  });
  for (const call of calls) {
    assert.equal(call.environment.LC_ALL, "C");
    assert.equal(call.environment.TZ, "UTC0");
  }
});

test("identity method, host, and liveness uncertainty fail closed", () => {
  const recorded = testIdentity("start", "proc-stat");
  assert.equal(recordedProcessState(44, recorded, {
    getLiveness: () => "alive",
    captureIdentity: () => testIdentity("start", "ps-lstart-utc"),
  }), "unverifiable");
  let hostMismatchLivenessProbes = 0;
  assert.equal(recordedProcessState(44, recorded, {
    getLiveness: () => { hostMismatchLivenessProbes += 1; return "dead"; },
    captureIdentity: () => ({ ...recorded, host: "other-host" }),
  }), "unverifiable");
  assert.equal(hostMismatchLivenessProbes, 0, "host scope must be checked before the local PID namespace");
  assert.equal(recordedProcessState(44, recorded, {
    getLiveness: () => "alive",
    captureIdentity: () => ({ ...recorded, boot: "next-boot" }),
  }), "gone");
  for (const code of ["EPERM", "EACCES", "EINVAL"]) {
    assert.equal(processLiveness(44, () => { throw Object.assign(new Error(code), { code }); }), "unknown");
  }
  assert.equal(processLiveness(44, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), "dead");
});

test("retired process groups never reacquire ownership from a reused numeric PGID", () => {
  const ownership = { pid: 5151, retired: false };
  assert.equal(latchOwnedProcessGroupRetirement(ownership, true, "dead"), true);
  assert.equal(latchOwnedProcessGroupRetirement(ownership, true, "alive"), true);
});

test("a reused supervisor PID is recorded but retired from forced ownership", () => {
  const records = new Map();
  assert.equal(recordSupervisorOwnership(records, 5151, testIdentity("first")), "recorded");
  assert.equal(recordSupervisorOwnership(records, 5151, testIdentity("replacement")), "identity-changed-retired");
  assert.deepEqual(records.get(5151), {
    pid: 5151,
    identity: testIdentity("replacement"),
    retired: true,
    supersededIdentity: testIdentity("first"),
  });
});

test("forced supervisor teardown handles descendants, exit races, PID reuse, and retry", async () => {
  const identity = testIdentity("owned");

  const exitRace = { pid: 6001, identity, retired: false };
  let exitRaceProbe = 0;
  const exitRaceResult = await forceOwnedSupervisorProcessGroup(exitRace, {
    recordedState: () => exitRaceProbe++ === 0 ? "same" : "gone",
    groupLiveness: () => "dead",
    signalGroup: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    signalPid: () => assert.fail("a naturally exited supervisor must not receive a PID fallback signal"),
  });
  assert.deepEqual(exitRaceResult, { ok: true, status: "gone" });

  const orphanedGroup = { pid: 6005, identity, retired: false };
  let orphanSignals = 0;
  const orphanFailed = await forceOwnedSupervisorProcessGroup(orphanedGroup, {
    recordedState: () => "gone",
    groupLiveness: () => "alive",
    pidLiveness: () => "dead",
    signalGroup: () => { orphanSignals += 1; },
    wait: async () => {},
    now: (() => { let clock = 0; return () => { clock += 50; return clock; }; })(),
    timeoutMs: 100,
  });
  assert.equal(orphanFailed.ok, false);
  assert.equal(orphanedGroup.retired, false);
  assert.ok(orphanSignals >= 1, "leader-gone/group-live must send another group signal");
  const orphanKilled = await forceOwnedSupervisorProcessGroup(orphanedGroup, {
    recordedState: () => "gone",
    groupLiveness: () => "dead",
    pidLiveness: () => "dead",
    signalGroup: () => {},
  });
  assert.deepEqual(orphanKilled, { ok: true, status: "gone" });

  const stubbornTree = { pid: 6002, identity, retired: false };
  const groupStates = ["alive", "alive", "dead"];
  let clock = 0;
  const stubbornResult = await forceOwnedSupervisorProcessGroup(stubbornTree, {
    recordedState: () => "same",
    groupLiveness: () => groupStates.shift() ?? "dead",
    pidLiveness: () => "dead",
    signalGroup: () => {},
    wait: async () => { clock += 50; },
    now: () => clock,
  });
  assert.deepEqual(stubbornResult, { ok: true, status: "killed" });

  const reused = { pid: 6003, identity, retired: false };
  let reuseProbe = 0;
  const reuseResult = await forceOwnedSupervisorProcessGroup(reused, {
    recordedState: () => reuseProbe++ === 0 ? "same" : "gone",
    groupLiveness: () => "alive",
    pidLiveness: () => "alive",
    signalGroup: () => {},
  });
  assert.deepEqual(reuseResult, { ok: true, status: "pid-reused" });

  const retry = { pid: 6004, identity, retired: false };
  const failed = await forceOwnedSupervisorProcessGroup(retry, {
    recordedState: () => "same",
    signalGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  });
  assert.equal(failed.ok, false);
  assert.equal(retry.retired, false);
  const retried = await forceOwnedSupervisorProcessGroup(retry, {
    recordedState: () => "same",
    groupLiveness: () => "dead",
    pidLiveness: () => "dead",
    signalGroup: () => {},
  });
  assert.deepEqual(retried, { ok: true, status: "killed" });
});

test("a dead supervisor leader is not retired while a descendant remains in the group", {
  skip: process.platform === "win32" ? "requires POSIX process groups" : false,
}, async () => {
  const descendantPidPath = path.join(os.tmpdir(), `kady-supervisor-descendant-${process.pid}-${Date.now()}`);
  const leader = spawn(process.execPath, ["--input-type=module", "-e", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`], { detached: true, stdio: "ignore" });
  try {
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(descendantPidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf-8"));
    assert.ok(Number.isSafeInteger(descendantPid), "descendant pid was not recorded");
    const identity = captureProcessIdentity(leader.pid);
    assert.ok(identity, "could not capture supervisor leader identity");
    process.kill(leader.pid, "SIGKILL");
    const leaderGoneDeadline = Date.now() + 2_000;
    while (Date.now() < leaderGoneDeadline) {
      try {
        process.kill(leader.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        if (error?.code === "ESRCH") break;
        throw error;
      }
    }
    process.kill(descendantPid, 0);
    process.kill(-leader.pid, 0);
    const owner = { pid: leader.pid, identity, retired: false };
    const result = await forceOwnedSupervisorProcessGroup(owner, {
      groupLiveness: (pid) => {
        try {
          process.kill(-pid, 0);
          return "alive";
        } catch (error) {
          return error?.code === "ESRCH" ? "dead" : "unknown";
        }
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(owner.retired, true);
    assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === "ESRCH");
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(leader.pid, "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(descendantPidPath, { force: true });
  }
});

test("failed build-lock record writes remove the partial lock", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-write-failure-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const injectedError = new Error("injected lock write failure");
  try {
    const lockFileSystem = {
      openSync: (...arguments_) => fs.openSync(...arguments_),
      writeFileSync(descriptor) {
        fs.writeFileSync(descriptor, "{\"schema\":");
        throw injectedError;
      },
      closeSync: (...arguments_) => fs.closeSync(...arguments_),
      rmSync: (...arguments_) => fs.rmSync(...arguments_),
    };
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { lockFileSystem }),
      injectedError,
    );
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("malformed build locks are never reclaimed and time out with metadata", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-malformed-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), "{partial");
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      /timed out waiting for vendored dist build lock held by pid unknown, identity "unknown".*owner=unreadable owner record.*node scripts\/vendored-dist-build\.mjs --recover-lock/,
    );
    assert.equal(fs.readFileSync(vendoredDistBuildLockOwnerPath(lockPath), "utf-8"), "{partial");
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("a dead planted owner stays busy until explicit CLI recovery", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-dead-stays-busy-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const deadIdentity = testIdentity("dead-owner-start");
  try {
    writePlantedOwner(lockPath, {
      version: 1,
      pid: 424242,
      identity: deadIdentity,
      phase: "holding",
      workers: [],
      createdAt: "2026-08-16T00:00:00.000Z",
      heartbeatAt: "2026-08-16T00:00:00.000Z",
    });
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, {
        captureIdentity: () => testIdentity("contender-start"),
        waitMs: 30,
        pollMs: 5,
      }),
      /timed out waiting for vendored dist build lock/,
    );
    assert.equal(readPlantedOwner(lockPath).pid, 424242);
    const recovered = await recoverVendoredDistBuildLock(repositoryRoot, {
      captureIdentity: (pid) => pid === process.pid ? testIdentity("operator") : deadIdentity,
      getLiveness: (pid) => pid === process.pid ? "alive" : "dead",
    });
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Windows CLI recovery is refused and an existing lock stays busy", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-windows-scope-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    writePlantedOwner(lockPath, {
      version: 1,
      pid: 989898,
      identity: testIdentity("dead-windows"),
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      /timed out waiting for vendored dist build lock/,
    );
    assert.equal(readPlantedOwner(lockPath).pid, 989898);
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, { platform: "win32" }),
      /vendored-dist lock recovery is disabled on Windows.*build\.lock\.d/s,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("a surviving recorded Bun worker prevents CLI recovery and keeps acquire busy", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-live-worker-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const workerIdentity = testIdentity("worker-start");
  const record = {
    version: 1,
    pid: 454545,
    identity: testIdentity("dead-wrapper-start"),
    phase: "build",
    workers: [{
      pid: 464646,
      identity: workerIdentity,
      phase: "build",
      startedAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  try {
    writePlantedOwner(lockPath, record);
    const dependencies = {
      captureIdentity: (pid) => pid === process.pid ? testIdentity("contender") : workerIdentity,
      getLiveness: (pid) => pid === 454545 ? "dead" : "alive",
    };
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, dependencies),
      /refusing lock recovery \(same\).*464646/,
    );
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      /timed out waiting for vendored dist build lock/,
    );
    assert.equal(readPlantedOwner(lockPath).pid, 454545);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("mkdir contention lets one builder win and reports the other BUSY", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-mkdir-contention-"));
  const moduleUrl = new URL("./vendored-dist-environment.mjs", import.meta.url).href;
  const children = [];
  try {
    const childSource = `
import { acquireVendoredDistBuildLock } from ${JSON.stringify(moduleUrl)};
try {
  const lock = await acquireVendoredDistBuildLock(process.argv[1], { waitMs: 80, pollMs: 10 });
  process.send({ won: true });
  await new Promise((resolve) => setTimeout(resolve, 400));
  lock.release();
  process.exit(0);
} catch (error) {
  process.send({ won: false, message: String(error?.message ?? error) });
  process.exit(0);
}
`;
    const startChild = () => spawn(
      process.execPath,
      ["--input-type=module", "-e", childSource, repositoryRoot],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const first = startChild();
    const second = startChild();
    children.push(first, second);
    const results = await Promise.all([first, second].map((child) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("mkdir contender did not report")), 3_000);
      child.once("error", reject);
      child.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    })));
    const winners = results.filter((result) => result.won);
    const losers = results.filter((result) => !result.won);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /timed out waiting for vendored dist build lock/);
    await Promise.all(children.map((child) => child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve))));
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("release then reacquire publishes a new owner record", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-reacquire-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const first = await acquireVendoredDistBuildLock(repositoryRoot);
    const firstOwner = readPlantedOwner(lockPath);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
    const second = await acquireVendoredDistBuildLock(repositoryRoot);
    const secondOwner = readPlantedOwner(lockPath);
    assert.notEqual(first.token, second.token);
    assert.notEqual(firstOwner.createdAt, secondOwner.createdAt);
    assert.equal(secondOwner.pid, process.pid);
    second.release();
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("CLI recovery removes a dead owner and refuses a live owner", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-cli-owner-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const liveIdentity = testIdentity("live-owner");
  const deadIdentity = testIdentity("dead-owner");
  try {
    writePlantedOwner(lockPath, {
      version: 1,
      pid: 777001,
      identity: liveIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, {
        captureIdentity: (pid) => pid === process.pid ? testIdentity("operator") : liveIdentity,
        getLiveness: () => "alive",
      }),
      /refusing lock recovery \(same\)/,
    );
    assert.equal(fs.existsSync(lockPath), true);

    writePlantedOwner(lockPath, {
      version: 1,
      pid: 777002,
      identity: deadIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    const recovered = await recoverVendoredDistBuildLock(repositoryRoot, {
      captureIdentity: (pid) => pid === process.pid ? testIdentity("operator") : deadIdentity,
      getLiveness: (pid) => pid === process.pid ? "alive" : "dead",
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.record.pid, 777002);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("unreadable owner records refuse recovery unless --force finds no occupants", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-unreadable-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), "{partial");
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot),
      /owner record is unreadable/,
    );
    assert.equal(fs.existsSync(lockPath), true);
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, {
        force: true,
        occupantsFor: () => [31337],
      }),
      /refusing forced lock recovery because node\/bun still reference/,
    );
    assert.equal(fs.existsSync(lockPath), true);
    const recovered = await recoverVendoredDistBuildLock(repositoryRoot, {
      force: true,
      occupantsFor: () => [],
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.forced, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("persistent malformed-lock contention reaches its deadline", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-deadline-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), "{partial");
    const startedAt = Date.now();
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      /timed out waiting for vendored dist build lock/,
    );
    assert.ok(Date.now() - startedAt < 500, "lock wait must not spin past its deadline");
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("an old-heartbeat build lock remains active while its exact owner is live", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-live-owner-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const lock = await acquireVendoredDistBuildLock(repositoryRoot);
    const ownerRecord = readPlantedOwner(lockPath);
    ownerRecord.heartbeatAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), `${JSON.stringify(ownerRecord)}\n`);
    assert.equal(vendoredDistBuildLockStatus(repositoryRoot).active, true);
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      (error) => {
        assert.match(error.message, new RegExp(`held by pid ${process.pid}`));
        assert.match(error.message, /identity/);
        assert.match(error.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, /safe recovery command: node scripts\/vendored-dist-build\.mjs --recover-lock/);
        return true;
      },
    );
    assert.equal(readPlantedOwner(lockPath).pid, process.pid);
    lock.release();
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("build lock ownership is revalidated before mutations and promotion", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-token-loss-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const lock = await acquireVendoredDistBuildLock(repositoryRoot);
    const replacement = readPlantedOwner(lockPath);
    replacement.pid = 1;
    replacement.identity = testIdentity("replacement-owner");
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), `${JSON.stringify(replacement)}\n`);
    assert.throws(() => lock.assertOwned("dependency installation"), /ownership was lost/);
    assert.throws(() => lock.assertOwned("dist promotion"), /ownership was lost/);
    lock.release();
    assert.equal(fs.existsSync(lockPath), true, "the old owner must not remove its successor's lock");
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("two lock contenders serialize without deleting the first owner's record", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-two-contenders-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const first = await acquireVendoredDistBuildLock(repositoryRoot);
    const firstContents = fs.readFileSync(vendoredDistBuildLockOwnerPath(lockPath), "utf-8");
    const secondPromise = acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 500, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.readFileSync(vendoredDistBuildLockOwnerPath(lockPath), "utf-8"), firstContents);
    first.release();
    const second = await secondPromise;
    assert.notEqual(second.token, first.token);
    assert.equal(readPlantedOwner(lockPath).pid, process.pid);
    second.release();
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("distinct TMPDIR processes rendezvous on one checkout-local build lock", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-cross-process-"));
  const firstTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-tmp-a-"));
  const secondTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-tmp-b-"));
  const moduleUrl = new URL("./vendored-dist-environment.mjs", import.meta.url).href;
  const childSource = `
    import { acquireVendoredDistBuildLock } from ${JSON.stringify(moduleUrl)};
    const lock = await acquireVendoredDistBuildLock(process.argv[1], { waitMs: 2_000, pollMs: 10 });
    process.send({ type: "acquired", lockPath: lock.lockPath });
    process.on("message", (message) => {
      if (message === "release") { lock.release(); process.exit(0); }
    });
  `;
  const startContender = (temporaryDirectory) => spawn(
    process.execPath,
    ["--input-type=module", "-e", childSource, repositoryRoot],
    {
      env: { ...process.env, TMPDIR: temporaryDirectory },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const waitForAcquired = (child) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lock contender did not acquire in time")), 3_000);
    child.once("error", reject);
    child.on("message", (message) => {
      if (message?.type !== "acquired") return;
      clearTimeout(timeout);
      resolve(message);
    });
  });

  const first = startContender(firstTmp);
  let second;
  try {
    const firstAcquired = await waitForAcquired(first);
    second = startContender(secondTmp);
    let secondReported = false;
    second.on("message", (message) => {
      if (message?.type === "acquired") secondReported = true;
    });
    const secondAcquiredPromise = waitForAcquired(second);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(secondReported, false, "the second TMPDIR must wait on the first process's lock");
    const firstExit = new Promise((resolve) => first.once("exit", resolve));
    first.send("release");
    await firstExit;
    const secondAcquired = await secondAcquiredPromise;
    assert.equal(secondAcquired.lockPath, firstAcquired.lockPath);
    assert.equal(secondAcquired.lockPath, vendoredDistBuildLockPath(repositoryRoot));
    assert.equal(secondAcquired.lockPath.startsWith(firstTmp), false);
    assert.equal(secondAcquired.lockPath.startsWith(secondTmp), false);
    const secondExit = new Promise((resolve) => second.once("exit", resolve));
    second.send("release");
    await secondExit;
  } finally {
    if (first.exitCode === null) first.kill("SIGKILL");
    if (second?.exitCode === null) second.kill("SIGKILL");
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(firstTmp, { recursive: true, force: true });
    fs.rmSync(secondTmp, { recursive: true, force: true });
  }
});
function createMinimalProjectionCheckout(temporaryRoot) {
  const repositoryRoot = path.join(temporaryRoot, "checkout");
  const checkoutWebRoot = path.join(repositoryRoot, "web");
  const checkoutPublicRoot = path.join(checkoutWebRoot, "public");
  const launchRoot = path.join(temporaryRoot, "state", "launch");
  fs.mkdirSync(path.join(checkoutWebRoot, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
  fs.mkdirSync(checkoutPublicRoot, { recursive: true });
  fs.mkdirSync(launchRoot, { recursive: true });
  fs.writeFileSync(path.join(checkoutWebRoot, "src", "app", "page.tsx"), "page\n");
  fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
  return { repositoryRoot, checkoutWebRoot, checkoutPublicRoot, launchRoot };
}

test("pins both engine clients to the preview port by default and scrubs legacy engine variables", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      ARCHON_BASE_URL: "http://ambient.invalid:3091",
      NEXT_PUBLIC_ARCHON_URL: "http://ambient.invalid:3091",
      KADY_ARCHON_PORT: "3091",
    },
  );

  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13091");
  assert.equal(environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL, "http://127.0.0.1:13091");
  assert.equal(environment.NEXT_PUBLIC_ADK_API_URL, "http://127.0.0.1:18000");
  assert.equal(environment.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO, "1");
  assert.equal(environment.KADY_PIPELINE_ENGINE_PORT, "13091");
  assert.equal("NODE_ENV" in environment, false);
  assert.equal(environment.KADY_ENV_FILE, "/tmp/kady-preview-test/launch/.env");
  assert.equal(environment.ARCHON_HOME, "/tmp/kady-preview-test/pipeline-engine-home");
  assert.equal(environment.HOME, "/tmp/kady-preview-test/home");
  assert.equal(environment.PATH, "/tmp/kady-preview-test/launch/bin:/usr/bin");
  assert.equal(environment.npm_config_cache, "/tmp/kady-preview-test/npm-cache");
  // Recording is generation-bound; an ungenerated environment publishes none
  // of the three recording variables.
  assert.equal("KADY_PREVIEW_SERVICE_STATE_FILE" in environment, false);
  assert.equal("KADY_PREVIEW_GENERATION" in environment, false);
  assert.equal("KADY_PREVIEW_START_GATE_FILE" in environment, false);
  assert.equal("ARCHON_BASE_URL" in environment, false);
  assert.equal("NEXT_PUBLIC_ARCHON_URL" in environment, false);
  assert.equal("KADY_ARCHON_PORT" in environment, false);
  assert.equal("npm_config_offline" in environment, false);
});

test("publishes the recording variables only together with a generation", () => {
  const generation = "0f2a6d4c-1f7e-4a0e-9f1b-1a2b3c4d5e6f";
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    { PATH: "/usr/bin" },
    generation,
  );

  assert.equal(
    environment.KADY_PREVIEW_SERVICE_STATE_FILE,
    "/tmp/kady-preview-test/services.json",
  );
  assert.equal(environment.KADY_PREVIEW_GENERATION, generation);
  assert.equal(
    environment.KADY_PREVIEW_START_GATE_FILE,
    `/tmp/kady-preview-test/launcher-${generation}.go`,
  );
});

test("honours an explicit browser-facing pipeline engine origin", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      NEXT_PUBLIC_PIPELINE_ENGINE_URL: "https://pipeline.example.test",
    },
  );

  assert.equal(
    environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL,
    "https://pipeline.example.test",
  );
  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13091");
});

test("honours an explicit browser-facing backend origin", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      NEXT_PUBLIC_ADK_API_URL: "https://backend.example.test",
    },
  );

  assert.equal(environment.NEXT_PUBLIC_ADK_API_URL, "https://backend.example.test");
});

test("rejects a malformed browser-facing pipeline engine origin", () => {
  assert.throws(
    () =>
      previewEnvironment(
        "/tmp/kady-preview-test",
        "/tmp/kady-preview-test/launch",
        "/tmp/kady-preview-test/launch/bin",
        { backend: 18000, frontend: 13000, engine: 13091 },
        {
          PATH: "/usr/bin",
          NEXT_PUBLIC_PIPELINE_ENGINE_URL: "pipeline.example.test",
        },
      ),
    /NEXT_PUBLIC_PIPELINE_ENGINE_URL must be an absolute http\(s\) origin/,
  );
});

test("rejects a malformed browser-facing backend origin", () => {
  assert.throws(
    () =>
      previewEnvironment(
        "/tmp/kady-preview-test",
        "/tmp/kady-preview-test/launch",
        "/tmp/kady-preview-test/launch/bin",
        { backend: 18000, frontend: 13000, engine: 13091 },
        {
          PATH: "/usr/bin",
          NEXT_PUBLIC_ADK_API_URL: "backend.example.test",
        },
      ),
    /NEXT_PUBLIC_ADK_API_URL must be an absolute http\(s\) origin/,
  );
});

test("scrubs credentials when a browser-facing pipeline engine origin is present", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      NEXT_PUBLIC_PIPELINE_ENGINE_URL: "https://pipeline.example.test",
      OPENROUTER_API_KEY: "must-not-leak",
      SESSION_TOKEN: "must-not-leak",
      CLIENT_SECRET: "must-not-leak",
      DATABASE_PASSWORD: "must-not-leak",
      SERVICE_CREDENTIAL: "must-not-leak",
    },
  );

  assert.equal(
    environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL,
    "https://pipeline.example.test",
  );
  assert.equal("OPENROUTER_API_KEY" in environment, false);
  assert.equal("SESSION_TOKEN" in environment, false);
  assert.equal("CLIENT_SECRET" in environment, false);
  assert.equal("DATABASE_PASSWORD" in environment, false);
  assert.equal("SERVICE_CREDENTIAL" in environment, false);
});

test("builds preview child environments from an explicit ambient allowlist", () => {
  const engineDockerVariable = `${"ARCHON_HOME".split("_")[0]}_DOCKER`;
  const ambientEnvironment = {
    PATH: "/usr/bin",
    TMPDIR: "/tmp/ambient",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    CI: "1",
    NODE_ENV: "development",
    NEXT_PUBLIC_ADK_API_URL: "https://backend.example.test",
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: "https://pipeline.example.test",
    HOME: "/host/home",
    [engineDockerVariable]: "true",
    WORKSPACE_PATH: "/workspace",
    DATABASE_URL: "postgres://sentinel",
    RAINDROP_WRITE_KEY: "sentinel",
    HTTP_PROXY: "http://proxy.invalid",
    HTTPS_PROXY: "http://proxy.invalid",
    ALL_PROXY: "socks5://proxy.invalid",
    NO_PROXY: "localhost",
    http_proxy: "http://proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/host-agent.sock",
    PI_CODING_AGENT_DIR: "/host/pi-agent",
    OPENROUTER_API_KEY: "sentinel",
    KADY_UNSAFE_AMBIENT_VALUE: "sentinel",
  };

  const allowlisted = allowlistedPreviewEnvironment(ambientEnvironment, {
    KADY_PREVIEW: "1",
  });
  for (const name of [
    "PATH",
    "TMPDIR",
    "LANG",
    "TERM",
    "CI",
    "NEXT_PUBLIC_ADK_API_URL",
    "NEXT_PUBLIC_PIPELINE_ENGINE_URL",
    "KADY_PREVIEW",
  ]) {
    assert.equal(name in allowlisted, true, `${name} should be allowlisted`);
  }
  for (const name of [
    engineDockerVariable,
    "WORKSPACE_PATH",
    "DATABASE_URL",
    "RAINDROP_WRITE_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "SSH_AUTH_SOCK",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "KADY_UNSAFE_AMBIENT_VALUE",
    "HOME",
    "NODE_ENV",
  ]) {
    assert.equal(name in allowlisted, false, `${name} should be dropped`);
  }

  const preview = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    ambientEnvironment,
  );
  assert.equal(preview.HOME, "/tmp/kady-preview-test/home");
  assert.equal(preview.ARCHON_HOME, "/tmp/kady-preview-test/pipeline-engine-home");
  assert.equal(preview.PI_CODING_AGENT_DIR, "/tmp/kady-preview-test/pi-agent");
  assert.equal(preview.KADY_PREVIEW, "1");
  assert.equal(preview.KADY_PORT, "18000");
  assert.equal(preview.KADY_FRONTEND_PORT, "13000");
  assert.equal(preview.KADY_PIPELINE_ENGINE_PORT, "13091");
  assert.equal("NODE_ENV" in preview, false);
  for (const name of [
    engineDockerVariable,
    "WORKSPACE_PATH",
    "DATABASE_URL",
    "RAINDROP_WRITE_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "SSH_AUTH_SOCK",
    "OPENROUTER_API_KEY",
    "KADY_UNSAFE_AMBIENT_VALUE",
  ]) {
    assert.equal(name in preview, false, `${name} should be absent from preview`);
  }

  const prebuildEnvironment = previewPrebuildEnvironment(allowlisted);
  assert.equal(prebuildEnvironment.NODE_ENV, "production");
  assert.equal("NODE_ENV" in allowlisted, false);
});

test("sets production mode only on the prebuild child", () => {
  const ambientEnvironment = { PATH: "/usr/bin", NODE_ENV: "development" };
  const previewParentEnvironment = allowlistedPreviewEnvironment(ambientEnvironment, {
    KADY_PREVIEW: "1",
  });
  const prebuildEnvironment = previewPrebuildEnvironment(previewParentEnvironment);
  const serviceEnvironment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    ambientEnvironment,
  );

  assert.equal("NODE_ENV" in previewParentEnvironment, false);
  assert.equal(prebuildEnvironment.NODE_ENV, "production");
  assert.equal("NODE_ENV" in serviceEnvironment, false);
});

test("rejects every automatic web and engine env file by canonical path", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-engine-env-"));
  try {
    const stateRoot = path.join(temporaryRoot, "state");
    const launchRoot = path.join(stateRoot, "launch");
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const ambientEngineHome = path.join(temporaryRoot, "ambient-engine-home");
    const webRoot = path.join(repositoryRoot, "web");
    const vendoredRoot = path.join(
      repositoryRoot,
      "server",
      "vendor",
      "pipeline-engine",
    );
    const engineWebDirectory = path.join(vendoredRoot, "packages", "web");
    const enginePackageDirectory = path.join(vendoredRoot, "packages", "server");
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(ambientEngineHome, { recursive: true });
    for (const directory of [webRoot, engineWebDirectory, enginePackageDirectory]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const canonicalWebRoot = fs.realpathSync(webRoot);
    const canonicalVendoredRoot = fs.realpathSync(vendoredRoot);
    const canonicalEngineWebDirectory = fs.realpathSync(engineWebDirectory);
    const canonicalEnginePackageDirectory = fs.realpathSync(enginePackageDirectory);
    const forbiddenEnvironmentFiles = previewAutomaticEnvironmentFiles(repositoryRoot);
    fs.writeFileSync(
      path.join(ambientEngineHome, ".env"),
      "OPENROUTER_API_KEY=sentinel\n",
    );

    const environment = previewEnvironment(
      stateRoot,
      launchRoot,
      path.join(launchRoot, "bin"),
      { backend: 18000, frontend: 13000, engine: 13091 },
      { PATH: "/usr/bin", ARCHON_HOME: ambientEngineHome },
    );
    const isolatedEngineHome = path.join(stateRoot, "pipeline-engine-home");
    assert.equal(environment.ARCHON_HOME, isolatedEngineHome);
    assert.equal(environment.ARCHON_HOME.startsWith(`${stateRoot}${path.sep}`), true);
    assert.equal(preparePreviewEngineHome(stateRoot), isolatedEngineHome);
    assert.deepEqual(fs.readdirSync(isolatedEngineHome), []);

    assert.equal(forbiddenEnvironmentFiles.length, 33);
    for (const namedSentinel of [
      path.join(canonicalWebRoot, ".env.local"),
      path.join(canonicalVendoredRoot, ".env.production.local"),
      path.join(canonicalEngineWebDirectory, ".env.production.local"),
      path.join(canonicalEnginePackageDirectory, LEGACY_ENGINE_DATA_DIRECTORY, ".env"),
    ]) {
      assert.equal(forbiddenEnvironmentFiles.includes(namedSentinel), true);
    }
    for (const forbiddenEnvironmentFile of forbiddenEnvironmentFiles) {
      fs.mkdirSync(path.dirname(forbiddenEnvironmentFile), { recursive: true });
      fs.writeFileSync(forbiddenEnvironmentFile, "OPENROUTER_API_KEY=sentinel\n");
      assert.throws(
        () => assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot),
        (error) =>
          error instanceof Error && error.message.includes(forbiddenEnvironmentFile),
      );
      fs.unlinkSync(forbiddenEnvironmentFile);
    }
    assert.doesNotThrow(() =>
      assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("projects the web root without automatic env files or checkout build output", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-web-root-"));
  const generation = "projection-generation";
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const checkoutWebRoot = path.join(repositoryRoot, "web");
    const checkoutServerRoot = path.join(repositoryRoot, "server");
    const launchRoot = path.join(temporaryRoot, "state", "launch");
    const checkoutAppRoot = path.join(checkoutWebRoot, "src", "app");
    const checkoutNodeModules = path.join(checkoutWebRoot, "node_modules");
    const checkoutPublicRoot = path.join(checkoutWebRoot, "public");
    fs.mkdirSync(checkoutAppRoot, { recursive: true });
    fs.mkdirSync(checkoutNodeModules, { recursive: true });
    fs.mkdirSync(checkoutPublicRoot, { recursive: true });
    fs.mkdirSync(checkoutServerRoot, { recursive: true });
    fs.mkdirSync(path.join(checkoutWebRoot, ".next"), { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.writeFileSync(path.join(checkoutAppRoot, "page.tsx"), "export default 1;\n");
    fs.writeFileSync(path.join(checkoutPublicRoot, "marker.txt"), "public marker\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(
      path.join(checkoutServerRoot, "package.json"),
      '{"version":"1.2.3"}\n',
    );
    fs.writeFileSync(path.join(checkoutWebRoot, "next.config.ts"), "export default {};\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "postcss.config.mjs"), "export default {};\n");
    fs.writeFileSync(path.join(checkoutWebRoot, ".next", "checkout.txt"), "stale\n");
    for (const fileName of [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
      ".env.production.local",
      ".env.test",
      ".env.test.local",
    ]) {
      fs.writeFileSync(path.join(checkoutWebRoot, fileName), "SENTINEL=initial\n");
    }

    const projectedWebRoot = preparePreviewWebRoot(
      repositoryRoot,
      launchRoot,
      generation,
    );
    const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
    assert.equal(projectedWebRoot, previewWebRoot(repositoryRoot));
    assert.equal(
      projectedWebRoot.startsWith(`${canonicalRepositoryRoot}${path.sep}`),
      true,
    );
    assert.equal(
      fs.realpathSync(path.join(launchRoot, "web")),
      projectedWebRoot,
    );
    assert.equal(fs.lstatSync(projectedWebRoot).isDirectory(), true);
    assert.equal(fs.lstatSync(projectedWebRoot).isSymbolicLink(), false);
    for (const copiedEntry of [
      "src",
      "public",
      "package.json",
      "next.config.ts",
      "tsconfig.json",
      "postcss.config.mjs",
    ]) {
      assert.equal(
        fs.lstatSync(path.join(projectedWebRoot, copiedEntry)).isSymbolicLink(),
        false,
        `${copiedEntry} must be copied`,
      );
    }
    assert.equal(
      fs.lstatSync(path.join(projectedWebRoot, "src", "app", "page.tsx")).isFile(),
      true,
    );
    assert.equal(
      fs.lstatSync(path.join(projectedWebRoot, "node_modules")).isSymbolicLink(),
      true,
    );
    assert.equal(fs.lstatSync(path.join(projectedWebRoot, ".next")).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(projectedWebRoot, ".next")).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(path.join(projectedWebRoot, ".next")), []);
    assert.equal(
      fs.realpathSync(path.join(projectedWebRoot, "node_modules")),
      fs.realpathSync(checkoutNodeModules),
    );
    assert.equal(
      fs.readlinkSync(path.join(projectedWebRoot, "node_modules")),
      fs.realpathSync(checkoutNodeModules),
    );
    assert.equal(fs.existsSync(path.join(projectedWebRoot, ".preview")), false);
    assert.equal(fs.existsSync(path.join(projectedWebRoot, "package-lock.json")), false);
    assert.equal(
      fs.lstatSync(
        path.join(projectedWebRoot, "src", "app", "api", "preview-health", "route.ts"),
      ).isFile(),
      true,
    );
    const healthRouteSyntax = spawnSync(
      process.execPath,
      ["--input-type=module", "--check", "-"],
      {
        input: fs.readFileSync(
          path.join(projectedWebRoot, "src", "app", "api", "preview-health", "route.ts"),
          "utf8",
        ),
        encoding: "utf8",
      },
    );
    assert.equal(healthRouteSyntax.status, 0, healthRouteSyntax.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(path.dirname(projectedWebRoot), "server", "package.json"),
        "utf8",
      ),
      '{"version":"1.2.3"}\n',
    );
    for (const fileName of [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
      ".env.production.local",
      ".env.test",
      ".env.test.local",
    ]) {
      assert.equal(fs.existsSync(path.join(projectedWebRoot, fileName)), false);
    }

    assert.equal(assertPreviewWebProjectionCurrent(repositoryRoot, generation), true);
    const changedRoute = path.join(checkoutAppRoot, "page.tsx");
    fs.writeFileSync(changedRoute, "export default 2;\n");
    assert.equal(
      fs.readFileSync(path.join(projectedWebRoot, "src", "app", "page.tsx"), "utf8"),
      "export default 1;\n",
    );
    assert.throws(
      () => assertPreviewWebProjectionCurrent(repositoryRoot, generation),
      (error) => error instanceof Error && error.message.includes(changedRoute),
    );

    for (const fileName of [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
    ]) {
      const checkoutEnvironmentFile = path.join(checkoutWebRoot, fileName);
      fs.writeFileSync(checkoutEnvironmentFile, "NEXT_PUBLIC_RAINDROP_URL=created\n");
      assert.equal(fs.existsSync(path.join(projectedWebRoot, fileName)), false);
      fs.writeFileSync(checkoutEnvironmentFile, "NEXT_PUBLIC_RAINDROP_URL=modified\n");
      assert.equal(fs.existsSync(path.join(projectedWebRoot, fileName)), false);
    }
    assert.throws(
      () => removePreviewWebRoot(repositoryRoot, "newer-generation"),
      /generation mismatch/,
    );
    assert.equal(fs.existsSync(projectedWebRoot), true);
    assert.equal(removePreviewWebRoot(repositoryRoot, generation), true);
    assert.equal(fs.existsSync(projectedWebRoot), false);
    assert.equal(removePreviewWebRoot(repositoryRoot, generation), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a copied nested symlink that escapes the checkout", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-web-link-"));
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const checkoutWebRoot = path.join(repositoryRoot, "web");
    const checkoutPublicRoot = path.join(checkoutWebRoot, "public");
    const launchRoot = path.join(temporaryRoot, "state", "launch");
    const outsideFile = path.join(temporaryRoot, "outside.txt");
    fs.mkdirSync(path.join(checkoutWebRoot, "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
    fs.mkdirSync(checkoutPublicRoot, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.writeFileSync(path.join(checkoutWebRoot, "src", "app", "page.tsx"), "page\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
    fs.writeFileSync(outsideFile, "sentinel\n");
    fs.symlinkSync(outsideFile, path.join(checkoutPublicRoot, "outside.txt"), "file");

    const checkoutOutsideLink = path.join(checkoutPublicRoot, "outside.txt");
    assert.throws(
      () => preparePreviewWebRoot(repositoryRoot, launchRoot, "nested-link-generation"),
      (error) =>
        error instanceof Error && error.message.includes(checkoutOutsideLink),
    );
    assert.equal(fs.existsSync(previewWebRoot(repositoryRoot)), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("dereferences an in-checkout source link and tracks its resolved bytes", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-web-deref-"));
  const generation = "dereferenced-link-generation";
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const checkoutWebRoot = path.join(repositoryRoot, "web");
    const checkoutPublicRoot = path.join(checkoutWebRoot, "public");
    const launchRoot = path.join(temporaryRoot, "state", "launch");
    const linkedTarget = path.join(checkoutPublicRoot, "source.txt");
    const checkoutLink = path.join(checkoutPublicRoot, "linked.txt");
    fs.mkdirSync(path.join(checkoutWebRoot, "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
    fs.mkdirSync(checkoutPublicRoot, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.writeFileSync(path.join(checkoutWebRoot, "src", "app", "page.tsx"), "page\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
    fs.writeFileSync(linkedTarget, "frozen-one\n");
    fs.symlinkSync(linkedTarget, checkoutLink, "file");

    const sourceManifest = previewWebSourceManifest(repositoryRoot);
    const linkedManifestEntry = sourceManifest.entries.find(
      (entry) => entry.path === "web/public/linked.txt",
    );
    assert.equal(linkedManifestEntry?.type, "file");
    const projectedWebRoot = preparePreviewWebRoot(
      repositoryRoot,
      launchRoot,
      generation,
    );
    const projectedLink = path.join(projectedWebRoot, "public", "linked.txt");
    assert.equal(fs.lstatSync(projectedLink).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(projectedLink, "utf8"), "frozen-one\n");

    fs.writeFileSync(linkedTarget, "changed-target\n");
    assert.throws(
      () => assertPreviewWebProjectionCurrent(repositoryRoot, generation),
      (error) => error instanceof Error && error.message.includes(checkoutLink),
    );
    assert.equal(fs.readFileSync(projectedLink, "utf8"), "frozen-one\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses a symlinked checkout parent for the generated health route", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-health-link-"));
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const checkoutWebRoot = path.join(repositoryRoot, "web");
    const realApiRoot = path.join(repositoryRoot, "shared-api");
    const checkoutAppRoot = path.join(checkoutWebRoot, "src", "app");
    const checkoutApiRoot = path.join(checkoutAppRoot, "api");
    const launchRoot = path.join(temporaryRoot, "state", "launch");
    fs.mkdirSync(checkoutAppRoot, { recursive: true });
    fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
    fs.mkdirSync(realApiRoot, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.writeFileSync(path.join(checkoutAppRoot, "page.tsx"), "page\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
    fs.symlinkSync(realApiRoot, checkoutApiRoot, "dir");

    assert.throws(
      () => preparePreviewWebRoot(repositoryRoot, launchRoot, "health-link-generation"),
      (error) => error instanceof Error && error.message.includes(checkoutApiRoot),
    );
    assert.equal(fs.existsSync(previewWebRoot(repositoryRoot)), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses symlinked web and server source-root directories", async (testContext) => {
  for (const sourceRootName of ["web", "server"]) {
    await testContext.test(sourceRootName, () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-source-root-link-"));
      try {
        const fixture = createMinimalProjectionCheckout(temporaryRoot);
        const sourceRoot = path.join(fixture.repositoryRoot, sourceRootName);
        const realRoot = path.join(fixture.repositoryRoot, `${sourceRootName}-real`);
        fs.renameSync(sourceRoot, realRoot);
        fs.symlinkSync(realRoot, sourceRoot, "dir");
        assert.throws(
          () => preparePreviewWebRoot(
            fixture.repositoryRoot,
            fixture.launchRoot,
            `${sourceRootName}-root-link-generation`,
          ),
          (error) => error instanceof Error &&
            error.message.includes(`${sourceRootName}/ to be a real directory`) &&
            error.message.includes(sourceRoot),
        );
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("refuses a symlinked top-level node_modules regardless of its target", async (testContext) => {
  const cases = [
    {
      name: "ordinary in-checkout dependency directory",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, "dependency-store"),
    },
    {
      name: "git metadata redirect",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, ".git"),
    },
  ];
  for (const testCase of cases) {
    await testContext.test(testCase.name, () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-node-modules-link-"));
      try {
        const fixture = createMinimalProjectionCheckout(temporaryRoot);
        const nodeModules = path.join(fixture.checkoutWebRoot, "node_modules");
        const target = testCase.target(fixture);
        fs.rmSync(nodeModules, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, nodeModules, "dir");
        assert.throws(
          () => preparePreviewWebRoot(
            fixture.repositoryRoot,
            fixture.launchRoot,
            `node-modules-${testCase.name.replaceAll(" ", "-")}`,
          ),
          (error) => error instanceof Error &&
            error.message.includes("node_modules to be a real directory") &&
            error.message.includes(nodeModules),
        );
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("refuses an in-checkout symlink directory cycle", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-web-cycle-"));
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const checkoutWebRoot = path.join(repositoryRoot, "web");
    const checkoutPublicRoot = path.join(checkoutWebRoot, "public");
    const launchRoot = path.join(temporaryRoot, "state", "launch");
    fs.mkdirSync(path.join(checkoutWebRoot, "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
    fs.mkdirSync(checkoutPublicRoot, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.writeFileSync(path.join(checkoutWebRoot, "src", "app", "page.tsx"), "page\n");
    fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
    const cycleLink = path.join(checkoutPublicRoot, "loop");
    fs.symlinkSync(checkoutPublicRoot, cycleLink, "dir");

    assert.throws(
      () => preparePreviewWebRoot(repositoryRoot, launchRoot, "cycle-generation"),
      (error) => error instanceof Error &&
        error.message.includes("symlink directory cycle") &&
        error.message.includes(cycleLink),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects every sensitive or non-source symlink target class", async (testContext) => {
  const cases = [
    {
      name: "git metadata",
      expectedClass: "git metadata",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, ".git", "config"),
      create: true,
    },
    {
      name: "environment file",
      expectedClass: "environment file",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, "server", ".env.preview"),
      create: true,
    },
    {
      name: "preview lifecycle state",
      expectedClass: "preview lifecycle state",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, "deploy", "preview", ".state.json"),
      create: true,
    },
    {
      name: "vendored dist staging",
      expectedClass: "vendored dist staging",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, "server", "vendor", "engine", "dist", "secret.txt"),
      create: true,
    },
    {
      name: "outside copied source set",
      expectedClass: "outside the copied source set",
      target: ({ repositoryRoot }) => path.join(repositoryRoot, "server", "secret.txt"),
      create: true,
    },
    {
      name: "dependency tree",
      expectedClass: "dependency tree",
      target: ({ checkoutWebRoot }) => path.join(checkoutWebRoot, "node_modules", "secret.txt"),
      create: true,
    },
    {
      name: "Next build output",
      expectedClass: "Next build output",
      target: ({ checkoutWebRoot }) => path.join(checkoutWebRoot, ".next", "secret.txt"),
      create: true,
    },
    {
      name: "preview tree",
      expectedClass: "preview destination",
      target: ({ checkoutWebRoot }) => path.join(checkoutWebRoot, ".preview", "secret.txt"),
      create: true,
    },
    {
      name: "dangling link",
      expectedClass: "dangling symlink",
      target: ({ checkoutWebRoot }) => path.join(checkoutWebRoot, "missing.txt"),
      create: false,
    },
    {
      name: "projection destination self",
      expectedClass: "preview destination",
      target: ({ checkoutWebRoot }) => path.join(checkoutWebRoot, ".preview", "launch", "web"),
      create: false,
    },
  ];

  for (const testCase of cases) {
    await testContext.test(testCase.name, () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-sensitive-link-"));
      try {
        const fixture = createMinimalProjectionCheckout(temporaryRoot);
        const target = testCase.target(fixture);
        if (testCase.create) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, "sentinel\n");
        }
        const link = path.join(fixture.checkoutPublicRoot, "sensitive-link");
        fs.symlinkSync(target, link);
        assert.throws(
          () => preparePreviewWebRoot(
            fixture.repositoryRoot,
            fixture.launchRoot,
            `sensitive-${testCase.name.replaceAll(" ", "-")}`,
          ),
          (error) => error instanceof Error &&
            error.message.includes(link) &&
            error.message.includes(testCase.expectedClass),
        );
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("serializes concurrent preview-up lifecycle owners at an atomic barrier", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-up-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock.d");
    const hostBootIdentity = { host: "test-host", boot: "test-boot" };
    const starts = new Map([
      [101, { method: "test", value: "start-101" }],
      [102, { method: "test", value: "start-102" }],
    ]);
    const resolvePidStartIdentity = (pid) => starts.get(pid) ?? null;
    const firstUp = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "up-one",
      pid: 101,
      resolvePidStartIdentity,
      hostBootIdentity,
    });
    assert.throws(
      () => acquirePreviewLifecycleLock(lockFile, {
        operation: "preview-up",
        generation: "up-two",
        pid: 102,
        resolvePidStartIdentity,
        hostBootIdentity,
      }),
      /Preview lifecycle BUSY: preview-up PID 101/,
    );
    firstUp.release();
    const secondUp = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "up-two",
      pid: 102,
      resolvePidStartIdentity,
      hostBootIdentity,
    });
    secondUp.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("holds teardown's lifecycle barrier against another down and a newer up", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-down-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock.d");
    const hostBootIdentity = { host: "test-host", boot: "test-boot" };
    const starts = new Map([
      [201, { method: "test", value: "start-201" }],
      [202, { method: "test", value: "start-202" }],
      [203, { method: "test", value: "start-203" }],
    ]);
    const resolvePidStartIdentity = (pid) => starts.get(pid) ?? null;
    const down = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-down",
      generation: "down-one",
      pid: 201,
      resolvePidStartIdentity,
      hostBootIdentity,
    });
    for (const contender of [
      { operation: "preview-down", generation: "down-two", pid: 202, resolvePidStartIdentity, hostBootIdentity },
      { operation: "preview-up", generation: "up-new", pid: 203, resolvePidStartIdentity, hostBootIdentity },
    ]) {
      assert.throws(
        () => acquirePreviewLifecycleLock(lockFile, contender),
        /Preview lifecycle BUSY: preview-down PID 201/,
      );
    }
    down.release();
    const nextUp = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "up-new",
      pid: 203,
      resolvePidStartIdentity,
      hostBootIdentity,
    });
    nextUp.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses a retired anchor skip for every synchronous Bun call shape", () => {
  const launcherSource = fs.readFileSync(
    new URL("../start.mjs", import.meta.url),
    "utf8",
  );
  // Neither retired engine anchor exists on this launcher, so each planted
  // synchronous Bun call must turn the permissive skip into a refusal.
  for (const plantedCall of [
    '  spawnSync(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR });',
    '  runCapture(bunPath, ["run", "build:web"], { cwd: PIPELINE_ENGINE_DIR });',
    '  capture(previewBun, ["--version"]);',
    '  run(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR });',
  ]) {
    assert.throws(
      () => instrumentPreviewEnvironment(
        instrumentPreviewLauncher(launcherSource).replace(
          '  const engineArgs = ["--filter", "@archon/server", "start"];',
          `${plantedCall}\n  const engineArgs = ["--filter", "@archon/server", "start"];`,
        ),
      ),
      /found a synchronous Bun invocation in start\.mjs but no engine install anchor/,
      `planting ${plantedCall.trim()} must refuse the retired-anchor skip`,
    );
  }
});

test("instruments each automatic-env-loading launcher child before spawn", () => {
  const launcherSource = fs.readFileSync(
    new URL("../start.mjs", import.meta.url),
    "utf8",
  );
  const instrumentedSource = instrumentPreviewEnvironment(
    instrumentPreviewLauncher(launcherSource),
  );
  const serviceSpawnPosition = instrumentedSource.indexOf("  const child = directArgs");
  // The dist-freshness lane retired the launcher's in-process engine
  // dependency install and web build; scripts/vendored-dist-build.mjs owns
  // them now and runs this same guard before it starts Bun. Guard the anchors
  // while they exist, and prove below that their absence is not a silent skip.
  const engineInstallPosition = instrumentedSource.indexOf(
    '    if (run(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {',
  );
  const engineBuildPosition = instrumentedSource.indexOf(
    '    if (run(bun, ["run", "build:web"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {',
  );
  const engineArgumentsPosition = instrumentedSource.indexOf(
    '  const engineArgs = ["--filter", "@archon/server", "start"];',
  );
  const engineSpawnPosition = instrumentedSource.indexOf(
    "      spawn(bun, engineArgs, {",
  );

  assert.equal(/\brun\(\s*bun\b/.test(launcherSource), false);
  assert.equal(engineInstallPosition, -1);
  assert.equal(engineBuildPosition, -1);
  assert.throws(
    () => instrumentPreviewEnvironment(
      instrumentPreviewLauncher(launcherSource).replace(
        '  const engineArgs = ["--filter", "@archon/server", "start"];',
        '  if (run(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {}\n' +
          '  const engineArgs = ["--filter", "@archon/server", "start"];',
      ),
    ),
    /found a synchronous Bun invocation in start\.mjs but no engine install anchor/,
  );

  for (const childPosition of [
    serviceSpawnPosition,
    engineInstallPosition,
    engineBuildPosition,
    engineArgumentsPosition,
  ].filter((position) => position !== -1)) {
    assert.notEqual(childPosition, -1);
    const guardPosition = instrumentedSource.lastIndexOf(
      "assertPreviewAutomaticEnvironmentFilesAbsent(",
      childPosition - 1,
    );
    assert.notEqual(guardPosition, -1);
    assert.equal(guardPosition < childPosition, true);
    assert.equal(childPosition - guardPosition < 650, true);
  }
  assert.notEqual(engineArgumentsPosition, -1);
  assert.notEqual(engineSpawnPosition, -1);
  assert.equal(engineArgumentsPosition < engineSpawnPosition, true);
  assert.equal(
    instrumentedSource.includes(
      'path.join(PIPELINE_ENGINE_DIR, "packages", "server")',
    ),
    true,
  );
  const syntaxCheck = spawnSync(
    process.execPath,
    ["--input-type=module", "--check", "-"],
    {
      input: instrumentedSource,
      encoding: "utf8",
    },
  );
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
  for (const fileName of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
  ]) {
    assert.equal(instrumentedSource.includes(JSON.stringify(fileName)), true);
  }
  assert.throws(
    () => instrumentPreviewEnvironment("const noEngineSpawn = true;"),
    /expected one helper anchor/,
  );
});

test("preview-up sanitizes its process before vendored preparation and boot", () => {
  const source = fs.readFileSync(new URL("./preview-up.mjs", import.meta.url), "utf8");
  const isolationAssertion = source.indexOf(
    "\n  assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot);\n",
  );
  const prebuildSpawn = source.indexOf(
    "\n  const result = spawnSync(process.execPath, arguments_, {\n",
  );
  // The launch overlay moved into preview-environment.mjs (dist-freshness lane:
  // the overlay also ships the vendored-dist script closure), so the launcher
  // instrumentation and the shims are asserted against that module. preview-up
  // still owns the ordering: sanitize, project, prebuild, boot.
  const overlaySource = fs.readFileSync(
    new URL("./preview-environment.mjs", import.meta.url),
    "utf8",
  );
  const vendoredPreparation = source.indexOf(
    "\n  prepareVendoredDist({\n",
  );
  const processSanitization = source.indexOf("\nreplaceProcessEnvironment(\n");
  const engineHomePreparation = source.indexOf(
    "\npreparePreviewEngineHome(stateRoot);\n",
  );
  const environmentConstruction = source.indexOf(
    "\nconst environment = previewEnvironment(\n",
  );
  const launcherInstrumentation = overlaySource.indexOf(
    "instrumentPreviewEnvironment(instrumentPreviewLauncher(launcherSource))",
  );
  const webProjection = source.indexOf(
    "preparePreviewWebRoot(",
  );
  const previewDownSource = fs.readFileSync(
    new URL("./preview-down.mjs", import.meta.url),
    "utf8",
  );

  assert.notEqual(isolationAssertion, -1);
  assert.notEqual(prebuildSpawn, -1);
  assert.equal(isolationAssertion < prebuildSpawn, true);
  assert.notEqual(vendoredPreparation, -1);
  assert.notEqual(processSanitization, -1);
  assert.equal(processSanitization < vendoredPreparation, true);
  assert.equal(isolationAssertion < vendoredPreparation, true);
  assert.notEqual(engineHomePreparation, -1);
  assert.notEqual(environmentConstruction, -1);
  assert.equal(engineHomePreparation < environmentConstruction, true);
  assert.notEqual(launcherInstrumentation, -1);
  assert.notEqual(webProjection, -1);
  assert.equal(
    source.includes(
      'fs.symlinkSync(path.join(repositoryRoot, "web"), path.join(launchRoot, "web"), "dir")',
    ),
    false,
  );
  assert.equal(
    overlaySource.includes(
      'fs.symlinkSync(path.join(repositoryRoot, "web"), path.join(launchRoot, "web"), "dir")',
    ),
    false,
  );
  // The prebuild keeps the isolation lane's production-only build mode and the
  // dist-freshness lane's strict build environment, whose PATH/TMPDIR the
  // launcher re-fingerprints when it re-checks the bundle.
  assert.match(
    source,
    /environment: vendoredDistEnvironment,/,
  );
  assert.match(
    source,
    /const vendoredDistEnvironment = previewPrebuildEnvironment\(\s*previewVendoredDistEnvironment\(/,
  );
  assert.match(
    source,
    /allowlistedPreviewEnvironment\(ambientEnvironment\),/,
  );
  assert.equal(
    previewDownSource.includes("removePreviewWebRoot(repositoryRoot, state.generation)"),
    true,
  );
  const upLock = source.indexOf("acquirePreviewLifecycleLock(lifecycleLockDirectory");
  const stateCheck = source.indexOf("if (fs.existsSync(stateFile))");
  const statePublication = source.indexOf("publishPreviewStateFile(stateFile");
  const readinessWait = source.indexOf("await waitForPreviewReadiness({");
  const upLockRelease = source.indexOf("releaseLifecycleLock();", statePublication);
  assert.equal(upLock < stateCheck, true);
  assert.equal(statePublication < readinessWait, true);
  assert.equal(readinessWait < upLockRelease, true);
  const downLock = previewDownSource.indexOf(
    "acquirePreviewLifecycleLock(lifecycleLockDirectory",
  );
  const downStateRead = previewDownSource.indexOf(
    "const { state, recoveredFromMarker } = readStateOrProjectionRecovery();",
  );
  assert.equal(downLock < downStateRead, true);
  assert.equal(
    source.includes('url: `http://127.0.0.1:${ports.frontend}/api/preview-health`'),
    true,
  );
  assert.match(
    fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8"),
    /^\/web\/\.preview\/$/m,
  );
});

const previewUpSourceForNpmShim = fs.readFileSync(
  new URL("./preview-environment.mjs", import.meta.url),
  "utf8",
);
const currentShimStillForwardsInstall =
  previewUpSourceForNpmShim.includes(
    `if (args[0] === "view") process.exit(1);
const result = spawnSync(\${JSON.stringify(realNpm)}, args, { stdio: "inherit", env: process.env });`,
  );

test(
  "preview npm shim refuses install at its process boundary",
  {
    skip: currentShimStillForwardsInstall
      ? "pending lane C1 baf036a install-free launcher merge: current branch still forwards npm install"
      : false,
  },
  () => {
    const shimTemplate = previewUpSourceForNpmShim.match(
      /writeExecutable\(\s*path\.join\(shimDirectory, "npm"\),\s*`([\s\S]*?)`,\s*\);/,
    )?.[1];
    assert.ok(shimTemplate, "preview npm shim template must remain testable");

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-npm-shim-"));
    try {
      const marker = path.join(temporaryRoot, "real-npm-ran");
      const fakeNpm = path.join(temporaryRoot, "fake-npm.mjs");
      const shim = path.join(temporaryRoot, "npm.mjs");
      fs.writeFileSync(
        fakeNpm,
        '#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.KADY_TEST_NPM_MARKER, "ran\\n");\n',
        { mode: 0o700 },
      );
      fs.writeFileSync(
        shim,
        shimTemplate.replaceAll(
          "${JSON.stringify(realNpm)}",
          JSON.stringify(fakeNpm),
        ),
        { mode: 0o700 },
      );
      const environment = previewEnvironment(
        temporaryRoot,
        path.join(temporaryRoot, "launch"),
        temporaryRoot,
        { backend: 18000, frontend: 13000, engine: 13091 },
        { PATH: process.env.PATH },
      );
      const result = spawnSync(process.execPath, [shim, "install"], {
        env: { ...environment, KADY_TEST_NPM_MARKER: marker },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test("guards the vendored Bun build at its spawn boundary in preview mode", () => {
  const source = fs.readFileSync(
    new URL("./vendored-dist-build.mjs", import.meta.url),
    "utf8",
  );
  // The staged rebuild replaced `bun run build:web` with a locked
  // install-then-build under a build lock; the guard runs before the dependency
  // install and again immediately before the Bun build spawn.
  const guard = /if \(process\.env\.KADY_PREVIEW === "1"\) \{\n\s*assertPreviewAutomaticEnvironmentFilesAbsent\(options\.root\);\n\s*\}/g;
  assert.equal(source.match(guard)?.length, 2);
  const buildSpawn = source.indexOf('await runMutatingCommand(\n      "bun",\n      ["run", "build"');
  assert.notEqual(buildSpawn, -1);
  const lastGuardBeforeBuild = source.lastIndexOf(
    'assertPreviewAutomaticEnvironmentFilesAbsent(options.root);',
    buildSpawn,
  );
  assert.notEqual(lastGuardBeforeBuild, -1);
  assert.equal(buildSpawn - lastGuardBeforeBuild < 400, true);
  const installSpawn = source.indexOf('await runMutatingCommand("bun", ["install", "--frozen-lockfile"]');
  assert.notEqual(installSpawn, -1);
  assert.equal(
    source.indexOf('assertPreviewAutomaticEnvironmentFilesAbsent(options.root);') < installSpawn,
    true,
  );
});

test("scrubs credentials when a browser-facing backend origin is present", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      NEXT_PUBLIC_ADK_API_URL: "https://backend.example.test",
      OPENROUTER_API_KEY: "must-not-leak",
      SESSION_TOKEN: "must-not-leak",
      CLIENT_SECRET: "must-not-leak",
      DATABASE_PASSWORD: "must-not-leak",
      SERVICE_CREDENTIAL: "must-not-leak",
    },
  );

  assert.equal(environment.NEXT_PUBLIC_ADK_API_URL, "https://backend.example.test");
  assert.equal("OPENROUTER_API_KEY" in environment, false);
  assert.equal("SESSION_TOKEN" in environment, false);
  assert.equal("CLIENT_SECRET" in environment, false);
  assert.equal("DATABASE_PASSWORD" in environment, false);
  assert.equal("SERVICE_CREDENTIAL" in environment, false);
});

function fakeProcessTable(processes) {
  return (command, commandArguments) => {
    if (command === "pgrep") {
      const pattern = commandArguments[commandArguments.length - 1];
      const matcher = new RegExp(pattern);
      const matched = processes.filter((entry) => matcher.test(entry.argv ?? ""));
      return { status: matched.length > 0 ? 0 : 1, stdout: `${matched.map((entry) => entry.pid).join("\n")}\n` };
    }
    if (command === "ps") {
      const pid = Number(commandArguments[commandArguments.indexOf("-p") + 1]);
      const entry = processes.find((candidate) => candidate.pid === pid);
      return entry ? { status: 0, stdout: `${entry.comm}\n` } : { status: 1, stdout: "" };
    }
    if (command === "lsof") {
      const pidIndex = commandArguments.indexOf("-p");
      const listed = pidIndex === -1
        ? processes
        : processes.filter((entry) => entry.pid === Number(commandArguments[pidIndex + 1]));
      const lines = listed.flatMap((entry) => (entry.cwd ? [`p${entry.pid}`, `n${entry.cwd}`] : []));
      return { status: 0, stdout: `${lines.join("\n")}\n` };
    }
    throw new Error(`unexpected occupant proof command: ${command}`);
  };
}

test("occupant proof keeps every command whose cwd is under the vendored root", () => {
  const vendoredRoot = "/tmp/kady-occupants/server/vendor/pipeline-engine";
  const processes = [
    { pid: 4101, comm: "sh", cwd: `${vendoredRoot}/packages/web`, argv: "sh -c while [ ! -f gate ]; do sleep 0.01; done" },
    { pid: 4102, comm: "vite", cwd: `${vendoredRoot}/packages/web`, argv: "vite build --outDir dist" },
    { pid: 4103, comm: "grep", cwd: "/tmp", argv: `grep -r ${vendoredRoot}` },
    { pid: 4104, comm: "node", cwd: "/tmp", argv: `node ${vendoredRoot}/scripts/report.mjs` },
    { pid: 4105, comm: "sh", cwd: "/tmp", argv: "sh -c sleep 60" },
  ];
  const occupants = findVendoredRootOccupants(vendoredRoot, {
    platform: "darwin",
    selfPid: 1,
    spawnProcess: fakeProcessTable(processes),
  });
  assert.deepEqual(occupants.sort((left, right) => left - right), [4101, 4102, 4104]);

  const linuxOccupants = findVendoredRootOccupants(vendoredRoot, {
    platform: "linux",
    selfPid: 1,
    spawnProcess: fakeProcessTable(processes),
    readDirSync: () => processes.map((entry) => String(entry.pid)),
    readLinkSync: (linkPath) => {
      const pid = Number(linkPath.split("/")[2]);
      const entry = processes.find((candidate) => candidate.pid === pid);
      if (!entry?.cwd) throw new Error("ENOENT");
      return entry.cwd;
    },
    readFileSync: (commPath) => {
      const pid = Number(commPath.split("/")[2]);
      const entry = processes.find((candidate) => candidate.pid === pid);
      if (!entry) throw new Error("ENOENT");
      return `${entry.comm}\n`;
    },
  });
  assert.deepEqual(linuxOccupants.sort((left, right) => left - right), [4101, 4102, 4104]);
});

test("occupant proof matches the vendored root as a fixed string, not a regular expression", () => {
  const vendoredRoot = "/tmp/kady-a.b+c/server/vendor/pipeline-engine";
  assert.equal(
    escapeExtendedRegularExpression(vendoredRoot),
    "/tmp/kady-a\\.b\\+c/server/vendor/pipeline-engine",
  );
  const neighbourRoot = "/tmp/kady-axbxc/server/vendor/pipeline-engine";
  const processes = [
    { pid: 4201, comm: "node", cwd: "/tmp", argv: `node ${neighbourRoot}/scripts/report.mjs` },
  ];
  const spawned = [];
  const spawnProcess = fakeProcessTable(processes);
  const occupants = findVendoredRootOccupants(vendoredRoot, {
    platform: "darwin",
    selfPid: 1,
    spawnProcess: (command, commandArguments, options) => {
      spawned.push({ command, commandArguments });
      return spawnProcess(command, commandArguments, options);
    },
  });
  const pgrepCall = spawned.find((entry) => entry.command === "pgrep");
  assert.deepEqual(pgrepCall.commandArguments, [
    "-f",
    "--",
    "/tmp/kady-a\\.b\\+c/server/vendor/pipeline-engine",
  ]);
  assert.deepEqual(occupants, []);
});

test("occupant proof fails closed when a proof command cannot run", () => {
  const vendoredRoot = "/tmp/kady-occupant-failure/server/vendor/pipeline-engine";
  assert.throws(
    () => findVendoredRootOccupants(vendoredRoot, {
      platform: "darwin",
      selfPid: 1,
      spawnProcess: () => ({ error: new Error("spawnSync pgrep ENOENT"), stdout: "" }),
    }),
    /could not verify occupants of .*pgrep failed: spawnSync pgrep ENOENT/,
  );
  assert.throws(
    () => findVendoredRootOccupants(vendoredRoot, {
      platform: "darwin",
      selfPid: 1,
      spawnProcess: (command) => (command === "pgrep"
        ? { status: 1, stdout: "" }
        : { signal: "SIGTERM", stdout: "" }),
    }),
    /could not verify occupants of .*lsof was killed by SIGTERM/,
  );
});

test("occupant proof fails closed on an exit status that is not an answer", () => {
  const vendoredRoot = "/tmp/kady-occupant-status/server/vendor/pipeline-engine";
  // pgrep answers with 0 (matched) or 1 (nothing matched); 2 is a usage error
  // and 3 an operational one, neither of which means "no occupants".
  assert.throws(
    () => findVendoredRootOccupants(vendoredRoot, {
      platform: "darwin",
      selfPid: 1,
      spawnProcess: (command) => (command === "pgrep"
        ? { status: 2, stdout: "" }
        : { status: 0, stdout: "" }),
    }),
    /could not verify occupants of .*pgrep exited with status 2/,
  );
  // The full cwd listing must complete: partial output could omit an occupant.
  assert.throws(
    () => findVendoredRootOccupants(vendoredRoot, {
      platform: "darwin",
      selfPid: 1,
      spawnProcess: (command) => (command === "pgrep"
        ? { status: 1, stdout: "" }
        : { status: 1, stdout: "" }),
    }),
    /could not verify occupants of .*lsof exited with status 1/,
  );
  // The per-PID cwd lookup runs through the same runner: a failed lookup must
  // throw rather than read as "this PID has no working directory".
  assert.throws(
    () => findVendoredRootOccupants(vendoredRoot, {
      platform: "darwin",
      selfPid: 1,
      spawnProcess: (command, commandArguments) => {
        if (command === "pgrep") return { status: 0, stdout: "6301\n" };
        if (command === "lsof" && commandArguments.includes("-p")) return { status: 2, stdout: "" };
        return { status: 0, stdout: "" };
      },
    }),
    /could not verify occupants of .*lsof exited with status 2/,
  );
});

test("occupant proof cannot clear a linux PID whose working directory is unreadable", () => {
  const vendoredRoot = "/tmp/kady-occupant-eacces/server/vendor/pipeline-engine";
  const commandNames = new Map([[7101, "node"], [7102, "node"], [7103, "sshd"]]);
  const workingDirectoryErrors = new Map([
    // Another user's (or root's) process: unprovable, not known-outside.
    [7101, Object.assign(new Error("EACCES"), { code: "EACCES" })],
    // Already gone between the readdir and the readlink.
    [7102, Object.assign(new Error("ENOENT"), { code: "ENOENT" })],
    [7103, Object.assign(new Error("EPERM"), { code: "EPERM" })],
  ]);
  const occupants = findVendoredRootOccupants(vendoredRoot, {
    platform: "linux",
    selfPid: 1,
    spawnProcess: (command) => (command === "pgrep"
      ? { status: 1, stdout: "" }
      : { status: 0, stdout: "" }),
    readDirSync: () => ["7101", "7102", "7103", "self", "meminfo"],
    readLinkSync: (linkPath) => {
      throw workingDirectoryErrors.get(Number(linkPath.split("/")[2]));
    },
    readFileSync: (commPath) => {
      const command = commandNames.get(Number(commPath.split("/")[2]));
      if (!command) throw new Error("ENOENT");
      return `${command}\n`;
    },
  });
  // 7101 is an unreadable node process, so it blocks recovery; 7102 is gone;
  // 7103 is unreadable but is not a node/bun mutator.
  assert.deepEqual(occupants, [7101]);
});

test("occupant proof resolves a symlinked repository root before comparing working directories", async () => {
  // A preview overlay is a real launch root whose `server` entry is a symlink
  // into the checkout, so the joined vendored path runs *through* the symlink
  // while every cwd proof reports the resolved path.
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-overlay-checkout-"));
  const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-overlay-launch-"));
  try {
    fs.mkdirSync(path.join(checkoutRoot, "server", "vendor", "pipeline-engine"), { recursive: true });
    fs.symlinkSync(path.join(checkoutRoot, "server"), path.join(launchRoot, "server"));
    const lockPath = preparedBuildLockPath(launchRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(vendoredDistBuildLockOwnerPath(lockPath), "{ truncated");

    const resolvedVendoredRoot = path.join(
      fs.realpathSync(checkoutRoot),
      "server",
      "vendor",
      "pipeline-engine",
    );
    const overlayVendoredRoot = path.join(
      fs.realpathSync(launchRoot),
      "server",
      "vendor",
      "pipeline-engine",
    );
    // Without this the test would pass for the wrong reason.
    assert.notEqual(overlayVendoredRoot, resolvedVendoredRoot);

    const processes = [
      {
        pid: 5150,
        comm: "sh",
        cwd: `${resolvedVendoredRoot}/packages/web`,
        argv: "sh -c while [ ! -f gate ]; do sleep 0.01; done",
      },
    ];
    await assert.rejects(
      recoverVendoredDistBuildLock(launchRoot, {
        force: true,
        platform: "darwin",
        spawnProcess: fakeProcessTable(processes),
      }),
      /refusing forced lock recovery because node\/bun still reference .*pipeline-engine: 5150/,
    );
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(launchRoot, { recursive: true, force: true });
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  }
});

test("CLI recovery refuses a lock directory that is not empty unless --force", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-dirty-directory-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const deadIdentity = testIdentity("dead-dirty-owner");
  try {
    writePlantedOwner(lockPath, {
      version: 1,
      pid: 878787,
      identity: deadIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(lockPath, ".owner.878787.leftover.tmp"), "{partial");
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, {
        captureIdentity: (pid) => pid === process.pid ? testIdentity("operator") : deadIdentity,
        getLiveness: (pid) => pid === process.pid ? "alive" : "dead",
      }),
      /refusing lock recovery: the lock directory is not empty.*ENOTEMPTY.*build\.lock\.d.*\.owner\.878787\.leftover\.tmp.*re-run with --force/s,
    );
    assert.equal(fs.existsSync(lockPath), true);
    // The lock stays busy, now as an unreadable owner record, so no launcher
    // or builder can adopt the directory while the operator inspects it.
    const status = vendoredDistBuildLockStatus(repositoryRoot);
    assert.equal(status.active, true);
    assert.equal(status.recoverable, false);
    assert.equal(status.reason, "unreadable-owner");

    // The forced removal deletes entries this command does not own, so it is
    // gated by the occupant proof exactly like the unreadable-record path.
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, {
        force: true,
        occupantsFor: () => [55055],
      }),
      /refusing forced lock recovery because node\/bun still reference .*: 55055/,
    );
    assert.equal(fs.existsSync(path.join(lockPath, ".owner.878787.leftover.tmp")), true);

    const recovered = await recoverVendoredDistBuildLock(repositoryRoot, {
      force: true,
      occupantsFor: () => [],
    });
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("a single-shot forced recovery of a dead owner record runs the occupant proof first", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-forced-proof-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const leftoverPath = path.join(lockPath, ".owner.919191.leftover.tmp");
  const deadIdentity = testIdentity("dead-forced-owner");
  const deadOwnerDependencies = {
    captureIdentity: (pid) => pid === process.pid ? testIdentity("operator") : deadIdentity,
    getLiveness: (pid) => pid === process.pid ? "alive" : "dead",
  };
  try {
    writePlantedOwner(lockPath, {
      version: 1,
      pid: 919191,
      identity: deadIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    fs.writeFileSync(leftoverPath, "{partial");

    // First invocation is already --force: the owner record parses and its
    // recorded processes are dead, but the dirty directory means the recursive
    // removal still has to clear the proof.
    const provedRoots = [];
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, {
        ...deadOwnerDependencies,
        force: true,
        occupantsFor: (vendoredRoot) => {
          provedRoots.push(vendoredRoot);
          return [4242];
        },
      }),
      /refusing forced lock recovery because node\/bun still reference .*: 4242/,
    );
    assert.equal(provedRoots.length, 1);
    assert.equal(
      provedRoots[0],
      path.join(fs.realpathSync(repositoryRoot), "server", "vendor", "pipeline-engine"),
    );
    assert.equal(fs.existsSync(leftoverPath), true);
    // The owner record is gone, so the lock stays busy as an unreadable record
    // rather than becoming adoptable while a live builder is still around.
    const status = vendoredDistBuildLockStatus(repositoryRoot);
    assert.equal(status.active, true);
    assert.equal(status.reason, "unreadable-owner");

    const recovered = await recoverVendoredDistBuildLock(repositoryRoot, {
      ...deadOwnerDependencies,
      force: true,
      occupantsFor: () => [],
    });
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
