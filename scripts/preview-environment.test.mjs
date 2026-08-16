import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allowlistedPreviewEnvironment,
  assertPreviewEngineEnvironmentFilesAbsent,
  instrumentPreviewEnvironment,
  preparePreviewEngineHome,
  previewEngineEnvironmentFiles,
  previewEnvironment,
} from "./preview-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";

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
  assert.equal(environment.KADY_ENV_FILE, "/tmp/kady-preview-test/launch/.env");
  assert.equal(environment.ARCHON_HOME, "/tmp/kady-preview-test/pipeline-engine-home");
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
    "NODE_ENV",
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
});

test("isolates engine env discovery and rejects every engine-owned env file", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-engine-env-"));
  try {
    const stateRoot = path.join(temporaryRoot, "state");
    const launchRoot = path.join(stateRoot, "launch");
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const ambientEngineHome = path.join(temporaryRoot, "ambient-engine-home");
    const forbiddenEnvironmentFiles = previewEngineEnvironmentFiles(repositoryRoot);
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(ambientEngineHome, { recursive: true });
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

    assert.equal(forbiddenEnvironmentFiles.length, 11);
    for (const forbiddenEnvironmentFile of forbiddenEnvironmentFiles) {
      fs.mkdirSync(path.dirname(forbiddenEnvironmentFile), { recursive: true });
      fs.writeFileSync(forbiddenEnvironmentFile, "OPENROUTER_API_KEY=sentinel\n");
      assert.throws(
        () => assertPreviewEngineEnvironmentFilesAbsent(repositoryRoot),
        (error) =>
          error instanceof Error && error.message.includes(forbiddenEnvironmentFile),
      );
      fs.unlinkSync(forbiddenEnvironmentFile);
    }
    assert.doesNotThrow(() => assertPreviewEngineEnvironmentFilesAbsent(repositoryRoot));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("instruments the actual engine launcher immediately before spawn", () => {
  const launcherSource = fs.readFileSync(
    new URL("../start.mjs", import.meta.url),
    "utf8",
  );
  const instrumentedSource = instrumentPreviewEnvironment(
    instrumentPreviewLauncher(launcherSource),
  );
  const guardPosition = instrumentedSource.indexOf(
    '  if (process.env.KADY_PREVIEW === "1") {',
  );
  const engineArgumentsPosition = instrumentedSource.indexOf(
    '  const engineArgs = ["--filter", "@archon/server", "start"];',
  );
  const engineSpawnPosition = instrumentedSource.indexOf(
    "      spawn(bun, engineArgs, {",
  );

  assert.notEqual(guardPosition, -1);
  assert.notEqual(engineArgumentsPosition, -1);
  assert.notEqual(engineSpawnPosition, -1);
  assert.equal(guardPosition < engineArgumentsPosition, true);
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
    ".env.production",
    ".env.test",
  ]) {
    assert.equal(instrumentedSource.includes(JSON.stringify(fileName)), true);
  }
  assert.throws(
    () => instrumentPreviewEnvironment("const noEngineSpawn = true;"),
    /expected one engine spawn anchor/,
  );
});

test("preview-up sanitizes its process before vendored preparation and boot", () => {
  const source = fs.readFileSync(new URL("./preview-up.mjs", import.meta.url), "utf8");
  const isolationAssertion = source.indexOf(
    "\nassertPreviewEngineEnvironmentFilesAbsent(repositoryRoot);\n",
  );
  const vendoredPreparation = source.indexOf(
    "\nprepareVendoredDist({ skipBuild: process.argv.includes(\"--no-build-dist\") });\n",
  );
  const processSanitization = source.indexOf("\nreplaceProcessEnvironment(\n");
  const engineHomePreparation = source.indexOf(
    "\npreparePreviewEngineHome(stateRoot);\n",
  );
  const environmentConstruction = source.indexOf(
    "\nconst environment = previewEnvironment(\n",
  );
  const launcherInstrumentation = source.indexOf(
    "instrumentPreviewEnvironment(instrumentPreviewLauncher(launcherSource))",
  );

  assert.notEqual(isolationAssertion, -1);
  assert.notEqual(vendoredPreparation, -1);
  assert.notEqual(processSanitization, -1);
  assert.equal(processSanitization < vendoredPreparation, true);
  assert.equal(isolationAssertion < vendoredPreparation, true);
  assert.notEqual(engineHomePreparation, -1);
  assert.notEqual(environmentConstruction, -1);
  assert.equal(engineHomePreparation < environmentConstruction, true);
  assert.notEqual(launcherInstrumentation, -1);
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
