#!/usr/bin/env node
// Turns the NDJSON written by e2e/spec-timing-reporter.ts into a job summary section, so that
// "the suite got slower" can be answered with "this spec got slower" instead of a shrug.
//
// This runs as an `if: always()` diagnostic step. It therefore never exits non-zero: a missing or
// truncated timings file is itself information, and a summariser that fails would mask whatever
// actually broke the run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMINGS_FILE = ".stably/e2e-spec-timings.ndjson";
const DEFAULT_TOP_COUNT = 10;

function parseArguments(argv) {
  const options = { timings: DEFAULT_TIMINGS_FILE, top: DEFAULT_TOP_COUNT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--timings" && argument !== "--top") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--timings") {
      options.timings = value;
    } else {
      if (!/^[1-9]\d*$/.test(value)) throw new Error("--top requires a positive integer");
      options.top = Number(value);
    }
    index += 1;
  }
  return options;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.round(totalSeconds - wholeMinutes * 60);
  // Rounding 59.7s up must not print "3m60s".
  if (remainingSeconds === 60) return `${String(wholeMinutes + 1)}m00s`;
  return `${String(wholeMinutes)}m${String(remainingSeconds).padStart(2, "0")}s`;
}

// A pipe inside a test title would otherwise split the markdown table cell it lands in.
function escapeTableCell(value) {
  return value.replace(/\|/g, "\\|");
}

export function readTimingRecords(timingsPath) {
  let contents;
  try {
    contents = fs.readFileSync(timingsPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { records: [], unparsableLines: 0, present: false };
    throw error;
  }
  const records = [];
  let unparsableLines = 0;
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.file !== "string" || typeof record.durationMs !== "number") {
        unparsableLines += 1;
        continue;
      }
      records.push(record);
    } catch {
      // The last line is routinely half-written when the suite is killed mid-append; counting
      // those is more useful than discarding them silently.
      unparsableLines += 1;
    }
  }
  return { records, unparsableLines, present: true };
}

export function aggregateByFile(records) {
  const byFile = new Map();
  for (const record of records) {
    const existing = byFile.get(record.file) ?? {
      file: record.file,
      items: 0,
      totalMs: 0,
      slowestMs: -1,
      slowestTitle: "",
    };
    existing.items += 1;
    existing.totalMs += record.durationMs;
    if (record.durationMs > existing.slowestMs) {
      existing.slowestMs = record.durationMs;
      existing.slowestTitle = record.title ?? "";
    }
    byFile.set(record.file, existing);
  }
  return [...byFile.values()].sort((left, right) => right.totalMs - left.totalMs);
}

function budgetLines(environment) {
  const lines = [];
  const budgetMinutes = Number(environment.E2E_SUITE_TIMEOUT_MINUTES);
  const elapsedSeconds = Number(environment.E2E_SUITE_ELAPSED_SECONDS);
  const outcome = environment.E2E_SUITE_OUTCOME ?? "not recorded";

  if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 && Number.isFinite(budgetMinutes) && budgetMinutes > 0) {
    const budgetMs = budgetMinutes * 60_000;
    const elapsedMs = elapsedSeconds * 1000;
    const usedPercent = Math.round((elapsedMs / budgetMs) * 100);
    lines.push(
      `- Suite budget: ${formatDuration(budgetMs)}; suite wall clock: ${formatDuration(elapsedMs)} (${String(usedPercent)}% of budget)`,
    );
    if (elapsedMs >= budgetMs) {
      lines.push(
        "- **The suite exceeded its own budget and was stopped by the suite step's `timeout-minutes`.**",
        "  The job was not cancelled, so the suite counts and the hosted evidence manifest were still",
        "  written, and whatever timings the suite produced before it was stopped are below.",
      );
    }
  } else {
    lines.push(`- Suite budget: not recorded; suite outcome: ${outcome}`);
  }
  return lines;
}

export function renderSummary({ records, unparsableLines, present }, options, environment) {
  const lines = ["## E2E per-spec timing", ""];
  lines.push(...budgetLines(environment));

  if (!present) {
    lines.push(
      "",
      `No timing file at \`${options.timings}\`. Either the suite step never started, or it was`,
      "killed before the first test finished. Neither is a regression in a spec.",
      "",
    );
    return lines.join("\n");
  }

  const recordedMs = records.reduce((total, record) => total + record.durationMs, 0);
  lines.push(
    `- Items recorded: ${String(records.length)}` +
      (unparsableLines > 0 ? ` (+${String(unparsableLines)} unparsable line(s), expected when a run is killed mid-write)` : ""),
    `- Recorded test time: ${formatDuration(recordedMs)} summed across workers`,
    "",
  );

  if (records.length === 0) {
    lines.push("No test finished, so there is nothing to attribute a slowdown to.", "");
    return lines.join("\n");
  }

  const fileTotals = aggregateByFile(records);
  lines.push(
    `### Slowest spec files (${String(Math.min(options.top, fileTotals.length))} of ${String(fileTotals.length)})`,
    "",
    "| spec file | items | total | mean | slowest item |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const total of fileTotals.slice(0, options.top)) {
    lines.push(
      `| ${escapeTableCell(total.file)} | ${String(total.items)} | ${formatDuration(total.totalMs)} | ` +
        `${formatDuration(total.totalMs / total.items)} | ${formatDuration(total.slowestMs)} — ${escapeTableCell(total.slowestTitle)} |`,
    );
  }

  const slowestItems = [...records].sort((left, right) => right.durationMs - left.durationMs);
  lines.push(
    "",
    `### Slowest items (${String(Math.min(options.top, slowestItems.length))} of ${String(slowestItems.length)})`,
    "",
    "| duration | status | location | title |",
    "| ---: | --- | --- | --- |",
  );
  for (const record of slowestItems.slice(0, options.top)) {
    const retrySuffix = record.retry > 0 ? ` (retry ${String(record.retry)})` : "";
    lines.push(
      `| ${formatDuration(record.durationMs)} | ${escapeTableCell(String(record.status))}${retrySuffix} | ` +
        `${escapeTableCell(record.file)}:${String(record.line)} | ${escapeTableCell(record.title ?? "")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let summary;
  try {
    const options = parseArguments(process.argv.slice(2));
    const timingsPath = path.resolve(process.cwd(), options.timings);
    summary = renderSummary(readTimingRecords(timingsPath), options, process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    summary = `## E2E per-spec timing\n\nTiming summary unavailable: ${reason}\n`;
  }
  process.stdout.write(`${summary}\n`);
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      fs.appendFileSync(stepSummaryPath, `${summary}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stdout.write(`Could not append to the job summary: ${reason}\n`);
    }
  }
}
