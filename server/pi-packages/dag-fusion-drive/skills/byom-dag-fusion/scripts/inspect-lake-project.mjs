#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifestFile = process.argv[2];
const mathlibDirectory = process.argv[3];
if (!manifestFile || !mathlibDirectory) {
  process.stderr.write(
    "usage: inspect-lake-project.mjs <lake-manifest.json> <mathlib-directory>\n",
  );
  process.exit(64);
}

function fail(message) {
  process.stderr.write(`byom-dag-fusion: ${message}\n`);
  process.exit(1);
}

function requireRegularNonSymlink(file, description) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${description} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${description} must be a regular non-symlink file`);
  }
}

function requireDirectoryNonSymlink(directory, description) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${description} is missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${description} must be a regular non-symlink directory`);
  }
}

requireRegularNonSymlink(manifestFile, "lake-manifest.json");
requireDirectoryNonSymlink(mathlibDirectory, "installed Mathlib dependency");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
} catch (error) {
  fail(
    `lake-manifest.json is not valid JSON: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  fail("lake-manifest.json must contain an object");
}
if (manifest.lakeDir !== undefined && manifest.lakeDir !== ".lake") {
  fail("lake-manifest.json must use the project-local .lake directory");
}
if (!Array.isArray(manifest.packages)) {
  fail("lake-manifest.json has no packages array");
}

const mathlibPackages = manifest.packages.filter(
  (candidate) =>
    candidate && typeof candidate === "object" && candidate.name === "mathlib",
);
if (mathlibPackages.length !== 1) {
  fail("lake-manifest.json must contain exactly one Mathlib package");
}
const mathlibPackage = mathlibPackages[0];
if (mathlibPackage.type !== "git") {
  fail("Mathlib must be pinned as a git dependency");
}
const normalizedUrl =
  typeof mathlibPackage.url === "string"
    ? mathlibPackage.url.replace(/\/+$/, "").replace(/\.git$/, "")
    : "";
if (normalizedUrl !== "https://github.com/leanprover-community/mathlib4") {
  fail("Mathlib must use the official leanprover-community/mathlib4 repository");
}
if (
  typeof mathlibPackage.rev !== "string" ||
  !/^[0-9a-f]{40}$/i.test(mathlibPackage.rev)
) {
  fail("Mathlib rev must be a full 40-character git SHA");
}
const manifestRevision = mathlibPackage.rev.toLowerCase();

const mathlibSource = path.join(mathlibDirectory, "Mathlib.lean");
requireRegularNonSymlink(mathlibSource, "installed Mathlib.lean");
const mathlibRealPath = fs.realpathSync(mathlibDirectory);
const mathlibSourceRealPath = fs.realpathSync(mathlibSource);
if (!mathlibSourceRealPath.startsWith(`${mathlibRealPath}${path.sep}`)) {
  fail("installed Mathlib.lean escapes the Mathlib dependency directory");
}

const gitDirectory = path.join(mathlibDirectory, ".git");
requireDirectoryNonSymlink(gitDirectory, "installed Mathlib .git directory");
const headFile = path.join(gitDirectory, "HEAD");
requireRegularNonSymlink(headFile, "installed Mathlib git HEAD");
const head = fs.readFileSync(headFile, "utf8").trim();
let installedRevision;

if (/^[0-9a-f]{40}$/i.test(head)) {
  installedRevision = head.toLowerCase();
} else if (head.startsWith("ref: ")) {
  const refName = head.slice("ref: ".length);
  if (
    !refName.startsWith("refs/") ||
    refName.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(refName)
  ) {
    fail("installed Mathlib git HEAD contains an unsafe ref");
  }
  const looseRef = path.join(gitDirectory, ...refName.split("/"));
  if (fs.existsSync(looseRef)) {
    requireRegularNonSymlink(looseRef, "installed Mathlib git ref");
    installedRevision = fs.readFileSync(looseRef, "utf8").trim().toLowerCase();
  } else {
    const packedRefs = path.join(gitDirectory, "packed-refs");
    requireRegularNonSymlink(packedRefs, "installed Mathlib packed refs");
    const match = fs
      .readFileSync(packedRefs, "utf8")
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${refName}`));
    installedRevision = match?.split(" ", 1)[0]?.toLowerCase();
  }
} else {
  fail("installed Mathlib git HEAD is not a commit or ref");
}

if (!installedRevision || !/^[0-9a-f]{40}$/.test(installedRevision)) {
  fail("installed Mathlib git revision is not a full commit SHA");
}
if (installedRevision !== manifestRevision) {
  fail(
    `installed Mathlib revision ${installedRevision} does not match manifest ${manifestRevision}`,
  );
}

process.stdout.write(`${manifestRevision}\n`);
