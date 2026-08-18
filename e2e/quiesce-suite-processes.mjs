#!/usr/bin/env node
// Waits for the Playwright process tree to actually be gone before anything walks the artifact
// directory it writes into.
//
// A suite step stopped by `timeout-minutes` leaves that tree behind. The cancelled run
// 32094043747 shows the shape: its post-job cleanup terminated an orphaned
// `npm exec playwright test`, its Chromium, and the `ffmpeg-linux` video encoder -- all still
// running long after the evidence steps had finished. Those orphans create and delete files under
// `.stably/test-results/.playwright-artifacts-*`, which is what made "Scan hosted evidence
// artifacts" fail in that run: it read a `page@<hash>.webm` out of a directory listing and the
// encoder removed it before the scan could stat it.
//
// This never exits non-zero. It runs on the failure path, where the useful thing is to report what
// is still running, not to stack a second failure on top of the first.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeForExtendedRegex(value) {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

// Anchored on THIS checkout's node_modules, which is both necessary and sufficient. Necessary
// because a bare "node_modules/playwright-core" matches a sibling checkout's suite on any machine
// that has one -- observed while testing this script. Sufficient because every process that writes
// into the artifact directory is launched from here: the Playwright coordinator and its workers
// from node_modules/playwright, and Chromium, its crashpad handler, and the bundled ffmpeg-linux
// video encoder from node_modules/playwright-core/.local-browsers. The `npm exec playwright test`
// wrapper is deliberately not matched -- it carries no path to anchor on, and it writes nothing
// itself; it exits once the coordinator beneath it is gone.
const SUITE_PROCESS_PATTERN =
  `${escapeForExtendedRegex(repositoryRoot)}/node_modules/(@playwright|playwright|playwright-core)/`;
// Signalling explicitly listed pids rather than shelling out to `pkill` means this process, and
// whatever launched it, can be excluded by construction. A pattern matching its own caller is not
// hypothetical: any shell whose argv happens to carry the pattern text matches it.
const PROTECTED_PIDS = new Set([process.pid, process.ppid]);
const TERM_CHECKS = 10;
const KILL_CHECKS = 20;
const CHECK_INTERVAL_MS = 1000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// pgrep exits 1 to mean "nothing matched", which is a normal answer rather than an error.
function suiteProcessIds() {
  const result = spawnSync("pgrep", ["-f", SUITE_PROCESS_PATTERN], { encoding: "utf8" });
  if (result.error) return null;
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !PROTECTED_PIDS.has(pid));
}

function describeProcesses(processIds) {
  const result = spawnSync("ps", ["-o", "pid=,command=", "-p", processIds.join(",")], {
    encoding: "utf8",
  });
  const listing = (result.stdout ?? "").trim();
  return listing.length > 0 ? listing : processIds.join(", ");
}

function signalProcesses(processIds, signal) {
  for (const processId of processIds) {
    try {
      process.kill(processId, signal);
    } catch {
      // Already gone, or not ours to signal. Either way the next check reports the truth.
    }
  }
}

const initialProcessIds = suiteProcessIds();
if (initialProcessIds === null) {
  process.stdout.write("pgrep is unavailable; cannot check for leftover suite processes.\n");
  process.exit(0);
}
if (initialProcessIds.length === 0) {
  process.stdout.write("No leftover suite processes.\n");
  process.exit(0);
}

process.stdout.write(`Leftover suite processes:\n${describeProcesses(initialProcessIds)}\n`);
signalProcesses(initialProcessIds, "SIGTERM");

let escalated = false;
for (let check = 1; check <= TERM_CHECKS + KILL_CHECKS; check += 1) {
  sleepSync(CHECK_INTERVAL_MS);
  const remaining = suiteProcessIds() ?? [];
  if (remaining.length === 0) {
    process.stdout.write(`Leftover suite processes exited after ${String(check)}s.\n`);
    process.exit(0);
  }
  if (check === TERM_CHECKS && !escalated) {
    escalated = true;
    process.stdout.write("Still running after SIGTERM; escalating to SIGKILL.\n");
    signalProcesses(remaining, "SIGKILL");
  }
}

process.stderr.write(
  `Leftover suite processes survived SIGKILL; the evidence scan may race them:\n` +
    `${describeProcesses(suiteProcessIds() ?? [])}\n`,
);
process.exit(0);
