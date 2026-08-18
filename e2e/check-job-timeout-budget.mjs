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
// number, so there is still exactly one place where 54 is written down.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/stably-cloud.yml";
const JOB_ID = "github-runner";
// The job ceiling must exceed the sum of the phases, not merely equal it. A ceiling that sits
// exactly on the sum has no margin, and the property being asserted is that this ceiling is never
// the thing that fires.
const REQUIRED_MARGIN_MINUTES = 1;

// Every phase of the job, each one paired with the variable that budgets it. The three that carry
// no variable are measured figures from the green run 32006038040 rather than enforced budgets;
// they are named here so the sum is auditable and so a step added to one of those phases has a
// stated allowance to be checked against.
const PHASES = [
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
  { label: "post-suite steps (counts, manifest, scan, upload)", variable: "E2E_POST_SUITE_BUDGET_MINUTES" },
  { label: "runner scheduling slop", variable: "E2E_RUNNER_SLOP_MINUTES" },
];

// Deliberately not a YAML parse: this needs no dependency, and the one value it wants has a fixed
// shape. `jobs:` at column 0, the job id at two spaces, its keys at four. Scanning stops at the
// next key at the job's own indent so a `timeout-minutes` belonging to a later job cannot be read
// as this one's.
export function readJobTimeoutMinutes(workflowText, jobId) {
  const lines = workflowText.split("\n");
  const jobHeader = lines.findIndex((line) => line === `  ${jobId}:`);
  if (jobHeader === -1) {
    throw new Error(`No job \`${jobId}\` at the expected indent in ${WORKFLOW_PATH}.`);
  }
  for (let index = jobHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,2}\S/.test(line)) break;
    const match = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (match) return Number(match[1]);
  }
  throw new Error(
    `Job \`${jobId}\` in ${WORKFLOW_PATH} has no literal job-level \`timeout-minutes\`. ` +
      "The phase budgets have nothing to be checked against.",
  );
}

export function collectPhaseMinutes(environment) {
  const phases = [];
  const missing = [];
  for (const { label, variable } of PHASES) {
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

export function renderBudgetReport(phases, ceilingMinutes) {
  const sumMinutes = phases.reduce((total, phase) => total + phase.minutes, 0);
  const width = Math.max(...phases.map((phase) => phase.label.length));
  const lines = phases.map(
    (phase) => `  ${phase.label.padEnd(width)}  ${String(phase.minutes).padStart(3)}m  (${phase.variable})`,
  );
  lines.push(`  ${"phase total".padEnd(width)}  ${String(sumMinutes).padStart(3)}m`);
  lines.push(`  ${"job ceiling".padEnd(width)}  ${String(ceilingMinutes).padStart(3)}m  (${WORKFLOW_PATH}, job \`${JOB_ID}\`)`);
  return { sumMinutes, report: lines.join("\n") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workflowText = fs.readFileSync(path.join(repositoryRoot, WORKFLOW_PATH), "utf8");
    const ceilingMinutes = readJobTimeoutMinutes(workflowText, JOB_ID);
    const phases = collectPhaseMinutes(process.env);
    const { sumMinutes, report } = renderBudgetReport(phases, ceilingMinutes);
    process.stdout.write(`${report}\n`);
    if (ceilingMinutes - sumMinutes < REQUIRED_MARGIN_MINUTES) {
      process.stderr.write(
        `\nThe phase budgets sum to ${String(sumMinutes)}m against a ${String(ceilingMinutes)}m job ceiling, leaving ` +
          `${String(ceilingMinutes - sumMinutes)}m of margin; at least ${String(REQUIRED_MARGIN_MINUTES)}m is required.\n` +
          "A job that hits its own ceiling is cancelled rather than failed: no suite counts, no hosted\n" +
          "evidence manifest, and a conclusion that reads as though a person pressed the button. Raise\n" +
          `the job \`timeout-minutes\` in ${WORKFLOW_PATH} or lower a phase budget.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `\nMargin: ${String(ceilingMinutes - sumMinutes)}m. The job ceiling is above every budgeted phase combined, so a\n` +
        "phase that overruns fails its own step and the evidence steps below it still run.\n",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Job timeout budget check could not run: ${reason}\n`);
    process.exit(1);
  }
}
