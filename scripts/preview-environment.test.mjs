import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LEGACY_ENGINE_DATA_DIRECTORY } from "../server/src/legacy-engine-data.ts";
import {
  allowlistedPreviewEnvironment,
  assertPreviewWebProjectionCurrent,
  assertPreviewAutomaticEnvironmentFilesAbsent,
  instrumentPreviewEnvironment,
  preparePreviewEngineHome,
  preparePreviewWebRoot,
  previewAutomaticEnvironmentFiles,
  previewEnvironment,
  previewPrebuildEnvironment,
  previewWebSourceManifest,
  previewWebRoot,
  removePreviewWebRoot,
} from "./preview-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";
import { acquirePreviewLifecycleLock } from "./preview-state.mjs";

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
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
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
    });
    assert.throws(
      () => acquirePreviewLifecycleLock(lockFile, {
        operation: "preview-up",
        generation: "up-two",
        pid: 102,
        resolvePidStartIdentity,
      }),
      /Preview lifecycle is busy: preview-up PID 101/,
    );
    firstUp.release();
    const secondUp = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "up-two",
      pid: 102,
      resolvePidStartIdentity,
    });
    secondUp.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("holds teardown's lifecycle barrier against another down and a newer up", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-down-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
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
    });
    for (const contender of [
      { operation: "preview-down", generation: "down-two", pid: 202, resolvePidStartIdentity },
      { operation: "preview-up", generation: "up-new", pid: 203, resolvePidStartIdentity },
    ]) {
      assert.throws(
        () => acquirePreviewLifecycleLock(lockFile, contender),
        /Preview lifecycle is busy: preview-down PID 201/,
      );
    }
    down.release();
    const nextUp = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "up-new",
      pid: 203,
      resolvePidStartIdentity,
    });
    nextUp.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
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

  for (const childPosition of [
    serviceSpawnPosition,
    engineInstallPosition,
    engineBuildPosition,
    engineArgumentsPosition,
  ]) {
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
  const vendoredPreparation = source.indexOf(
    "\nprepareVendoredDist({\n",
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
    source.includes("environment: previewPrebuildEnvironment(process.env)"),
    true,
  );
  assert.equal(
    previewDownSource.includes("removePreviewWebRoot(repositoryRoot, state.generation)"),
    true,
  );
  const upLock = source.indexOf("acquirePreviewLifecycleLock(lifecycleLockFile");
  const stateCheck = source.indexOf("if (fs.existsSync(stateFile))");
  const statePublication = source.indexOf("publishPreviewStateFile(stateFile");
  const readinessWait = source.indexOf("await waitForPreviewReadiness({");
  const upLockRelease = source.indexOf("releaseLifecycleLock();", statePublication);
  assert.equal(upLock < stateCheck, true);
  assert.equal(statePublication < readinessWait, true);
  assert.equal(readinessWait < upLockRelease, true);
  const downLock = previewDownSource.indexOf(
    "acquirePreviewLifecycleLock(lifecycleLockFile",
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
  new URL("./preview-up.mjs", import.meta.url),
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
  assert.match(
    source,
    /if \(process\.env\.KADY_PREVIEW === "1"\) \{\n  assertPreviewAutomaticEnvironmentFilesAbsent\(repositoryRoot\);\n\}\nconst build = spawnSync\("bun", \["run", "build:web"\]/,
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
