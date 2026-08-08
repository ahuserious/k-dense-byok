#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryDir = path.join(repoRoot, "docs", "inventory");
const ownershipPath = path.join(inventoryDir, "ownership.json");

function globRegex(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function collectFiles(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === "files" && Array.isArray(child)) {
      for (const file of child) {
        if (typeof file === "string") found.add(file);
      }
    } else {
      collectFiles(child, found);
    }
  }
  return found;
}

const ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
const laneMatchers = Object.fromEntries(
  Object.entries(ownership.lanes).map(([lane, globs]) => [
    lane,
    globs.map((glob) => ({ glob, regex: globRegex(glob) })),
  ]),
);

const inventoryFiles = fs
  .readdirSync(inventoryDir)
  .filter((name) => name.endsWith(".json") && name !== "ownership.json")
  .sort();
const inventoriedPaths = new Set();
for (const name of inventoryFiles) {
  const parsed = JSON.parse(fs.readFileSync(path.join(inventoryDir, name), "utf8"));
  collectFiles(parsed, inventoriedPaths);
}

const missing = [];
const uncovered = [];
const intersections = [];
for (const file of [...inventoriedPaths].sort()) {
  if (!fs.existsSync(path.join(repoRoot, file))) missing.push(file);
  const owners = Object.entries(laneMatchers)
    .filter(([, matchers]) => matchers.some(({ regex }) => regex.test(file)))
    .map(([lane]) => lane);
  if (owners.length === 0) uncovered.push(file);
  if (owners.length > 1) intersections.push({ file, owners });
}

if (missing.length || uncovered.length || intersections.length) {
  if (missing.length) console.error(`Missing inventory paths:\n${missing.join("\n")}`);
  if (uncovered.length) console.error(`Unowned inventory paths:\n${uncovered.join("\n")}`);
  for (const overlap of intersections) {
    console.error(`Ownership intersection: ${overlap.file} -> ${overlap.owners.join(", ")}`);
  }
  process.exit(1);
}

console.log(`ownership-check: PASS (${inventoriedPaths.size} inventoried files, ${Object.keys(laneMatchers).length} lanes, 0 intersections)`);
