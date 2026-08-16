import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkVendoredDist,
  writeVendoredDistManifest,
} from "./vendored-dist-check.mjs";
import { classifyVendoredDistAfterBuildFailure } from "./vendored-dist-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkerPath = path.join(scriptDirectory, "vendored-dist-check.mjs");
const builderPath = path.join(scriptDirectory, "vendored-dist-build.mjs");
const gitHeadA = "a".repeat(40);
const gitHeadB = "b".repeat(40);
const vendoredRelative = path.join("server", "vendor", "pipeline-engine");
const webRelative = path.join(vendoredRelative, "packages", "web");
const distRelative = path.join(webRelative, "dist");
const manifestRelative = path.join(distRelative, ".vendored-dist-manifest.json");
const sourceRelative = path.join(webRelative, "src", "main.tsx");
const publicRelative = path.join(webRelative, "public", "logo.svg");
const outputAssetRelative = path.join(distRelative, "assets", "app.js");

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function installCommand(fakeBin, name, source) {
  const modulePath = path.join(fakeBin, `${name}.mjs`);
  writeExecutable(modulePath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(fakeBin, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${modulePath}" %*\r\n`,
    );
  } else {
    const commandPath = path.join(fakeBin, name);
    writeExecutable(
      commandPath,
      `#!${process.execPath}\nimport ${JSON.stringify(modulePath)};\n`,
    );
  }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-dist-check-"));
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  installCommand(
    fakeBin,
    "git",
    `if (process.argv.slice(2).join(" ") !== "rev-parse HEAD") process.exit(2);
process.stdout.write(process.env.FAKE_GIT_HEAD ?? "unknown");
`,
  );

  writeFile(root, sourceRelative, "export const app = 'fixture';\n");
  writeFile(root, publicRelative, "<svg/>\n");
  writeFile(root, path.join(vendoredRelative, "packages", "core", "src", "index.ts"), "export {};\n");
  writeFile(root, path.join(vendoredRelative, "packages", "workflows", "src", "index.ts"), "export {};\n");
  writeFile(root, path.join(webRelative, "index.html"), "<div id='root'></div>\n");
  writeFile(root, path.join(webRelative, "package.json"), "{}\n");
  writeFile(root, path.join(webRelative, "vite.config.ts"), "export default {};\n");
  writeFile(root, path.join(webRelative, "tsconfig.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "bun.lock"), "lockfileVersion = 1\n");
  writeFile(root, path.join(vendoredRelative, "package.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "tsconfig.json"), "{}\n");
  writeDist(root);

  const environment = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_GIT_HEAD: gitHeadA,
    NODE_ENV: "production",
    PORT: "3090",
  };
  return { root, fakeBin, environment };
}

function withFixture(callback) {
  const fixture = createFixture();
  try {
    callback(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function writeDist(root, indexHtml = "<script src='/assets/app.js'></script>\n") {
  writeFile(root, path.join(distRelative, "index.html"), indexHtml);
  writeFile(root, outputAssetRelative, "console.log('fixture');\n");
}

function writeManifest(fixture) {
  return writeVendoredDistManifest(fixture.root, fixture.environment);
}

function runCheck(fixture, ...arguments_) {
  return spawnSync(process.execPath, [checkerPath, "--root", fixture.root, ...arguments_], {
    encoding: "utf-8",
    env: fixture.environment,
  });
}

test("fresh manifest and complete outputs pass", () => {
  withFixture((fixture) => {
    const manifest = writeManifest(fixture);
    const result = checkVendoredDist(fixture.root, fixture.environment);

    assert.equal(result.ok, true);
    assert.equal(result.status, "fresh");
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.gitHead, gitHeadA);
    assert.deepEqual(manifest.buildEnv, { NODE_ENV: "production", PORT: "3090" });
    assert.deepEqual(manifest.outputs.map(({ path: outputPath }) => outputPath), [
      "assets/app.js",
      "index.html",
    ]);
  });
});

test("changed source fails with a named input hash mismatch", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.appendFileSync(path.join(fixture.root, sourceRelative), "export const changed = true;\n");

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-inputs");
    assert.equal(result.reason, "input-hash-mismatch");
    assert.equal(result.path, sourceRelative.split(path.sep).join("/"));
    assert.match(result.message, /input hash mismatch/);
  });
});

test("changed public asset fails with a named input hash mismatch", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.writeFileSync(path.join(fixture.root, publicRelative), "<svg>changed</svg>\n");

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-inputs");
    assert.equal(result.reason, "input-hash-mismatch");
    assert.equal(result.path, publicRelative.split(path.sep).join("/"));
  });
});

test("changed web env file fails with a named input hash mismatch", () => {
  withFixture((fixture) => {
    const envRelative = path.join(webRelative, ".env.production");
    writeFile(fixture.root, envRelative, "PORT=3090\n");
    writeManifest(fixture);
    fs.writeFileSync(path.join(fixture.root, envRelative), "PORT=4090\n");

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-inputs");
    assert.equal(result.reason, "input-hash-mismatch");
    assert.equal(result.path, envRelative.split(path.sep).join("/"));
  });
});

test("changed Git HEAD fails even when files are unchanged", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const changedEnvironment = { ...fixture.environment, FAKE_GIT_HEAD: gitHeadB };

    const result = checkVendoredDist(fixture.root, changedEnvironment);
    assert.equal(result.status, "stale-git-head");
    assert.equal(result.reason, "git-head-mismatch");
    assert.equal(result.expected, gitHeadA);
    assert.equal(result.actual, gitHeadB);
  });
});

test("changed Vite build environment fails", () => {
  withFixture((fixture) => {
    writeManifest(fixture);

    const result = checkVendoredDist(fixture.root, { ...fixture.environment, PORT: "4090" });
    assert.equal(result.status, "stale-build-env");
    assert.equal(result.path, "PORT");
    assert.equal(result.expected, "3090");
    assert.equal(result.actual, "4090");
  });
});

test("deleted manifest output fails and names the missing file", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.rmSync(path.join(fixture.root, outputAssetRelative));

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-output");
    assert.equal(result.reason, "missing-output");
    assert.equal(result.path, outputAssetRelative.split(path.sep).join("/"));
  });
});

test("invalid output takes precedence over stale inputs", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.appendFileSync(path.join(fixture.root, sourceRelative), "export const changed = true;\n");
    fs.rmSync(path.join(fixture.root, outputAssetRelative));

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-output");
    assert.equal(result.reason, "missing-output");
    assert.equal(classifyVendoredDistAfterBuildFailure(result), "skip-engine");
  });
});

test("launcher serves only output-valid stale bundles after a rebuild failure", () => {
  for (const status of ["stale-inputs", "stale-git-head", "stale-build-env"]) {
    assert.equal(classifyVendoredDistAfterBuildFailure({ status }), "serve-stale");
  }
  for (const status of [
    "missing-manifest",
    "invalid-input",
    "invalid-manifest",
    "invalid-output",
    "fresh",
  ]) {
    assert.equal(classifyVendoredDistAfterBuildFailure({ status }), "skip-engine");
  }
  assert.equal(classifyVendoredDistAfterBuildFailure(null), "skip-engine");
});

test("changed output bytes fail with a named output hash mismatch", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const outputPath = path.join(fixture.root, outputAssetRelative);
    const content = fs.readFileSync(outputPath);
    content[0] ^= 1;
    fs.writeFileSync(outputPath, content);

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-output");
    assert.equal(result.reason, "output-hash-mismatch");
    assert.equal(result.path, outputAssetRelative.split(path.sep).join("/"));
  });
});

test("index.html referencing a missing relative asset fails", () => {
  withFixture((fixture) => {
    fs.writeFileSync(
      path.join(fixture.root, distRelative, "index.html"),
      "<script src='./assets/missing.js'></script>\n",
    );
    fs.rmSync(path.join(fixture.root, outputAssetRelative));
    writeManifest(fixture);

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-output");
    assert.equal(result.reason, "missing-referenced-asset");
    assert.match(result.path, /dist\/assets\/missing\.js$/);
  });
});

test("missing manifest fails closed", () => {
  withFixture((fixture) => {
    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.ok, false);
    assert.equal(result.status, "missing-manifest");
    assert.equal(result.path, manifestRelative.split(path.sep).join("/"));
  });
});

test("missing required input root fails closed and names it", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const publicRoot = path.join(fixture.root, webRelative, "public");
    fs.rmSync(publicRoot, { recursive: true });

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-input");
    assert.equal(result.reason, "missing-or-unreadable");
    assert.match(result.path, /packages\/web\/public$/);
  });
});

test("symlink input fails closed and names the symlink", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const sourcePath = path.join(fixture.root, sourceRelative);
    fs.rmSync(sourcePath);
    fs.symlinkSync(path.join(fixture.root, publicRelative), sourcePath);

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-input");
    assert.equal(result.reason, "symlink");
    assert.equal(result.path, sourceRelative.split(path.sep).join("/"));
  });
});

test("builder scrubs credential-shaped environment names before invoking fake bun", () => {
  withFixture((fixture) => {
    const environmentDump = path.join(fixture.root, "bun-environment.json");
    installCommand(
      fixture.fakeBin,
      "bun",
      `import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(process.env.FAKE_BUN_ENV_DUMP, JSON.stringify(process.env));
const dist = path.join(process.env.FAKE_BUN_ROOT, ${JSON.stringify(distRelative)});
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<script src='/assets/app.js'></script>\\n");
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('built');\\n");
`,
    );
    const buildEnvironment = {
      ...fixture.environment,
      FAKE_API_KEY: "must-not-reach-bun",
      FAKE_BUN_ENV_DUMP: environmentDump,
      FAKE_BUN_ROOT: fixture.root,
      NORMAL_SENTINEL: "must-reach-bun",
    };

    const result = spawnSync(
      process.execPath,
      [builderPath, "--force", "--root", fixture.root],
      { encoding: "utf-8", env: buildEnvironment },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const childEnvironment = JSON.parse(fs.readFileSync(environmentDump, "utf-8"));
    assert.equal("FAKE_API_KEY" in childEnvironment, false);
    assert.equal(childEnvironment.NORMAL_SENTINEL, "must-reach-bun");
    assert.match(result.stdout, /vendored-dist-build: PASS/);
  });
});

test("--json emits the stable failure shape", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.appendFileSync(path.join(fixture.root, sourceRelative), "export const changed = true;\n");

    const result = runCheck(fixture, "--json");
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed), [
      "ok",
      "status",
      "root",
      "manifestPath",
      "reason",
      "path",
      "expected",
      "actual",
      "message",
    ]);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "stale-inputs");
    assert.equal(parsed.root, fixture.root);
    assert.equal(parsed.manifestPath, manifestRelative.split(path.sep).join("/"));
    assert.equal(parsed.reason, "input-hash-mismatch");
    assert.equal(parsed.path, sourceRelative.split(path.sep).join("/"));
    assert.match(parsed.expected, /^[0-9a-f]{64}$/);
    assert.match(parsed.actual, /^[0-9a-f]{64}$/);
  });
});
