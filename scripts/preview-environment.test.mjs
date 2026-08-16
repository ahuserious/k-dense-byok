import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLaunchOverlay, previewEnvironment } from "./preview-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

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
