import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkVendoredDist,
  referencedAssetPaths,
  vendoredInstallStatus,
  writeVendoredInstallStamp,
  writeVendoredDistManifest,
} from "./vendored-dist-check.mjs";
import {
  captureProcessIdentity,
  classifyVendoredDistAfterBuildFailure,
  previewVendoredDistFingerprintEnvironment,
} from "./vendored-dist-environment.mjs";

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
const installStampRelative = path.join(vendoredRelative, ".web-built");

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
  installCommand(
    fakeBin,
    "bun",
    `if (process.argv.slice(2).join(" ") === "--version") {
  process.stdout.write("1.3.8");
  process.exit(0);
}
process.exit(2);
`,
  );
  // Restricted macOS test sandboxes deny the host ps/sysctl calls used for
  // stable process identities. Deterministic shims exercise the production
  // ps-lstart identity path without weakening the builder's fail-closed rule.
  installCommand(
    fakeBin,
    "ps",
    `process.stdout.write("Sun Aug 16 10:00:00 2026\\n");\n`,
  );
  installCommand(
    fakeBin,
    "sysctl",
    `process.stdout.write("{ sec = 12345, usec = 0 }\\n");\n`,
  );

  writeFile(root, sourceRelative, "export const app = 'fixture';\n");
  writeFile(root, publicRelative, "<svg/>\n");
  writeFile(root, path.join(vendoredRelative, "packages", "core", "src", "index.ts"), "export {};\n");
  writeFile(root, path.join(vendoredRelative, "packages", "core", "package.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "packages", "core", "tsconfig.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "packages", "workflows", "src", "index.ts"), "export {};\n");
  writeFile(root, path.join(vendoredRelative, "packages", "workflows", "package.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "packages", "workflows", "tsconfig.json"), "{}\n");
  writeFile(root, path.join(webRelative, "index.html"), "<div id='root'></div>\n");
  writeFile(root, path.join(webRelative, "package.json"), "{}\n");
  writeFile(root, path.join(webRelative, "vite.config.ts"), "export default {};\n");
  writeFile(root, path.join(webRelative, "tsconfig.json"), "{}\n");
  writeFile(root, path.join(vendoredRelative, "bun.lock"), "lockfileVersion = 1\n");
  writeFile(root, path.join(vendoredRelative, "bunfig.toml"), "[test]\nroot = './packages'\n");
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
  fs.mkdirSync(path.join(root, vendoredRelative, "node_modules"), { recursive: true });
  writeVendoredInstallStamp(root, environment);
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
    assert.deepEqual(manifest.runtime, { bun: "1.3.8", node: process.version });
    assert.match(manifest.installStampSha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(fixture.root, installStampRelative)), true);
    assert.deepEqual(manifest.buildEnv, { NODE_ENV: "production", PORT: "3090" });
    assert.deepEqual(manifest.outputs.map(({ path: outputPath }) => outputPath), [
      "assets/app.js",
      "index.html",
    ]);
  });
});

test("a preview-style launcher check leaves the prebuilt manifest byte-exact and untouched", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const manifestPath = path.join(fixture.root, manifestRelative);
    const beforeBytes = fs.readFileSync(manifestPath);
    const beforeMtime = fs.statSync(manifestPath).mtimeMs;
    const result = runCheck(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(fs.readFileSync(manifestPath), beforeBytes);
    assert.equal(fs.statSync(manifestPath).mtimeMs, beforeMtime);
  });
});

test("check-only launcher validates a production manifest without exporting NODE_ENV", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    installCommand(
      fixture.fakeBin,
      "git",
      `if (process.argv.slice(2).join(" ") !== "rev-parse HEAD") process.exit(2);
process.stdout.write(${JSON.stringify(gitHeadA)});
`,
    );
    const launcherEnvironment = { ...fixture.environment };
    delete launcherEnvironment.NODE_ENV;
    delete launcherEnvironment.FAKE_GIT_HEAD;
    const fingerprintEnvironment = previewVendoredDistFingerprintEnvironment(
      launcherEnvironment,
      3090,
    );
    assert.equal("NODE_ENV" in launcherEnvironment, false);
    assert.equal(fingerprintEnvironment.NODE_ENV, "production");
    const result = checkVendoredDist(fixture.root, fingerprintEnvironment);
    assert.equal(result.status, "fresh", result.message);
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

test("changed workspace package manifest fails with a named input mismatch", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    const packageRelative = path.join(
      vendoredRelative,
      "packages",
      "core",
      "package.json",
    );
    fs.writeFileSync(path.join(fixture.root, packageRelative), '{"version":"2"}\n');

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-inputs");
    assert.equal(result.path, packageRelative.split(path.sep).join("/"));
    assert.equal(vendoredInstallStatus(fixture.root, fixture.environment).needsInstall, true);
  });
});

test("changed Bun version fails through the runtime input fingerprint", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    installCommand(
      fixture.fakeBin,
      "bun",
      `if (process.argv.slice(2).join(" ") === "--version") {
  process.stdout.write("1.3.9");
  process.exit(0);
}
process.exit(2);
`,
    );

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-inputs");
    assert.equal(result.path, "@runtime/bun");
  });
});

test("missing dependency install stamp fails freshness", () => {
  withFixture((fixture) => {
    writeManifest(fixture);
    fs.rmSync(path.join(fixture.root, installStampRelative));

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "stale-dependencies");
    assert.equal(result.reason, "install-stamp-mismatch");
    assert.equal(result.path, installStampRelative.split(path.sep).join("/"));
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

test("index.html referencing a missing root-local asset fails", () => {
  withFixture((fixture) => {
    fs.writeFileSync(
      path.join(fixture.root, distRelative, "index.html"),
      "<link rel='icon' href='/favicon.png'><script src='/assets/app.js'></script>\n",
    );
    writeManifest(fixture);

    const result = checkVendoredDist(fixture.root, fixture.environment);
    assert.equal(result.status, "invalid-output");
    assert.equal(result.reason, "missing-referenced-asset");
    assert.match(result.path, /dist\/favicon\.png$/);
  });
});

test("index asset enumeration covers srcset, imagesrcset, poster, object data, and CSS url()", () => {
  const references = referencedAssetPaths(`
    <img src="/plain.png" srcset="/small.png 1x, ./large.png 2x" style="background:url('/inline.png')">
    <link href="/site.css" imagesrcset="/wide.png 640w, /wider.png 1280w">
    <video poster="/poster.jpg"></video>
    <object data="./diagram.svg"></object>
    <style>.hero { background-image: url(./style-block.webp?cache=1); }</style>
  `);
  assert.deepEqual(references, [
    "diagram.svg",
    "inline.png",
    "large.png",
    "plain.png",
    "poster.jpg",
    "site.css",
    "small.png",
    "style-block.webp",
    "wide.png",
    "wider.png",
  ]);
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
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  process.stdout.write("1.3.8");
  process.exit(0);
}
const buildPrefix = "run build -- --outDir ";
if (!args.startsWith(buildPrefix)) process.exit(2);
const lock = JSON.parse(fs.readFileSync(path.join(
  process.env.FAKE_BUN_ROOT,
  "server/vendor/pipeline-engine/node_modules/.vendored-dist-lock/build.lock.d/owner.json",
), "utf-8"));
if (!lock.workers.some((worker) => worker.pid === process.pid && worker.phase === "build")) {
  console.error("build worker was not durably published before mutation");
  process.exit(3);
}
fs.writeFileSync(process.env.FAKE_BUN_ENV_DUMP, JSON.stringify(process.env));
const dist = args.slice(buildPrefix.length);
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

test("builder runs a frozen install when bun.lock invalidates the install stamp", () => {
  withFixture((fixture) => {
    const commandLog = path.join(fixture.root, "bun-commands.jsonl");
    installCommand(
      fixture.fakeBin,
      "bun",
      `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  process.stdout.write("1.3.8");
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_BUN_COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args === "install --frozen-lockfile") {
  const lock = JSON.parse(fs.readFileSync(path.join(
    process.env.FAKE_BUN_ROOT,
    "server/vendor/pipeline-engine/node_modules/.vendored-dist-lock/build.lock.d/owner.json",
  ), "utf-8"));
  if (!lock.workers.some((worker) => worker.pid === process.pid && worker.phase === "install")) process.exit(3);
  process.exit(0);
}
const buildPrefix = "run build -- --outDir ";
if (!args.startsWith(buildPrefix)) process.exit(2);
const dist = args.slice(buildPrefix.length);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<script src='/assets/app.js'></script>\\n");
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('built');\\n");
`,
    );
    fs.appendFileSync(path.join(fixture.root, vendoredRelative, "bun.lock"), "# changed\n");

    const result = spawnSync(
      process.execPath,
      [builderPath, "--force", "--root", fixture.root],
      {
        encoding: "utf-8",
        env: {
          ...fixture.environment,
          FAKE_BUN_COMMAND_LOG: commandLog,
          FAKE_BUN_ROOT: fixture.root,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = fs.readFileSync(commandLog, "utf-8").trim().split("\n").map(JSON.parse);
    assert.equal(commands[0], "install --frozen-lockfile");
    assert.match(commands[1], /^run build -- --outDir /);
    assert.match(result.stdout, /dependency stamp written/);
    assert.equal(checkVendoredDist(fixture.root, fixture.environment).status, "fresh");
  });
});

test("builder cannot skip when node_modules was deleted but the outer stamp remains", () => {
  withFixture((fixture) => {
    const commandLog = path.join(fixture.root, "missing-node-modules-commands.jsonl");
    installCommand(
      fixture.fakeBin,
      "bun",
      `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args === "--version") { process.stdout.write("1.3.8"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");
if (args === "install --frozen-lockfile") process.exit(0);
const buildPrefix = "run build -- --outDir ";
if (!args.startsWith(buildPrefix)) process.exit(2);
const dist = args.slice(buildPrefix.length);
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<script src='/assets/app.js'></script>\\n");
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('built');\\n");
`,
    );
    writeManifest(fixture);
    fs.rmSync(path.join(fixture.root, vendoredRelative, "node_modules"), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [builderPath, "--if-stale", "--root", fixture.root], {
      encoding: "utf-8",
      env: fixture.environment,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = fs.readFileSync(commandLog, "utf-8").trim().split("\n").map(JSON.parse);
    assert.equal(commands[0], "install --frozen-lockfile");
    assert.equal(
      fs.existsSync(path.join(fixture.root, vendoredRelative, "node_modules", ".bun-install-stamp")),
      true,
    );
  });
});

test("builder refuses to certify outputs when inputs change during the build", () => {
  withFixture((fixture) => {
    installCommand(
      fixture.fakeBin,
      "bun",
      `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  process.stdout.write("1.3.8");
  process.exit(0);
}
const buildPrefix = "run build -- --outDir ";
if (!args.startsWith(buildPrefix)) process.exit(2);
fs.appendFileSync(path.join(process.env.FAKE_BUN_ROOT, ${JSON.stringify(sourceRelative)}), "export const raced = true;\\n");
const dist = args.slice(buildPrefix.length);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<script src='/assets/app.js'></script>\\n");
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('built');\\n");
`,
    );
    fs.rmSync(path.join(fixture.root, manifestRelative), { force: true });

    const result = spawnSync(
      process.execPath,
      [builderPath, "--force", "--root", fixture.root],
      {
        encoding: "utf-8",
        env: { ...fixture.environment, FAKE_BUN_ROOT: fixture.root },
      },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /build inputs changed while Bun was running; manifest not written/);
    assert.equal(fs.existsSync(path.join(fixture.root, manifestRelative)), false);
  });
});

test("concurrent builders serialize; the contender waits and then observes fresh dist", async () => {
  const fixture = createFixture();
  try {
    const commandLog = path.join(fixture.root, "concurrent-builds.log");
    installCommand(
      fixture.fakeBin,
      "bun",
      `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  process.stdout.write("1.3.8");
  process.exit(0);
}
const buildPrefix = "run build -- --outDir ";
if (!args.startsWith(buildPrefix)) process.exit(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, "build\\n");
await new Promise((resolve) => setTimeout(resolve, 600));
const dist = args.slice(buildPrefix.length);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<script src='/assets/app.js'></script>\\n");
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('built');\\n");
`,
    );
    writeManifest(fixture);
    fs.appendFileSync(path.join(fixture.root, sourceRelative), "export const concurrent = true;\n");
    const runBuilder = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [builderPath, "--if-stale", "--root", fixture.root], {
        env: fixture.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    const [first, second] = await Promise.all([runBuilder(), runBuilder()]);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(fs.readFileSync(commandLog, "utf-8"), "build\n");
    assert.match(`${first.stdout}${second.stdout}`, /SKIP \(dist manifest and outputs are already valid\)/);
    assert.equal(checkVendoredDist(fixture.root, fixture.environment).status, "fresh");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("--recover-lock removes only an identity-verified dead owner", () => {
  withFixture((fixture) => {
    const localIdentity = captureProcessIdentity(process.pid, {
      spawnProcess: (command, arguments_, options) => spawnSync(command, arguments_, {
        ...options,
        env: fixture.environment,
      }),
    });
    assert.ok(localIdentity);
    const lockPath = path.join(
      fixture.root,
      vendoredRelative,
      "node_modules",
      ".vendored-dist-lock",
      "build.lock.d",
    );
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: 999999,
      identity: localIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })}\n`);
    const result = spawnSync(
      process.execPath,
      [builderPath, "--recover-lock", "--root", fixture.root],
      { encoding: "utf-8", env: fixture.environment },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /recovered lock owned by pid 999999/);
    assert.match(result.stdout, /vendored-dist-build: PASS/);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("--recover-lock refuses a live owner and an unreadable record without --force", () => {
  withFixture((fixture) => {
    const localIdentity = captureProcessIdentity(process.pid, {
      spawnProcess: (command, arguments_, options) => spawnSync(command, arguments_, {
        ...options,
        env: fixture.environment,
      }),
    });
    assert.ok(localIdentity);
    const lockPath = path.join(
      fixture.root,
      vendoredRelative,
      "node_modules",
      ".vendored-dist-lock",
      "build.lock.d",
    );
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      identity: localIdentity,
      phase: "holding",
      workers: [],
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })}\n`);
    const live = spawnSync(
      process.execPath,
      [builderPath, "--recover-lock", "--root", fixture.root],
      { encoding: "utf-8", env: fixture.environment },
    );
    assert.equal(live.status, 1, `${live.stdout}\n${live.stderr}`);
    assert.match(live.stderr, /refusing lock recovery \(same\)/);
    assert.equal(fs.existsSync(lockPath), true);

    fs.writeFileSync(path.join(lockPath, "owner.json"), "{partial");
    const unreadable = spawnSync(
      process.execPath,
      [builderPath, "--recover-lock", "--root", fixture.root],
      { encoding: "utf-8", env: fixture.environment },
    );
    assert.equal(unreadable.status, 1, `${unreadable.stdout}\n${unreadable.stderr}`);
    assert.match(unreadable.stderr, /owner record is unreadable/);
    const forced = spawnSync(
      process.execPath,
      [builderPath, "--recover-lock", "--force", "--root", fixture.root],
      { encoding: "utf-8", env: fixture.environment },
    );
    assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
    assert.match(forced.stdout, /recovered unreadable lock/);
    assert.equal(fs.existsSync(lockPath), false);
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
