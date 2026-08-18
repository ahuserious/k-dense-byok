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

// Anchored on THIS checkout's node_modules, which is necessary because a bare
// "node_modules/playwright-core" matches a sibling checkout's suite on any machine that has one --
// observed while testing this script.
//
// What this matches is the *node side* of the suite: the coordinator, whose argv is
// `node <root>/node_modules/.bin/playwright test ...`, and its workers, whose argv is
// `node <root>/node_modules/playwright/lib/worker/workerProcessEntry.js`. The coordinator is the
// one that matters. It is the process that owns the run, and signalling it is what actually stops
// the run rather than interrupting it.
//
// What this deliberately does NOT match, and why neither omission leaves a live writer behind:
//
//   * Chromium, its crashpad handler, and the bundled ffmpeg video encoder. These do not live
//     under the checkout at all -- Playwright installs them to its own browser cache
//     (`~/.cache/ms-playwright` on a Linux runner), a path shared with every other checkout on the
//     machine and therefore not safe to pattern-match. They do not need to be matched: measured
//     against a live suite, the worker, the browser, all of the browser's own child processes, and
//     the encoder are gone within a second of the coordinator receiving SIGTERM, because they exit
//     on pipe close once the node side that owns them is gone.
//   * The `npm exec playwright test` wrapper. It carries no path to anchor on, and it writes
//     nothing itself; it exits once the coordinator beneath it is gone.
//
// An earlier revision of this pattern omitted `.bin/`, so it matched the workers but never the
// coordinator. That is strictly worse than doing nothing: with CI's `retries: 2` a live
// coordinator answers a killed worker by spawning a replacement, with a fresh browser and a fresh
// encoder, so the step burned its whole budget fighting a respawn loop, reported success, and
// handed the evidence scan a tree that was live and mid-video-write. Reproduced against this
// checkout: worker, browser and encoder all came back with new pids and the coordinator was never
// touched.
const SUITE_PROCESS_PATTERN = `${escapeForExtendedRegex(repositoryRoot)}/node_modules/(\\.bin/playwright|@playwright/|playwright/|playwright-core/)`;
// Only the Playwright entry point, not all of `node_modules/.bin/`. The hermetic preview is still
// up when this runs -- `Stop hermetic preview` is the step after this one -- and a broad `.bin/`
// match would take its processes down too, ahead of the script whose job that is.
const COORDINATOR_MARKER = `${repositoryRoot}/node_modules/.bin/playwright`;
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

// `ps` is asked for the command line too, so the coordinator can be told apart from its workers.
// A pid whose command cannot be read is still worth signalling; it just sorts as a non-coordinator.
function describeProcesses(processIds) {
  const result = spawnSync("ps", ["-o", "pid=,command=", "-p", processIds.join(",")], {
    encoding: "utf8",
  });
  const commandByProcessId = new Map();
  for (const line of (result.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commandByProcessId.set(Number(match[1]), match[2]);
  }
  return processIds.map((processId) => ({
    processId,
    command: commandByProcessId.get(processId) ?? "",
  }));
}

// pgrep exits 1 to mean "nothing matched", which is a normal answer rather than an error.
function suiteProcesses() {
  const result = spawnSync("pgrep", ["-f", SUITE_PROCESS_PATTERN], { encoding: "utf8" });
  if (result.error) return null;
  const processIds = (result.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !PROTECTED_PIDS.has(pid));
  if (processIds.length === 0) return [];
  return describeProcesses(processIds);
}

function formatProcesses(processes) {
  return processes
    .map(({ processId, command }) => `${String(processId)} ${command}`.trimEnd())
    .join("\n");
}

// Coordinators first, always. A worker killed while its coordinator is still alive is a worker the
// coordinator will replace; a coordinator that is already going down replaces nothing.
function coordinatorFirst(processes) {
  const isCoordinator = (entry) => entry.command.includes(COORDINATOR_MARKER);
  return [...processes.filter(isCoordinator), ...processes.filter((entry) => !isCoordinator(entry))];
}

function signalProcesses(processes, signal) {
  for (const { processId } of coordinatorFirst(processes)) {
    try {
      process.kill(processId, signal);
    } catch {
      // Already gone, or not ours to signal. Either way the next check reports the truth.
    }
  }
}

const initialProcesses = suiteProcesses();
if (initialProcesses === null) {
  process.stdout.write("pgrep is unavailable; cannot check for leftover suite processes.\n");
  process.exit(0);
}
if (initialProcesses.length === 0) {
  process.stdout.write("No leftover suite processes.\n");
  process.exit(0);
}

process.stdout.write(`Leftover suite processes:\n${formatProcesses(initialProcesses)}\n`);
signalProcesses(initialProcesses, "SIGTERM");

// SIGTERM is sent once per pid, not once per second: the coordinator is being asked to wind down
// and it needs the interval to do it, including removing its own `.playwright-artifacts-*` staging
// directories. Anything that appears later is a pid this run has not asked to stop yet, so it gets
// its own SIGTERM.
const termedProcessIds = new Set(initialProcesses.map(({ processId }) => processId));
for (let check = 1; check <= TERM_CHECKS + KILL_CHECKS; check += 1) {
  sleepSync(CHECK_INTERVAL_MS);
  const remaining = suiteProcesses() ?? [];
  if (remaining.length === 0) {
    process.stdout.write(`Leftover suite processes exited after ${String(check)}s.\n`);
    process.exit(0);
  }
  if (check < TERM_CHECKS) {
    const unsignalled = remaining.filter(({ processId }) => !termedProcessIds.has(processId));
    if (unsignalled.length > 0) {
      process.stdout.write(`Newly appeared suite processes:\n${formatProcesses(unsignalled)}\n`);
      for (const { processId } of unsignalled) termedProcessIds.add(processId);
      signalProcesses(unsignalled, "SIGTERM");
    }
    continue;
  }
  if (check === TERM_CHECKS) {
    process.stdout.write("Still running after SIGTERM; escalating to SIGKILL.\n");
  }
  // Coordinator-first again, and repeated every second: a SIGKILLed coordinator cannot spawn a
  // replacement worker, so this converges rather than chasing respawns the way SIGKILLing a worker
  // under a live coordinator did.
  signalProcesses(remaining, "SIGKILL");
}

process.stderr.write(
  `Leftover suite processes survived SIGKILL; the evidence scan may race them:\n` +
    `${formatProcesses(suiteProcesses() ?? [])}\n`,
);
process.exit(0);
