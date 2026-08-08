#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATTERN = /<!--\s*test-ledger-baseline\s+(\{.*?\})\s*-->/gs;
const ENTRY_PATTERN = /<!--\s*test-ledger-entry\s+(\{.*?\})\s*-->/gs;

function parseArguments(argv) {
  const options = { root: repoRoot, suite: "server", counts: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--root" || argument === "--suite" || argument === "--counts") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--root") options.root = path.resolve(value);
      else options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.counts) throw new Error("--counts <passed>,<skipped> is required");
  if (!new Set(["server", "web"]).has(options.suite)) {
    throw new Error("--suite must be server or web");
  }
  const match = options.counts.match(/^(\d+),(\d+)$/);
  if (!match) throw new Error("--counts must be two non-negative integers: <passed>,<skipped>");
  options.counts = { passed: Number(match[1]), skipped: Number(match[2]) };
  return options;
}

function markdownFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function parseJsonComments(content, pattern, source) {
  const values = [];
  for (const match of content.matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1]));
    } catch (error) {
      throw new Error(`Invalid test-ledger JSON in ${source}: ${error.message}`);
    }
  }
  return values;
}

export function loadLedger(root = repoRoot) {
  const directory = path.join(root, "docs", "test-ledger");
  const baselines = [];
  const entries = [];
  for (const file of markdownFiles(directory)) {
    const content = fs.readFileSync(file, "utf8");
    baselines.push(...parseJsonComments(content, BASELINE_PATTERN, file));
    entries.push(...parseJsonComments(content, ENTRY_PATTERN, file));
  }
  if (baselines.length !== 1) {
    throw new Error(`Expected exactly one test-ledger baseline, found ${baselines.length}`);
  }
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.id || typeof entry.id !== "string") throw new Error("Every test-ledger entry needs an id");
    if (ids.has(entry.id)) throw new Error(`Duplicate test-ledger entry id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.reason || typeof entry.reason !== "string") {
      throw new Error(`Test-ledger entry ${entry.id} needs a reason`);
    }
    if (!new Set(["server", "web"]).has(entry.suite)) {
      throw new Error(`Test-ledger entry ${entry.id} has an invalid suite`);
    }
    if (!new Set(["delta", "observation"]).has(entry.kind)) {
      throw new Error(`Test-ledger entry ${entry.id} has an invalid kind`);
    }
    if (entry.kind === "observation") {
      if (!Number.isInteger(entry.passed) || !Number.isInteger(entry.skipped)) {
        throw new Error(`Observation ${entry.id} needs integer passed and skipped counts`);
      }
    } else if (
      !Number.isInteger(entry.passedDelta ?? 0) ||
      !Number.isInteger(entry.skippedDelta ?? 0)
    ) {
      throw new Error(`Delta ${entry.id} needs integer passedDelta and skippedDelta values`);
    }
  }
  return { baseline: baselines[0], entries };
}

export function evaluateCounts(ledger, suite, actual) {
  const baseline = ledger.baseline[suite];
  if (!baseline || !Number.isInteger(baseline.passed) || !Number.isInteger(baseline.skipped)) {
    throw new Error(`Missing or invalid ${suite} baseline`);
  }
  const observations = ledger.entries.filter(
    (entry) => entry.kind === "observation" && entry.suite === suite,
  );
  const matchedObservation = observations.find(
    (entry) => entry.passed === actual.passed && entry.skipped === actual.skipped,
  );
  if (matchedObservation) {
    return {
      passed: true,
      suite,
      actual,
      expected: { passed: matchedObservation.passed, skipped: matchedObservation.skipped },
      basis: `recorded observation ${matchedObservation.id}`,
    };
  }

  const activeDeltas = ledger.entries.filter(
    (entry) => entry.kind === "delta" && entry.suite === suite && entry.active === true,
  );
  const expected = activeDeltas.reduce(
    (counts, entry) => ({
      passed: counts.passed + Number(entry.passedDelta ?? 0),
      skipped: counts.skipped + Number(entry.skippedDelta ?? 0),
    }),
    { passed: baseline.passed, skipped: baseline.skipped },
  );
  const passedDecreased = actual.passed < expected.passed;
  const totalDecreased = actual.passed + actual.skipped < expected.passed + expected.skipped;
  return {
    passed: !passedDecreased && !totalDecreased,
    suite,
    actual,
    expected,
    basis: activeDeltas.length > 0
      ? `baseline plus active deltas: ${activeDeltas.map((entry) => entry.id).join(", ")}`
      : "baseline",
    reasons: [
      ...(passedDecreased ? [`passed count decreased by ${expected.passed - actual.passed}`] : []),
      ...(totalDecreased
        ? [`total test count decreased by ${expected.passed + expected.skipped - actual.passed - actual.skipped}`]
        : []),
    ],
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = evaluateCounts(loadLedger(options.root), options.suite, options.counts);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.passed) {
    console.log(
      `test-ledger-check: PASS ${result.suite} ${result.actual.passed} passed/${result.actual.skipped} skipped (${result.basis})`,
    );
  } else {
    console.error(
      `test-ledger-check: FAIL ${result.suite} ${result.actual.passed} passed/${result.actual.skipped} skipped; expected at least ${result.expected.passed} passed/${result.expected.skipped} skipped from ${result.basis}`,
    );
    for (const reason of result.reasons) console.error(`- ${reason}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`test-ledger-check: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
