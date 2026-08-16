#!/usr/bin/env node

/**
 * Content inputs for the vendored Pipeline Engine web bundle:
 *
 * - every regular file under packages/web/src and packages/web/public;
 * - packages/web/index.html, package.json, vite.config.*, tsconfig*.json, and
 *   packages/web/.env* files when present;
 * - every regular file under packages/core and packages/workflows. The web
 *   tsconfig exposes both as source aliases and directly includes a workflows
 *   declaration file, so the fail-closed boundary covers both complete trees;
 * - the vendored workspace package.json, bun.lock, tsconfig*.json, and .env*
 *   files when present. Vite reads the root package version and loads env files
 *   from this workspace root;
 * - outer-repository Git HEAD and the non-credential build environment values
 *   read by Vite: NODE_ENV and PORT.
 *
 * Other workspace packages are not inputs because the web package metadata,
 * Vite config, and TypeScript config do not reference them. Generated dist,
 * node_modules, coverage, and Git metadata are excluded as file inputs; Git
 * identity is captured separately. Missing/unreadable required roots and any
 * symlink inside the input or output trees fail closed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const vendoredRootRelative = path.join("server", "vendor", "pipeline-engine");
const webRootRelative = path.join(vendoredRootRelative, "packages", "web");
const distRootRelative = path.join(webRootRelative, "dist");
const distIndexRelative = path.join(distRootRelative, "index.html");
const manifestFileName = ".vendored-dist-manifest.json";
const manifestRelative = path.join(distRootRelative, manifestFileName);
const buildEnvironmentNames = ["NODE_ENV", "PORT"];
const excludedDirectoryNames = new Set([".git", "coverage", "dist", "node_modules"]);

class ValidationError extends Error {
  constructor(status, reason, filePath, message) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.filePath = filePath;
  }
}

function apiPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function repositoryRelative(repositoryRoot, filePath) {
  return apiPath(path.relative(repositoryRoot, filePath));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function comparePathEntries(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function requiredStat(repositoryRoot, filePath, expectedType, status = "invalid-input") {
  const relative = repositoryRelative(repositoryRoot, filePath);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new ValidationError(
      status,
      "missing-or-unreadable",
      relative,
      `required ${expectedType} is missing or unreadable: ${relative} (${error.code ?? error.message})`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new ValidationError(status, "symlink", relative, `symlink is not allowed: ${relative}`);
  }
  const valid = expectedType === "directory" ? stat.isDirectory() : stat.isFile();
  if (!valid) {
    throw new ValidationError(
      status,
      "wrong-type",
      relative,
      `required ${expectedType} has the wrong type: ${relative}`,
    );
  }
  return stat;
}

function hashRegularFile(repositoryRoot, filePath, status = "invalid-input") {
  const stat = requiredStat(repositoryRoot, filePath, "file", status);
  const relative = repositoryRelative(repositoryRoot, filePath);
  try {
    return { path: relative, sha256: sha256(fs.readFileSync(filePath)), bytes: stat.size };
  } catch (error) {
    throw new ValidationError(
      status,
      "unreadable",
      relative,
      `file is unreadable: ${relative} (${error.code ?? error.message})`,
    );
  }
}

function collectTree(repositoryRoot, directoryPath, files, status = "invalid-input") {
  requiredStat(repositoryRoot, directoryPath, "directory", status);
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    const relative = repositoryRelative(repositoryRoot, directoryPath);
    throw new ValidationError(
      status,
      "unreadable",
      relative,
      `directory is unreadable: ${relative} (${error.code ?? error.message})`,
    );
  }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const relative = repositoryRelative(repositoryRoot, entryPath);
    if (entry.isSymbolicLink()) {
      throw new ValidationError(status, "symlink", relative, `symlink is not allowed: ${relative}`);
    }
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        collectTree(repositoryRoot, entryPath, files, status);
      }
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else {
      throw new ValidationError(status, "wrong-type", relative, `non-regular input is not allowed: ${relative}`);
    }
  }
}

function collectMatchingFiles(repositoryRoot, directoryPath, predicate, { required, label }) {
  requiredStat(repositoryRoot, directoryPath, "directory");
  const matches = [];
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    const relative = repositoryRelative(repositoryRoot, directoryPath);
    throw new ValidationError(
      "invalid-input",
      "unreadable",
      relative,
      `directory is unreadable: ${relative} (${error.code ?? error.message})`,
    );
  }
  for (const entry of entries) {
    if (!predicate(entry.name)) continue;
    const entryPath = path.join(directoryPath, entry.name);
    const relative = repositoryRelative(repositoryRoot, entryPath);
    if (entry.isSymbolicLink()) {
      throw new ValidationError("invalid-input", "symlink", relative, `symlink is not allowed: ${relative}`);
    }
    if (!entry.isFile()) {
      throw new ValidationError("invalid-input", "wrong-type", relative, `matched input is not a regular file: ${relative}`);
    }
    matches.push(entryPath);
  }
  if (required && matches.length === 0) {
    const relative = repositoryRelative(repositoryRoot, directoryPath);
    throw new ValidationError(
      "invalid-input",
      "missing-or-unreadable",
      relative,
      `required ${label} input is missing under ${relative}`,
    );
  }
  return matches;
}

export function collectVendoredDistInputEntries(repositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const vendoredRoot = path.join(resolvedRoot, vendoredRootRelative);
  const packagesRoot = path.join(vendoredRoot, "packages");
  const webRoot = path.join(packagesRoot, "web");
  const filePaths = [];

  for (const directoryPath of [
    path.join(webRoot, "src"),
    path.join(webRoot, "public"),
    path.join(packagesRoot, "core"),
    path.join(packagesRoot, "workflows"),
  ]) {
    collectTree(resolvedRoot, directoryPath, filePaths);
  }

  for (const filePath of [
    path.join(webRoot, "index.html"),
    path.join(webRoot, "package.json"),
    path.join(vendoredRoot, "bun.lock"),
    path.join(vendoredRoot, "package.json"),
  ]) {
    requiredStat(resolvedRoot, filePath, "file");
    filePaths.push(filePath);
  }

  filePaths.push(
    ...collectMatchingFiles(resolvedRoot, webRoot, (name) => name.startsWith("vite.config."), {
      required: true,
      label: "vite.config.*",
    }),
    ...collectMatchingFiles(
      resolvedRoot,
      webRoot,
      (name) => name.startsWith("tsconfig") && name.endsWith(".json"),
      { required: true, label: "tsconfig*.json" },
    ),
    ...collectMatchingFiles(resolvedRoot, webRoot, (name) => name.startsWith(".env"), {
      required: false,
      label: ".env*",
    }),
    ...collectMatchingFiles(
      resolvedRoot,
      vendoredRoot,
      (name) => name.startsWith("tsconfig") && name.endsWith(".json"),
      { required: true, label: "tsconfig*.json" },
    ),
    ...collectMatchingFiles(resolvedRoot, vendoredRoot, (name) => name.startsWith(".env"), {
      required: false,
      label: ".env*",
    }),
  );

  return [...new Set(filePaths)]
    .map((filePath) => hashRegularFile(resolvedRoot, filePath))
    .sort(comparePathEntries)
    .map(({ path: inputPath, sha256: fileSha256 }) => ({ path: inputPath, sha256: fileSha256 }));
}

export function inputEntriesSha256(entries) {
  return sha256(JSON.stringify(entries.map(({ path: inputPath, sha256: fileSha256 }) => ({
    path: inputPath,
    sha256: fileSha256,
  }))));
}

export function resolveGitHead(repositoryRoot, environment = process.env) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  const candidate = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/i.test(candidate) ? candidate : "unknown";
}

export function vendoredDistBuildEnvironment(environment = process.env) {
  return Object.fromEntries(
    buildEnvironmentNames.map((name) => [name, environment[name] === undefined ? null : String(environment[name])]),
  );
}

function collectOutputEntries(repositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const distRoot = path.join(resolvedRoot, distRootRelative);
  const filePaths = [];
  collectTree(resolvedRoot, distRoot, filePaths, "invalid-output");
  return filePaths
    .filter((filePath) => filePath !== path.join(distRoot, manifestFileName))
    .map((filePath) => {
      const hashed = hashRegularFile(resolvedRoot, filePath, "invalid-output");
      return {
        path: apiPath(path.relative(distRoot, filePath)),
        sha256: hashed.sha256,
        bytes: hashed.bytes,
      };
    })
    .sort(comparePathEntries);
}

export function captureVendoredDistBuildContext(
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const inputs = collectVendoredDistInputEntries(resolvedRoot);
  return {
    schema: 1,
    inputsSha256: inputEntriesSha256(inputs),
    inputs,
    gitHead: resolveGitHead(resolvedRoot, environment),
    buildEnv: vendoredDistBuildEnvironment(environment),
  };
}

export function createVendoredDistManifest(
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  buildContext = captureVendoredDistBuildContext(repositoryRoot, environment),
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  return {
    ...buildContext,
    outputs: collectOutputEntries(resolvedRoot),
  };
}

export function writeVendoredDistManifest(
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  buildContext = captureVendoredDistBuildContext(repositoryRoot, environment),
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const manifestPath = path.join(resolvedRoot, manifestRelative);
  const manifest = createVendoredDistManifest(resolvedRoot, environment, buildContext);
  // A partial manifest is safe because the checker treats malformed JSON as a
  // hard failure; avoiding replacement-by-rename keeps this path portable on
  // Windows where replacing an existing file is not consistently atomic.
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function failure(repositoryRoot, status, reason, filePath, message, expected = null, actual = null) {
  return {
    ok: false,
    status,
    root: repositoryRoot,
    manifestPath: apiPath(manifestRelative),
    reason,
    path: filePath,
    expected,
    actual,
    message,
  };
}

function validationFailure(repositoryRoot, error) {
  return failure(
    repositoryRoot,
    error.status,
    error.reason,
    error.filePath,
    error.message,
  );
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateManifestShape(repositoryRoot, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ValidationError("invalid-manifest", "schema", apiPath(manifestRelative), "manifest must be a JSON object");
  }
  if (manifest.schema !== 1) {
    throw new ValidationError("invalid-manifest", "schema", apiPath(manifestRelative), `unsupported manifest schema: ${manifest.schema}`);
  }
  if (!validSha256(manifest.inputsSha256) || !Array.isArray(manifest.inputs)) {
    throw new ValidationError("invalid-manifest", "inputs", apiPath(manifestRelative), "manifest inputs are missing or invalid");
  }
  const inputPaths = new Set();
  for (const input of manifest.inputs) {
    if (!input || typeof input.path !== "string" || !validSha256(input.sha256) || inputPaths.has(input.path)) {
      throw new ValidationError("invalid-manifest", "inputs", apiPath(manifestRelative), "manifest contains an invalid or duplicate input entry");
    }
    inputPaths.add(input.path);
  }
  if (manifest.inputsSha256 !== inputEntriesSha256(manifest.inputs)) {
    throw new ValidationError("invalid-manifest", "inputs", apiPath(manifestRelative), "manifest inputsSha256 does not match its input entries");
  }
  if (typeof manifest.gitHead !== "string" || (manifest.gitHead !== "unknown" && !/^[0-9a-f]{40,64}$/i.test(manifest.gitHead))) {
    throw new ValidationError("invalid-manifest", "git-head", apiPath(manifestRelative), "manifest gitHead is invalid");
  }
  const expectedEnvironmentKeys = JSON.stringify(buildEnvironmentNames);
  if (!manifest.buildEnv || typeof manifest.buildEnv !== "object" || Array.isArray(manifest.buildEnv) || JSON.stringify(Object.keys(manifest.buildEnv)) !== expectedEnvironmentKeys) {
    throw new ValidationError("invalid-manifest", "build-env", apiPath(manifestRelative), "manifest buildEnv names are invalid");
  }
  for (const value of Object.values(manifest.buildEnv)) {
    if (value !== null && typeof value !== "string") {
      throw new ValidationError("invalid-manifest", "build-env", apiPath(manifestRelative), "manifest buildEnv values are invalid");
    }
  }
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0) {
    throw new ValidationError("invalid-manifest", "outputs", apiPath(manifestRelative), "manifest outputs are missing or empty");
  }
  const outputPaths = new Set();
  for (const output of manifest.outputs) {
    if (
      !output ||
      typeof output.path !== "string" ||
      output.path === manifestFileName ||
      path.isAbsolute(output.path) ||
      output.path.split("/").includes("..") ||
      !validSha256(output.sha256) ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 0 ||
      outputPaths.has(output.path)
    ) {
      throw new ValidationError("invalid-manifest", "outputs", apiPath(manifestRelative), "manifest contains an invalid or duplicate output entry");
    }
    outputPaths.add(output.path);
  }
  if (!outputPaths.has("index.html")) {
    throw new ValidationError("invalid-manifest", "outputs", apiPath(manifestRelative), "manifest does not record index.html");
  }
}

function firstInputMismatch(manifestInputs, currentInputs) {
  const recorded = new Map(manifestInputs.map((entry) => [entry.path, entry.sha256]));
  const current = new Map(currentInputs.map((entry) => [entry.path, entry.sha256]));
  for (const entry of currentInputs) {
    if (!recorded.has(entry.path)) return { reason: "input-added", path: entry.path, expected: null, actual: entry.sha256 };
    if (recorded.get(entry.path) !== entry.sha256) {
      return { reason: "input-hash-mismatch", path: entry.path, expected: recorded.get(entry.path), actual: entry.sha256 };
    }
  }
  for (const entry of manifestInputs) {
    if (!current.has(entry.path)) return { reason: "input-missing", path: entry.path, expected: entry.sha256, actual: null };
  }
  return null;
}

function referencedAssetPaths(indexHtml) {
  const references = new Set();
  const attributePattern = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
  for (const match of indexHtml.matchAll(attributePattern)) {
    const rawReference = match[1] ?? match[2] ?? match[3];
    if (
      rawReference.startsWith("#") ||
      rawReference.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawReference)
    ) {
      continue;
    }
    const withoutQuery = rawReference.split(/[?#]/, 1)[0];
    if (!withoutQuery) continue;
    if (withoutQuery.startsWith("/") && !withoutQuery.startsWith("/assets/")) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutQuery);
    } catch {
      decoded = withoutQuery;
    }
    references.add(decoded.startsWith("/") ? decoded.slice(1) : decoded.replace(/^\.\//, ""));
  }
  return [...references].sort();
}

function validateReferencedAssets(repositoryRoot) {
  const distRoot = path.join(repositoryRoot, distRootRelative);
  const indexPath = path.join(repositoryRoot, distIndexRelative);
  const indexRelative = apiPath(distIndexRelative);
  const indexHtml = fs.readFileSync(indexPath, "utf-8");
  for (const reference of referencedAssetPaths(indexHtml)) {
    const candidatePath = path.resolve(distRoot, reference);
    if (candidatePath !== distRoot && !candidatePath.startsWith(`${distRoot}${path.sep}`)) {
      throw new ValidationError("invalid-output", "asset-reference", indexRelative, `index.html asset reference escapes dist: ${reference}`);
    }
    const outputRelative = apiPath(path.join(distRootRelative, reference));
    try {
      requiredStat(repositoryRoot, candidatePath, "file", "invalid-output");
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError("invalid-output", "missing-referenced-asset", outputRelative, `index.html references a missing or invalid asset: ${outputRelative}`);
      }
      throw error;
    }
  }
}

export function checkVendoredDist(
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    return failure(resolvedRoot, "invalid-root", "missing-or-unreadable", "", `repository root is not a directory: ${resolvedRoot}`);
  }

  let currentInputs;
  try {
    currentInputs = collectVendoredDistInputEntries(resolvedRoot);
  } catch (error) {
    if (error instanceof ValidationError) return validationFailure(resolvedRoot, error);
    throw error;
  }

  const manifestPath = path.join(resolvedRoot, manifestRelative);
  if (!fs.existsSync(manifestPath)) {
    return failure(
      resolvedRoot,
      "missing-manifest",
      "missing-manifest",
      apiPath(manifestRelative),
      `vendored dist manifest is missing: ${apiPath(manifestRelative)}`,
    );
  }

  let manifest;
  try {
    requiredStat(resolvedRoot, manifestPath, "file", "invalid-manifest");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    validateManifestShape(resolvedRoot, manifest);
  } catch (error) {
    if (error instanceof ValidationError) return validationFailure(resolvedRoot, error);
    return failure(
      resolvedRoot,
      "invalid-manifest",
      "unreadable",
      apiPath(manifestRelative),
      `vendored dist manifest is unreadable or invalid: ${error.message}`,
    );
  }

  const currentInputsSha256 = inputEntriesSha256(currentInputs);
  let freshnessFailure = null;
  if (manifest.inputsSha256 !== currentInputsSha256) {
    const mismatch = firstInputMismatch(manifest.inputs, currentInputs);
    const mismatchPath = mismatch?.path ?? apiPath(webRootRelative);
    freshnessFailure = failure(
      resolvedRoot,
      "stale-inputs",
      mismatch?.reason ?? "inputs-sha256-mismatch",
      mismatchPath,
      `${mismatch?.reason?.replaceAll("-", " ") ?? "input fingerprint mismatch"}: ${mismatchPath}`,
      mismatch?.expected ?? manifest.inputsSha256,
      mismatch?.actual ?? currentInputsSha256,
    );
  }

  const currentGitHead = resolveGitHead(resolvedRoot, environment);
  if (!freshnessFailure && manifest.gitHead !== currentGitHead) {
    freshnessFailure = failure(
      resolvedRoot,
      "stale-git-head",
      "git-head-mismatch",
      ".git/HEAD",
      `Git HEAD mismatch: manifest=${manifest.gitHead}, current=${currentGitHead}`,
      manifest.gitHead,
      currentGitHead,
    );
  }

  const currentBuildEnvironment = vendoredDistBuildEnvironment(environment);
  if (
    !freshnessFailure &&
    JSON.stringify(manifest.buildEnv) !== JSON.stringify(currentBuildEnvironment)
  ) {
    const changedName = buildEnvironmentNames.find(
      (name) => manifest.buildEnv[name] !== currentBuildEnvironment[name],
    );
    freshnessFailure = failure(
      resolvedRoot,
      "stale-build-env",
      "build-env-mismatch",
      changedName,
      `build environment mismatch for ${changedName}`,
      manifest.buildEnv[changedName],
      currentBuildEnvironment[changedName],
    );
  }

  let currentOutputs;
  try {
    currentOutputs = collectOutputEntries(resolvedRoot);
  } catch (error) {
    if (error instanceof ValidationError) return validationFailure(resolvedRoot, error);
    throw error;
  }
  const recordedOutputs = new Map(manifest.outputs.map((entry) => [entry.path, entry]));
  const actualOutputs = new Map(currentOutputs.map((entry) => [entry.path, entry]));
  for (const recorded of manifest.outputs) {
    const actual = actualOutputs.get(recorded.path);
    const outputPath = apiPath(path.join(distRootRelative, recorded.path));
    if (!actual) {
      return failure(resolvedRoot, "invalid-output", "missing-output", outputPath, `manifest output is missing: ${outputPath}`);
    }
    if (recorded.bytes !== actual.bytes) {
      return failure(resolvedRoot, "invalid-output", "output-size-mismatch", outputPath, `output byte count mismatch: ${outputPath}`, recorded.bytes, actual.bytes);
    }
    if (recorded.sha256 !== actual.sha256) {
      return failure(resolvedRoot, "invalid-output", "output-hash-mismatch", outputPath, `output hash mismatch: ${outputPath}`, recorded.sha256, actual.sha256);
    }
  }
  for (const actual of currentOutputs) {
    if (!recordedOutputs.has(actual.path)) {
      const outputPath = apiPath(path.join(distRootRelative, actual.path));
      return failure(resolvedRoot, "invalid-output", "unrecorded-output", outputPath, `unrecorded output exists: ${outputPath}`);
    }
  }

  try {
    validateReferencedAssets(resolvedRoot);
  } catch (error) {
    if (error instanceof ValidationError) return validationFailure(resolvedRoot, error);
    return failure(resolvedRoot, "invalid-output", "unreadable", apiPath(distIndexRelative), `could not validate index.html references: ${error.message}`);
  }

  // Output integrity takes precedence over freshness so launchers can safely
  // distinguish a usable old bundle from a missing or damaged one.
  if (freshnessFailure) return freshnessFailure;

  return {
    ok: true,
    status: "fresh",
    root: resolvedRoot,
    manifestPath: apiPath(manifestRelative),
    reason: null,
    path: null,
    expected: null,
    actual: null,
    message: `vendored dist matches ${apiPath(manifestRelative)}`,
  };
}

export function printVendoredDistStatus(result, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.ok) {
    console.log(`vendored-dist-check: PASS (${result.message})`);
    return;
  }
  console.error(`vendored-dist-check: FAIL (${result.status}: ${result.message})`);
  if (result.expected !== null || result.actual !== null) {
    console.error(`  expected: ${JSON.stringify(result.expected)}`);
    console.error(`  actual:   ${JSON.stringify(result.actual)}`);
  }
}

function parseArguments(argv) {
  let root = defaultRepositoryRoot;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a path.");
      root = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { root, json };
}

export function runVendoredDistCheck(argv = process.argv.slice(2), environment = process.env) {
  try {
    const options = parseArguments(argv);
    const result = checkVendoredDist(options.root, environment);
    printVendoredDistStatus(result, options);
    return result.ok ? 0 : 1;
  } catch (error) {
    const result = failure(
      path.resolve(defaultRepositoryRoot),
      "error",
      "unexpected-error",
      null,
      error instanceof Error ? error.message : String(error),
    );
    if (argv.includes("--json")) console.log(JSON.stringify(result));
    else console.error(`vendored-dist-check: ERROR (${result.message})`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runVendoredDistCheck());
}
