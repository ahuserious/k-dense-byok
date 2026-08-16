import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLaunchOverlay, previewEnvironment } from "./preview-environment.mjs";
import {
  acquireVendoredDistBuildLock,
  captureProcessIdentity,
  latchOwnedProcessGroupRetirement,
  missingPreviewLauncherDependencies,
  prepareLauncherDependencies,
  previewVendoredDistFingerprintEnvironment,
  previewVendoredDistEnvironment,
  processLiveness,
  recoverVendoredDistBuildLock,
  recordedProcessState,
  scrubSensitiveEnvironment,
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

test("preview launcher preserves an explicitly ambient NODE_ENV only", () => {
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
  assert.equal(explicit.NODE_ENV, "test");
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
  assert.equal(recordedProcessState(44, recorded, {
    getLiveness: () => "alive",
    captureIdentity: () => ({ ...recorded, host: "other-host" }),
  }), "unverifiable");
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
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("malformed build locks are never reclaimed and time out with metadata", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-malformed-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    fs.writeFileSync(lockPath, "{partial");
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 30, pollMs: 5 }),
      /timed out waiting for vendored dist build lock held by pid unknown, identity "unknown".*owner=unreadable-or-malformed.*node scripts\/vendored-dist-build\.mjs --recover-lock/,
    );
    assert.equal(fs.readFileSync(lockPath, "utf-8"), "{partial");
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("dead vendored-dist build-lock owner is recovered", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-dead-owner-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const recoveryMessages = [];
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: 1,
      token: "dead-owner-token",
      pid: 424242,
      identity: testIdentity("dead-owner-start"),
      heartbeat: "2026-08-16T00:00:00.000Z",
      workers: [],
    })}\n`);
    const lock = await acquireVendoredDistBuildLock(repositoryRoot, {
      captureIdentity: (pid) => testIdentity(pid === process.pid ? "contender-start" : "dead-owner-start"),
      getLiveness: (pid) => pid === process.pid ? "alive" : "dead",
      logRecovery: (message) => recoveryMessages.push(message),
    });
    assert.deepEqual(recoveryMessages, [
      `recovered stale vendored-dist build lock (pid 424242, identity ${JSON.stringify(testIdentity("dead-owner-start"))})`,
    ]);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token, lock.token);
    lock.release();
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("reused PID with a different start identity is recovered", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-pid-reuse-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const recoveryMessages = [];
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: 1,
      token: "reused-pid-token",
      pid: 434343,
      identity: testIdentity("previous-process-start"),
      heartbeat: new Date().toISOString(),
      workers: [],
    })}\n`);
    const lock = await acquireVendoredDistBuildLock(repositoryRoot, {
      captureIdentity: (pid) => testIdentity(pid === process.pid
        ? "contender-start"
        : "replacement-process-start"),
      getLiveness: () => "alive",
      logRecovery: (message) => recoveryMessages.push(message),
    });
    assert.deepEqual(recoveryMessages, [
      `recovered stale vendored-dist build lock (pid 434343, identity ${JSON.stringify(testIdentity("previous-process-start"))})`,
    ]);
    lock.release();
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("a surviving recorded Bun worker prevents dead-wrapper recovery", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-live-worker-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const workerIdentity = testIdentity("worker-start");
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: 2,
      token: "dead-wrapper-live-worker",
      pid: 454545,
      identity: testIdentity("dead-wrapper-start"),
      heartbeat: new Date().toISOString(),
      workers: [{
        pid: 464646,
        identity: workerIdentity,
        phase: "build",
        startedAt: new Date().toISOString(),
      }],
    })}\n`);
    const dependencies = {
      captureIdentity: (pid) => pid === process.pid ? testIdentity("contender") : workerIdentity,
      getLiveness: (pid) => pid === 454545 ? "dead" : "alive",
    };
    await assert.rejects(
      recoverVendoredDistBuildLock(repositoryRoot, dependencies),
      /refusing lock recovery \(same\).*464646/,
    );
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, {
        ...dependencies,
        waitMs: 30,
        pollMs: 5,
      }),
      /timed out waiting for vendored dist build lock.*464646/,
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token, "dead-wrapper-live-worker");
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("recovery guard serializes two stale-owner recoverers through reacquisition", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-recovery-race-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const validatedPath = path.join(repositoryRoot, "first-validated");
  const releaseValidationPath = path.join(repositoryRoot, "release-validation");
  const firstAcquiredPath = path.join(repositoryRoot, "first-acquired");
  const releaseFirstPath = path.join(repositoryRoot, "release-first");
  const secondAcquiredPath = path.join(repositoryRoot, "second-acquired");
  const children = [];
  const waitForFile = async (filePath, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(filePath), true, `timed out waiting for ${filePath}`);
  };
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: 2,
      token: "stale-token",
      pid: 999999,
      identity: testIdentity("dead"),
      heartbeat: new Date().toISOString(),
      workers: [],
    })}\n`);
    const moduleUrl = new URL("./vendored-dist-environment.mjs", import.meta.url).href;
    const childSource = `
import fs from "node:fs";
import { acquireVendoredDistBuildLock } from ${JSON.stringify(moduleUrl)};
const [root, role, validated, releaseValidation, acquired, release] = process.argv.slice(1);
const options = { waitMs: 5000, pollMs: 10 };
if (role === "first") options.afterStaleLockValidated = async () => {
  fs.writeFileSync(validated, "validated");
  while (!fs.existsSync(releaseValidation)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const lock = await acquireVendoredDistBuildLock(root, options);
fs.writeFileSync(acquired, String(process.pid));
while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
lock.release();
`;
    const first = spawn(process.execPath, ["--input-type=module", "-e", childSource,
      repositoryRoot, "first", validatedPath, releaseValidationPath, firstAcquiredPath, releaseFirstPath]);
    children.push(first);
    await waitForFile(validatedPath);
    const second = spawn(process.execPath, ["--input-type=module", "-e", childSource,
      repositoryRoot, "second", validatedPath, releaseValidationPath, secondAcquiredPath, releaseFirstPath]);
    children.push(second);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(fs.existsSync(secondAcquiredPath), false, "guard loser acquired during stale-record revalidation");
    fs.writeFileSync(releaseValidationPath, "go");
    await waitForFile(firstAcquiredPath);
    assert.equal(fs.existsSync(secondAcquiredPath), false, "guard loser unlinked the successor lock");
    fs.writeFileSync(releaseFirstPath, "go");
    await waitForFile(secondAcquiredPath);
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

test("persistent malformed-lock contention reaches its deadline", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-deadline-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  const lockExistsError = Object.assign(new Error("injected contention"), { code: "EEXIST" });
  try {
    fs.writeFileSync(lockPath, "{partial");
    const startedAt = Date.now();
    await assert.rejects(
      acquireVendoredDistBuildLock(repositoryRoot, {
        waitMs: 30,
        pollMs: 5,
        lockFileSystem: {
          openSync() {
            throw lockExistsError;
          },
        },
      }),
      /timed out waiting for vendored dist build lock/,
    );
    assert.ok(Date.now() - startedAt < 500, "lock recovery must not spin past its deadline");
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("an old-heartbeat build lock remains active while its exact owner is live", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-live-owner-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const lock = await acquireVendoredDistBuildLock(repositoryRoot);
    const ownerRecord = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    ownerRecord.heartbeat = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.writeFileSync(lockPath, `${JSON.stringify(ownerRecord)}\n`);
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
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token, lock.token);
    lock.release();
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("build lock ownership is revalidated before mutations and promotion", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-token-loss-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const lock = await acquireVendoredDistBuildLock(repositoryRoot);
    const replacement = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    replacement.token = "replacement-owner-token";
    fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
    assert.throws(() => lock.assertOwned("dependency installation"), /ownership was lost/);
    assert.throws(() => lock.assertOwned("dist promotion"), /ownership was lost/);
    lock.release();
    assert.equal(fs.existsSync(lockPath), true, "the old owner must not remove its successor's lock");
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("two lock contenders serialize without deleting the first owner's record", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-two-contenders-"));
  const lockPath = preparedBuildLockPath(repositoryRoot);
  try {
    const first = await acquireVendoredDistBuildLock(repositoryRoot);
    const firstContents = fs.readFileSync(lockPath, "utf-8");
    const secondPromise = acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 500, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.readFileSync(lockPath, "utf-8"), firstContents);
    first.release();
    const second = await secondPromise;
    assert.notEqual(second.token, first.token);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf-8")).token, second.token);
    second.release();
  } finally {
    fs.rmSync(lockPath, { force: true });
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
  assert.equal(environment.HOME, "/tmp/kady-preview-test/home");
  assert.equal(environment.PATH, "/tmp/kady-preview-test/launch/bin:/usr/bin");
  assert.equal(environment.npm_config_cache, "/tmp/kady-preview-test/npm-cache");
  assert.equal(environment.KADY_PREVIEW_SERVICE_STATE_FILE, "/tmp/kady-preview-test/services.json");
  assert.equal("ARCHON_BASE_URL" in environment, false);
  assert.equal("NEXT_PUBLIC_ARCHON_URL" in environment, false);
  assert.equal("KADY_ARCHON_PORT" in environment, false);
  assert.equal("npm_config_offline" in environment, false);
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
