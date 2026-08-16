#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryDir = path.join(repoRoot, "docs", "inventory");
const ownershipRelative = "docs/inventory/ownership.json";
const ownershipPath = path.join(repoRoot, ownershipRelative);
const policyControlledPaths = new Set([
  "docs/OWNERSHIP.md",
  ownershipRelative,
  "scripts/ownership-check.mjs",
]);

function parseArguments(argv) {
  let writer = null;
  let base = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--writer" && argument !== "--base") {
      throw new Error(`unknown option: ${argument}`);
    }
    const name = argument.slice(2);
    if ((name === "writer" ? writer : base) !== null) {
      throw new Error(`${argument} may be specified only once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
    if (name === "writer") writer = value;
    else base = value;
    index += 1;
  }
  if ((writer === null) !== (base === null)) {
    throw new Error("--writer and --base must be provided together");
  }
  if (base !== null && !/^[0-9a-f]{7,64}$/i.test(base)) {
    throw new Error("--base must be an explicit hexadecimal commit id (symbolic revisions such as HEAD are rejected)");
  }
  return { writer, base };
}

function git(arguments_) {
  return spawnSync("git", arguments_, { cwd: repoRoot, encoding: "utf-8" });
}

function resolveBase(base) {
  const resolved = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (resolved.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(resolved.stdout.trim())) {
    throw new Error(resolved.stderr.trim() || `could not resolve base commit: ${base}`);
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.status === 0 && head.stdout.trim() === resolved.stdout.trim()) {
    throw new Error("--base must precede HEAD; the current candidate commit cannot be its own trusted policy base");
  }
  const ancestor = git(["merge-base", "--is-ancestor", resolved.stdout.trim(), "HEAD"]);
  if (ancestor.status !== 0) throw new Error(`base is not an ancestor of HEAD: ${base}`);
  return resolved.stdout.trim();
}

function readBaseOwnership(baseCommit) {
  const shown = git(["show", `${baseCommit}:${ownershipRelative}`]);
  if (shown.status !== 0) throw new Error(shown.stderr.trim() || `could not read ${ownershipRelative} from ${baseCommit}`);
  return JSON.parse(shown.stdout);
}

function globRegex(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function laneMatchersFor(ownership) {
  if (!ownership?.lanes || typeof ownership.lanes !== "object") throw new Error("ownership policy has no lanes object");
  return Object.fromEntries(
    Object.entries(ownership.lanes).map(([lane, globs]) => {
      if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
        throw new Error(`ownership lane ${lane} must be an array of globs`);
      }
      return [lane, globs.map((glob) => ({ glob, regex: globRegex(glob) }))];
    }),
  );
}

function ownersFor(file, laneMatchers) {
  return Object.entries(laneMatchers)
    .filter(([, matchers]) => matchers.some(({ regex }) => regex.test(file)))
    .map(([lane]) => lane);
}

function validatedHandoffs(ownership, laneMatchers) {
  const handoffs = ownership.handoffs ?? [];
  if (!Array.isArray(handoffs)) throw new Error("ownership handoffs must be an array");
  return handoffs.map((handoff, index) => {
    for (const field of ["from", "to", "path", "scope"]) {
      if (typeof handoff?.[field] !== "string" || handoff[field].trim() === "") {
        throw new Error(`handoff ${index} has invalid ${field}`);
      }
    }
    if (!laneMatchers[handoff.to]) throw new Error(`handoff ${index} has unknown recipient lane: ${handoff.to}`);
    const fromOwnsPath = ownersFor(handoff.path, laneMatchers).includes(handoff.from);
    const policyOwnerHandoff = handoff.from === "R1" && policyControlledPaths.has(handoff.path);
    if (!fromOwnsPath && !policyOwnerHandoff) {
      throw new Error(`handoff ${index} is not from the owner of ${handoff.path}: ${handoff.from}`);
    }
    return handoff;
  });
}

function collectFiles(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "files" && Array.isArray(child)) {
        for (const file of child) if (typeof file === "string") found.add(file);
      } else collectFiles(child, found);
    }
  }
  return found;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(`ownership-check: FAIL (${error.message})`);
  process.exit(2);
}

const candidateOwnership = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
const inventoryFiles = fs.readdirSync(inventoryDir).filter((name) => name.endsWith(".json") && name !== "ownership.json").sort();
const inventoriedPaths = new Set();
for (const name of inventoryFiles) collectFiles(JSON.parse(fs.readFileSync(path.join(inventoryDir, name), "utf8")), inventoriedPaths);

const inventoryMatchers = laneMatchersFor(candidateOwnership);
validatedHandoffs(candidateOwnership, inventoryMatchers);
const missing = [];
const uncovered = [];
const intersections = [];
for (const file of [...inventoriedPaths].sort()) {
  if (!fs.existsSync(path.join(repoRoot, file))) missing.push(file);
  const owners = ownersFor(file, inventoryMatchers);
  if (owners.length === 0) uncovered.push(file);
  if (owners.length > 1) intersections.push({ file, owners });
}

const unauthorizedChanges = [];
let changedPaths = [];
let baseCommit = null;
if (options.writer !== null) {
  try {
    baseCommit = resolveBase(options.base);
    const trustedOwnership = readBaseOwnership(baseCommit);
    const trustedMatchers = laneMatchersFor(trustedOwnership);
    if (!trustedMatchers[options.writer]) throw new Error(`unknown writer lane in trusted base: ${options.writer}`);
    const trustedHandoffs = validatedHandoffs(trustedOwnership, trustedMatchers);
    const diff = git(["diff", "--name-only", baseCommit, "--"]);
    if (diff.status !== 0) throw new Error(diff.stderr.trim() || `git diff failed for ${baseCommit}`);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--"]);
    if (untracked.status !== 0) throw new Error(untracked.stderr.trim() || "git ls-files failed");
    changedPaths = [...new Set(`${diff.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))].sort();
    for (const file of changedPaths) {
      const directlyOwned = trustedMatchers[options.writer] && ownersFor(file, trustedMatchers).includes(options.writer);
      const handedOff = trustedHandoffs.some(
        (handoff) => handoff.to === options.writer && handoff.path === file,
      );
      const policyAuthorized = !policyControlledPaths.has(file) || trustedHandoffs.some(
        (handoff) => handoff.from === "R1" && handoff.to === options.writer && handoff.path === file,
      );
      if ((!directlyOwned && !handedOff) || !policyAuthorized) unauthorizedChanges.push(file);
    }
  } catch (error) {
    console.error(`ownership-check: FAIL (${error.message})`);
    process.exit(1);
  }
}

if (missing.length || uncovered.length || intersections.length || unauthorizedChanges.length) {
  if (missing.length) console.error(`Missing inventory paths:\n${missing.join("\n")}`);
  if (uncovered.length) console.error(`Unowned inventory paths:\n${uncovered.join("\n")}`);
  for (const overlap of intersections) console.error(`Ownership intersection: ${overlap.file} -> ${overlap.owners.join(", ")}`);
  if (unauthorizedChanges.length) {
    console.error(`Changes not owned by or handed off to ${options.writer} in trusted base ${baseCommit}:\n${unauthorizedChanges.join("\n")}`);
  }
  process.exit(1);
}

console.log(`ownership-check: PASS (${inventoriedPaths.size} inventoried files, ${Object.keys(inventoryMatchers).length} lanes, 0 intersections)`);
if (options.writer !== null) {
  console.log(`ownership-check: PASS (${options.writer} owns or holds trusted-base handoffs for ${changedPaths.length} changed paths vs ${baseCommit})`);
}
