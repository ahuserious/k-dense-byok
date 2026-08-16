import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLaunchOverlay, previewEnvironment } from "./preview-environment.mjs";
import {
  acquireVendoredDistBuildLock,
  missingPreviewLauncherDependencies,
  prepareLauncherDependencies,
  previewVendoredDistFingerprintEnvironment,
  previewVendoredDistEnvironment,
  scrubSensitiveEnvironment,
  vendoredDistBuildLockPath,
} from "./vendored-dist-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

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

test("failed build-lock record writes remove the partial lock", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-write-failure-"));
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
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

test("malformed build locks are reclaimed after a bounded backoff", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-malformed-"));
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  try {
    fs.writeFileSync(lockPath, "{partial");
    const lock = await acquireVendoredDistBuildLock(repositoryRoot, { waitMs: 250, pollMs: 5 });
    assert.equal(fs.existsSync(lockPath), true);
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("persistent malformed-lock contention reaches its deadline", async () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lock-deadline-"));
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
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
