#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function parseArguments(argv) {
  const options = {
    root: repoRoot,
    base: null,
    lane: "R1",
    waivers: "docs/lanes/ADV-REVIEW-WAIVERS.json",
    output: null,
    dryRun: false,
    fixtureOutput: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (
      argument === "--root" ||
      argument === "--base" ||
      argument === "--lane" ||
      argument === "--waivers" ||
      argument === "--output" ||
      argument === "--fixture-output"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      const key = argument
        .slice(2)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  options.root = path.resolve(options.root);
  if (!options.base) throw new Error("--base <commit> is required");
  if (!/^[A-Za-z0-9._-]+$/.test(options.lane)) {
    throw new Error("--lane may contain only letters, digits, dot, underscore, and hyphen");
  }
  options.waivers = path.resolve(options.root, options.waivers);
  options.output = options.output
    ? path.resolve(options.output)
    : path.join(options.root, "docs", "lanes", `${options.lane}-findings.json`);
  if (options.fixtureOutput) options.fixtureOutput = path.resolve(options.fixtureOutput);
  return options;
}

function verifyBase(root, base) {
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function loadWaivers(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.version !== 1 || !Array.isArray(parsed.waivers)) {
    throw new Error(`Invalid waiver ledger: ${file}`);
  }
  for (const waiver of parsed.waivers) {
    if (
      typeof waiver.id !== "string" ||
      typeof waiver.file !== "string" ||
      typeof waiver.severity !== "string" ||
      typeof waiver.rationalePattern !== "string" ||
      typeof waiver.reason !== "string" ||
      typeof waiver.approvedBy !== "string"
    ) {
      throw new Error(`Invalid waiver entry in ${file}`);
    }
    if (!SEVERITIES.has(waiver.severity)) {
      throw new Error(`Invalid waiver severity for ${waiver.id}`);
    }
    new RegExp(waiver.rationalePattern, "i");
  }
  return parsed.waivers;
}

function extractJson(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Reviewer output did not contain a JSON findings array");
  }
}

export function normalizeFindings(raw) {
  const parsed = typeof raw === "string" ? extractJson(raw) : raw;
  const findings = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(findings)) throw new Error("Reviewer output must be a JSON array or {findings: []}");
  return findings.map((finding, index) => {
    if (!finding || typeof finding !== "object") {
      throw new Error(`Finding ${index + 1} must be an object`);
    }
    const severity = String(finding.severity ?? "").toUpperCase();
    const file = String(finding.file ?? "").trim();
    const rationale = String(finding.rationale ?? "").trim();
    if (!SEVERITIES.has(severity)) throw new Error(`Finding ${index + 1} has invalid severity`);
    if (!file || !rationale) throw new Error(`Finding ${index + 1} needs file and rationale`);
    return { severity, file, rationale };
  });
}

function isWaived(finding, waiver, now = new Date()) {
  if (waiver.severity !== finding.severity || waiver.file !== finding.file) return false;
  if (waiver.expiresOn) {
    const expiry = new Date(`${waiver.expiresOn}T23:59:59.999Z`);
    if (Number.isNaN(expiry.getTime()) || expiry < now) return false;
  }
  return new RegExp(waiver.rationalePattern, "i").test(finding.rationale);
}

export function applyWaivers(findings, waivers) {
  return findings.map((finding) => ({
    finding,
    waiver: waivers.find((candidate) => isWaived(finding, candidate)) ?? null,
  }));
}

function reviewPrompt(base) {
  return [
    `Claim under review: the changes since ${base} satisfy their stated requirements without correctness or evidence gaps.`,
    "Falsify that claim. Inspect the diff, files, tests, and evidence artifacts.",
    "Return ONLY a JSON array. Every item must have exactly severity, file, and rationale.",
    "Severity must be P0, P1, P2, or P3. Lead with blocking findings and cite exact paths.",
    "Do not credit intent, skipped tests, ambiguous logs, or unverified claims. Return [] only for PASS.",
  ].join("\n");
}

function runCodexReview(root, base) {
  execFileSync("codex", ["login", "status"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return execFileSync("codex", ["review", "--base", base, reviewPrompt(base)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function writeFindings(file, findings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  verifyBase(options.root, options.base);
  const waivers = loadWaivers(options.waivers);
  let rawOutput;
  if (options.dryRun) {
    rawOutput = options.fixtureOutput
      ? fs.readFileSync(options.fixtureOutput, "utf8")
      : "[]";
    console.log("adv-review: DRY RUN — codex login status and codex review were not invoked");
  } else {
    rawOutput = runCodexReview(options.root, options.base);
  }
  const findings = normalizeFindings(rawOutput);
  writeFindings(options.output, findings);
  const assessed = applyWaivers(findings, waivers);
  const unwaived = assessed.filter(({ finding, waiver }) => finding.severity !== "P3" && !waiver);
  const waived = assessed.filter(({ waiver }) => waiver);
  console.log(`adv-review: wrote ${findings.length} finding(s) to ${options.output}`);
  console.log(`adv-review: ${waived.length} waived; ${unwaived.length} unwaived blocking finding(s)`);
  if (unwaived.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`adv-review: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
