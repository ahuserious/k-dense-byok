#!/usr/bin/env node
// Fails the job in its first seconds if the phase budgets no longer fit under the job ceiling.
//
// The job's `timeout-minutes` cannot be an expression: GitHub does not make `env` available in the
// job-level context, so `${{ fromJSON(env.…) }}` is rejected there while the identical expression
// is accepted on a step. The ceiling is therefore a literal, and nothing in Actions ties it to the
// phase budgets it was derived from. Raising E2E_SUITE_TIMEOUT_MINUTES on its own would silently
// restore the failure this whole arrangement exists to prevent: the job ceiling fires before the
// suite step's own budget, the job is cancelled rather than failed, and no evidence is written.
//
// So the relationship is asserted here instead. The ceiling is read out of the workflow file --
// which is checked out by the time this runs -- rather than restated as a second copy of the
// number, so there is still exactly one place where each ceiling is written down.
//
// TARGETS. There is one entry in TARGETS per (workflow file, job id) that documents a phase budget.
// `--target hosted-runner` is the default, so `node e2e/check-job-timeout-budget.mjs` with no
// arguments still checks stably-cloud.yml's `github-runner` exactly as it did before. Adding a
// budgeted job means adding a target here: the phase VARIABLE NAMES are what makes a budget
// checkable, and they differ per job, so there is nothing generic to infer from the workflow file.
// A job that carries a phase-budget comment and no target is a decoration, which is the specific
// failure this file exists to make impossible.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The job ceiling must exceed the sum of the phases, not merely equal it. A ceiling that sits
// exactly on the sum has no margin, and the property being asserted is that this ceiling is never
// the thing that fires.
const REQUIRED_MARGIN_MINUTES = 1;

export const TARGETS = {
  // Job A of the hosted-runner workflow: the leg that produces the substantive-floor result.
  // The three phases with no variable of their own are measured figures from the green run
  // 32006038040 rather than enforced budgets; they are named here so the sum is auditable and so a
  // step added to one of those phases has a stated allowance to be checked against.
  "hosted-runner": {
    workflowPath: ".github/workflows/stably-cloud.yml",
    jobId: "github-runner",
    phases: [
      {
        label: "pre-suite steps excluding the browser install",
        variable: "E2E_PRE_SUITE_BUDGET_MINUTES",
      },
      { label: "browser install (Stably)", variable: "E2E_BROWSER_INSTALL_TIMEOUT_MINUTES" },
      {
        label: "browser install (Playwright fallback)",
        variable: "E2E_BROWSER_FALLBACK_TIMEOUT_MINUTES",
      },
      { label: "the suite", variable: "E2E_SUITE_TIMEOUT_MINUTES" },
      {
        label: "post-suite steps (counts, manifest, scan, upload)",
        variable: "E2E_POST_SUITE_BUDGET_MINUTES",
      },
      { label: "runner scheduling slop", variable: "E2E_RUNNER_SLOP_MINUTES" },
    ],
  },
  // The Wave-F unmocked click-through tier. Same discipline, much smaller suite, and its own
  // variable prefix so a change to one leg's budget can never be read as a change to the other's.
  // Round 1 shipped this job with a five-phase budget in a comment and only two of the five
  // declared as variables, and nothing checking either -- the reviewer was right that an
  // unenforced budget comment is worse than no comment, because it reads as a guarantee.
  "wave-f": {
    workflowPath: ".github/workflows/wave-f-e2e.yml",
    jobId: "wave-f",
    phases: [
      {
        label: "pre-suite steps excluding the browser install",
        variable: "E2E_WAVE_F_PRE_SUITE_BUDGET_MINUTES",
      },
      { label: "browser install", variable: "E2E_WAVE_F_BROWSER_INSTALL_TIMEOUT_MINUTES" },
      { label: "the Wave-F suite", variable: "E2E_WAVE_F_SUITE_TIMEOUT_MINUTES" },
      {
        label: "post-suite steps (evidence, scan, upload)",
        variable: "E2E_WAVE_F_POST_SUITE_BUDGET_MINUTES",
      },
      { label: "runner scheduling slop", variable: "E2E_WAVE_F_RUNNER_SLOP_MINUTES" },
    ],
  },
};

export const DEFAULT_TARGET_NAME = "hosted-runner";

export function resolveTarget(targetName) {
  const target = TARGETS[targetName];
  if (target === undefined) {
    throw new Error(
      `Unknown --target ${JSON.stringify(targetName)}. Known targets: ` +
        `${Object.keys(TARGETS).join(", ")}. A job with a phase budget needs an entry in TARGETS.`,
    );
  }
  return { name: targetName, ...target };
}

export function parseArguments(argv) {
  let targetName = DEFAULT_TARGET_NAME;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--target needs a value.");
      targetName = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      targetName = argument.slice("--target=".length);
      continue;
    }
    throw new Error(
      `Unrecognised argument ${JSON.stringify(argument)}. Usage: ` +
        `check-job-timeout-budget.mjs [--target ${Object.keys(TARGETS).join("|")}]`,
    );
  }
  return { targetName };
}

// Deliberately not a YAML parse: this needs no dependency, and the one value it wants has a fixed
// shape. `jobs:` at column 0, the job id at two spaces, its keys at four. Scanning stops at the
// next key at the job's own indent so a `timeout-minutes` belonging to a later job cannot be read
// as this one's.
export function readJobTimeoutMinutes(workflowText, jobId, workflowPath = "the workflow file") {
  const lines = workflowText.split("\n");
  const jobHeader = lines.findIndex((line) => line === `  ${jobId}:`);
  if (jobHeader === -1) {
    throw new Error(`No job \`${jobId}\` at the expected indent in ${workflowPath}.`);
  }
  for (let index = jobHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,2}\S/.test(line)) break;
    const match = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (match) return Number(match[1]);
  }
  throw new Error(
    `Job \`${jobId}\` in ${workflowPath} has no literal job-level \`timeout-minutes\`. ` +
      "The phase budgets have nothing to be checked against.",
  );
}

export function collectPhaseMinutes(environment, phaseSpecs) {
  const phases = [];
  const missing = [];
  for (const { label, variable } of phaseSpecs) {
    const raw = environment[variable];
    if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) {
      missing.push(`${variable} (${raw === undefined ? "unset" : `not a whole number: ${raw}`})`);
      continue;
    }
    phases.push({ label, variable, minutes: Number(raw) });
  }
  if (missing.length > 0) {
    throw new Error(`Phase budget variables are not usable: ${missing.join(", ")}`);
  }
  return phases;
}

export function renderBudgetReport(phases, ceilingMinutes, workflowPath, jobId) {
  const sumMinutes = phases.reduce((total, phase) => total + phase.minutes, 0);
  const width = Math.max(...phases.map((phase) => phase.label.length));
  const lines = phases.map(
    (phase) => `  ${phase.label.padEnd(width)}  ${String(phase.minutes).padStart(3)}m  (${phase.variable})`,
  );
  lines.push(`  ${"phase total".padEnd(width)}  ${String(sumMinutes).padStart(3)}m`);
  lines.push(`  ${"job ceiling".padEnd(width)}  ${String(ceilingMinutes).padStart(3)}m  (${workflowPath}, job \`${jobId}\`)`);
  return { sumMinutes, report: lines.join("\n") };
}

/**
 * The whole check for one target, as a function, so a contract test can drive it against a chosen
 * environment instead of shelling out and parsing prose. Returns the report; throws on a violation.
 */
export function checkJobTimeoutBudget({
  targetName = DEFAULT_TARGET_NAME,
  environment = process.env,
  rootDirectory = repositoryRoot,
} = {}) {
  const target = resolveTarget(targetName);
  const workflowText = fs.readFileSync(path.join(rootDirectory, target.workflowPath), "utf8");
  const ceilingMinutes = readJobTimeoutMinutes(workflowText, target.jobId, target.workflowPath);
  const phases = collectPhaseMinutes(environment, target.phases);
  const { sumMinutes, report } = renderBudgetReport(
    phases,
    ceilingMinutes,
    target.workflowPath,
    target.jobId,
  );
  const marginMinutes = ceilingMinutes - sumMinutes;
  if (marginMinutes < REQUIRED_MARGIN_MINUTES) {
    const error = new Error(
      `The phase budgets sum to ${String(sumMinutes)}m against a ${String(ceilingMinutes)}m job ceiling, leaving ` +
        `${String(marginMinutes)}m of margin; at least ${String(REQUIRED_MARGIN_MINUTES)}m is required.\n` +
        "A job that hits its own ceiling is cancelled rather than failed: no suite counts, no hosted\n" +
        "evidence manifest, and a conclusion that reads as though a person pressed the button. Raise\n" +
        `the job \`timeout-minutes\` in ${target.workflowPath} or lower a phase budget.`,
    );
    error.report = report;
    throw error;
  }
  return { target, ceilingMinutes, sumMinutes, marginMinutes, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { targetName } = parseArguments(process.argv.slice(2));
    const result = checkJobTimeoutBudget({ targetName });
    process.stdout.write(`${result.report}\n`);
    process.stdout.write(
      `\nMargin: ${String(result.marginMinutes)}m. The job ceiling is above every budgeted phase combined, so a\n` +
        "phase that overruns fails its own step and the evidence steps below it still run.\n",
    );
  } catch (error) {
    if (error && typeof error === "object" && typeof error.report === "string") {
      process.stdout.write(`${error.report}\n`);
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Job timeout budget check could not run: ${reason}\n`);
    process.exit(1);
  }
}
