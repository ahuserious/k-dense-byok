#!/usr/bin/env node

/**
 * Freshness inputs for the vendored Pipeline Engine web bundle:
 *
 * - all files under packages/web/src;
 * - packages/web/index.html, package.json, vite.config.*, and tsconfig*.json;
 * - all files under packages/core and packages/workflows, excluding generated
 *   and dependency directories. The web tsconfig exposes both packages as
 *   source aliases and directly includes a workflows declaration file, so the
 *   conservative fail-closed boundary covers both complete workspace trees;
 * - the vendored workspace's package.json, bun.lock, and tsconfig*.json because
 *   Bun resolves the workspace from them, the web tsconfig extends the root
 *   config, and vite.config.ts reads the root package version.
 *
 * Other vendored workspace packages are not inputs: the web package metadata,
 * Vite config, and TypeScript config do not reference them. node_modules,
 * dist, coverage, and .git directories are generated/external and excluded.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const vendoredRootRelative = path.join("server", "vendor", "pipeline-engine");
const distIndexRelative = path.join(
  vendoredRootRelative,
  "packages",
  "web",
  "dist",
  "index.html",
);
const excludedDirectoryNames = new Set([".git", "coverage", "dist", "node_modules"]);

function apiPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePath(repositoryRoot, filePath) {
  return apiPath(path.relative(repositoryRoot, filePath));
}

function collectRecursiveFiles(directoryPath, files) {
  if (!fs.existsSync(directoryPath)) return;
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) collectRecursiveFiles(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

function collectMatchingFiles(directoryPath, predicate, files) {
  if (!fs.existsSync(directoryPath)) return;
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) files.push(path.join(directoryPath, entry.name));
  }
}

export function collectVendoredDistInputs(repositoryRoot) {
  const vendoredRoot = path.join(repositoryRoot, vendoredRootRelative);
  const packagesRoot = path.join(vendoredRoot, "packages");
  const webRoot = path.join(packagesRoot, "web");
  const files = [];

  collectRecursiveFiles(path.join(webRoot, "src"), files);
  collectRecursiveFiles(path.join(packagesRoot, "core"), files);
  collectRecursiveFiles(path.join(packagesRoot, "workflows"), files);

  for (const name of ["index.html", "package.json"]) {
    const filePath = path.join(webRoot, name);
    if (fs.existsSync(filePath)) files.push(filePath);
  }
  collectMatchingFiles(webRoot, (name) => name.startsWith("vite.config."), files);
  collectMatchingFiles(
    webRoot,
    (name) => name.startsWith("tsconfig") && name.endsWith(".json"),
    files,
  );

  for (const name of ["bun.lock", "package.json"]) {
    const filePath = path.join(vendoredRoot, name);
    if (fs.existsSync(filePath)) files.push(filePath);
  }
  collectMatchingFiles(
    vendoredRoot,
    (name) => name.startsWith("tsconfig") && name.endsWith(".json"),
    files,
  );

  return [...new Set(files)].sort();
}

function formatMtime(mtimeMs) {
  return `${new Date(mtimeMs).toISOString()} (${mtimeMs} ms)`;
}

export function checkVendoredDist(repositoryRoot = defaultRepositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Repository root is not a directory: ${resolvedRoot}`);
  }

  const distIndexPath = path.join(resolvedRoot, distIndexRelative);
  const distIndex = apiPath(distIndexRelative);
  if (!fs.existsSync(distIndexPath)) {
    return {
      ok: false,
      status: "missing",
      root: resolvedRoot,
      distIndex,
      distMtimeMs: null,
      offendingInput: null,
      offendingInputMtimeMs: null,
      message: `vendored dist is missing: ${distIndex}`,
    };
  }

  const distMtimeMs = fs.statSync(distIndexPath).mtimeMs;
  let newestOffendingInput = null;
  for (const inputPath of collectVendoredDistInputs(resolvedRoot)) {
    const inputMtimeMs = fs.statSync(inputPath).mtimeMs;
    if (inputMtimeMs <= distMtimeMs) continue;
    if (
      !newestOffendingInput ||
      inputMtimeMs > newestOffendingInput.mtimeMs ||
      (inputMtimeMs === newestOffendingInput.mtimeMs && inputPath > newestOffendingInput.path)
    ) {
      newestOffendingInput = { path: inputPath, mtimeMs: inputMtimeMs };
    }
  }

  if (newestOffendingInput) {
    const offendingInput = relativePath(resolvedRoot, newestOffendingInput.path);
    return {
      ok: false,
      status: "stale",
      root: resolvedRoot,
      distIndex,
      distMtimeMs,
      offendingInput,
      offendingInputMtimeMs: newestOffendingInput.mtimeMs,
      message: `vendored dist is stale: ${offendingInput} is newer than ${distIndex}`,
    };
  }

  return {
    ok: true,
    status: "fresh",
    root: resolvedRoot,
    distIndex,
    distMtimeMs,
    offendingInput: null,
    offendingInputMtimeMs: null,
    message: `vendored dist is fresh: ${distIndex}`,
  };
}

export function printVendoredDistStatus(result, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.ok) {
    console.log(`vendored-dist-check: PASS (${result.distIndex}, mtime ${formatMtime(result.distMtimeMs)})`);
    return;
  }
  if (result.status === "missing") {
    console.error(`vendored-dist-check: FAIL (${result.message})`);
    return;
  }
  console.error("vendored-dist-check: FAIL (vendored dist is stale)");
  console.error(
    `  newest input: ${result.offendingInput} (mtime ${formatMtime(result.offendingInputMtimeMs)})`,
  );
  console.error(`  dist index:   ${result.distIndex} (mtime ${formatMtime(result.distMtimeMs)})`);
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

export function runVendoredDistCheck(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    const result = checkVendoredDist(options.root);
    printVendoredDistStatus(result, options);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`vendored-dist-check: ERROR (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runVendoredDistCheck());
}

