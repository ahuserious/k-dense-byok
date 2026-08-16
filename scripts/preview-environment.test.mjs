import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPreviewEngineCwdIsolated,
  preparePreviewEngineHome,
  previewEnvironment,
} from "./preview-environment.mjs";

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

test("isolates engine env discovery and rejects engine-owned env files before boot", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-engine-env-"));
  try {
    const stateRoot = path.join(temporaryRoot, "state");
    const launchRoot = path.join(stateRoot, "launch");
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    const ambientEngineHome = path.join(temporaryRoot, "ambient-engine-home");
    const engineCwd = path.join(
      repositoryRoot,
      "server",
      "vendor",
      "pipeline-engine",
    );
    const cwdEnvPath = path.join(engineCwd, ".archon", ".env");
    const vendoredRootEnvPath = path.join(engineCwd, ".env");
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(ambientEngineHome, { recursive: true });
    fs.mkdirSync(path.dirname(cwdEnvPath), { recursive: true });
    fs.writeFileSync(
      path.join(ambientEngineHome, ".env"),
      "OPENROUTER_API_KEY=sentinel\n",
    );
    fs.writeFileSync(cwdEnvPath, "OPENROUTER_API_KEY=sentinel\n");

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

    assert.throws(
      () => assertPreviewEngineCwdIsolated(repositoryRoot),
      (error) =>
        error instanceof Error &&
        error.message.includes("<cwd>/.archon/.env") &&
        error.message.includes(cwdEnvPath),
    );

    fs.unlinkSync(cwdEnvPath);
    fs.writeFileSync(vendoredRootEnvPath, "OPENROUTER_API_KEY=sentinel\n");
    assert.throws(
      () => assertPreviewEngineCwdIsolated(repositoryRoot),
      (error) =>
        error instanceof Error &&
        error.message.includes("vendored-root .env") &&
        error.message.includes(vendoredRootEnvPath),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview-up runs engine env assertions before vendored preparation and boot", () => {
  const source = fs.readFileSync(new URL("./preview-up.mjs", import.meta.url), "utf8");
  const isolationAssertion = source.indexOf(
    "\nassertPreviewEngineCwdIsolated(repositoryRoot);\n",
  );
  const vendoredPreparation = source.indexOf(
    "\nprepareVendoredDist({ skipBuild: process.argv.includes(\"--no-build-dist\") });\n",
  );
  const engineHomePreparation = source.indexOf(
    "\npreparePreviewEngineHome(stateRoot);\n",
  );
  const environmentConstruction = source.indexOf(
    "\nconst environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports);\n",
  );

  assert.notEqual(isolationAssertion, -1);
  assert.notEqual(vendoredPreparation, -1);
  assert.equal(isolationAssertion < vendoredPreparation, true);
  assert.notEqual(engineHomePreparation, -1);
  assert.notEqual(environmentConstruction, -1);
  assert.equal(engineHomePreparation < environmentConstruction, true);
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
