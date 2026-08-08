#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_PATTERNS = [
  { name: "kady-workflow-supervisor", pattern: /kady-workflow-supervisor/i },
  { name: "tsx preflight", pattern: /tsx(?:\/|\\)dist(?:\/|\\)preflight\.cjs/i },
  { name: "vendored workflow engine", pattern: /vendor(?:\/|\\)archon-engine/i },
  { name: "Next.js", pattern: /(?:^|\s|\/|\\)next(?:\.js)?\s+(?:dev|start)(?:\s|$)/i },
];
const TMP_DIRECTORY_PATTERN = /^(?:kady|tsx|vite|next|archon|sds)[-_]/i;

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function outputOf(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return typeof error.stdout === "string" ? error.stdout : "";
    }
    throw error;
  }
}

function cwdForPid(pid) {
  const output = outputOf("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
  return cwdLine?.slice(1) || null;
}

export function parseProcessSnapshot(output, root = repoRoot, cwdLookup = cwdForPid) {
  const matches = [];
  for (const line of output.split("\n")) {
    const parsed = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    const ppid = Number(parsed[2]);
    const command = parsed[3];
    const matchedPattern = PROCESS_PATTERNS.find(({ pattern }) => pattern.test(command));
    if (!matchedPattern) continue;
    const cwd = cwdLookup(pid);
    if (cwd && !isWithinRoot(cwd, root)) continue;
    if (!cwd && !command.includes(root)) {
      // A missing cwd is common for a just-orphaned process. Keep a named
      // pattern match fail-closed rather than silently losing the evidence.
    }
    matches.push({ pid, ppid, command, cwd, kind: matchedPattern.name });
  }
  return matches;
}

export function parseListenerSnapshot(output, root = repoRoot, cwdLookup = cwdForPid) {
  const listeners = [];
  const lines = output.split("\n").filter(Boolean);
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) continue;
    const tcpFieldIndex = fields.findIndex((field) => field === "TCP" || field.startsWith("TCP@"));
    const endpoint = tcpFieldIndex === -1 ? fields.at(-1) : fields[tcpFieldIndex + 1];
    if (!endpoint) continue;
    const cwd = cwdLookup(pid);
    if (cwd && !isWithinRoot(cwd, root)) continue;
    if (!cwd) continue;
    listeners.push({ pid, command: fields[0], endpoint, cwd });
  }
  return listeners;
}

function snapshotTmpDirectories(tmpRoot = os.tmpdir()) {
  try {
    return fs
      .readdirSync(tmpRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && TMP_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => path.join(tmpRoot, entry.name))
      .sort();
  } catch (error) {
    throw new Error(`Unable to snapshot temp directories under ${tmpRoot}: ${error.message}`);
  }
}

export function captureSnapshot(root = repoRoot) {
  const processes = parseProcessSnapshot(
    outputOf("ps", ["-axo", "pid=,ppid=,command="]),
    root,
  );
  const listeners = parseListenerSnapshot(
    outputOf("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]),
    root,
  );
  return {
    processes,
    listeners,
    tmpDirectories: snapshotTmpDirectories(),
  };
}

function newItems(before, after, keyOf) {
  const existing = new Set(before.map(keyOf));
  return after.filter((item) => !existing.has(keyOf(item)));
}

export function diffSnapshots(before, after) {
  return {
    processes: newItems(before.processes, after.processes, (item) => String(item.pid)),
    listeners: newItems(
      before.listeners,
      after.listeners,
      (item) => `${item.pid}:${item.endpoint}`,
    ),
    tmpDirectories: newItems(
      before.tmpDirectories,
      after.tmpDirectories,
      (item) => item,
    ),
  };
}

export function hasDeltas(delta) {
  return delta.processes.length > 0 || delta.listeners.length > 0 || delta.tmpDirectories.length > 0;
}

export function formatCulprits(delta) {
  const lines = [];
  for (const processInfo of delta.processes) {
    lines.push(
      `process ${processInfo.kind}: pid=${processInfo.pid} ppid=${processInfo.ppid} cwd=${processInfo.cwd ?? "unknown"} command=${processInfo.command}`,
    );
  }
  for (const listener of delta.listeners) {
    lines.push(
      `listener: pid=${listener.pid} endpoint=${listener.endpoint} cwd=${listener.cwd} command=${listener.command}`,
    );
  }
  for (const directory of delta.tmpDirectories) lines.push(`tmp directory: ${directory}`);
  return lines;
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const options = { root: repoRoot, graceMs: 250, selfTest: false, command: [] };
  const optionArguments = separator === -1 ? argv : argv.slice(0, separator);
  options.command = separator === -1 ? [] : argv.slice(separator + 1);
  for (let index = 0; index < optionArguments.length; index += 1) {
    const argument = optionArguments[index];
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--root" || argument === "--grace-ms") {
      const value = optionArguments[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--root") options.root = path.resolve(value);
      else options.graceMs = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.graceMs) || options.graceMs < 0 || options.graceMs > 30_000) {
    throw new Error("--grace-ms must be an integer between 0 and 30000");
  }
  return options;
}

function runSyntheticSelfTest() {
  const parsedProcesses = parseProcessSnapshot(
    " 42 1 node /repo/kady-workflow-supervisor\n",
    repoRoot,
    () => repoRoot,
  );
  const parsedListeners = parseListenerSnapshot(
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 42 user 20u IPv4 0x0 0t0 TCP 127.0.0.1:8123 (LISTEN)\n",
    repoRoot,
    () => repoRoot,
  );
  if (parsedProcesses[0]?.pid !== 42 || parsedListeners[0]?.endpoint !== "127.0.0.1:8123") {
    throw new Error("Synthetic ps/lsof parsing did not preserve the culprit identity");
  }
  const before = {
    processes: [{ pid: 10, ppid: 1, kind: "Next.js", command: "next dev", cwd: repoRoot }],
    listeners: [{ pid: 10, command: "node", endpoint: "127.0.0.1:3000", cwd: repoRoot }],
    tmpDirectories: [path.join(os.tmpdir(), "kady-existing")],
  };
  const after = {
    processes: [
      ...before.processes,
      { pid: 42, ppid: 1, kind: "kady-workflow-supervisor", command: "kady-workflow-supervisor", cwd: repoRoot },
    ],
    listeners: [
      ...before.listeners,
      { pid: 42, command: "node", endpoint: "127.0.0.1:8123", cwd: repoRoot },
    ],
    tmpDirectories: [...before.tmpDirectories, path.join(os.tmpdir(), "kady-leaked-proof")],
  };
  const clean = diffSnapshots(before, structuredClone(before));
  if (hasDeltas(clean)) throw new Error("Synthetic clean snapshot unexpectedly reported a delta");
  const leaked = diffSnapshots(before, after);
  const culprits = formatCulprits(leaked);
  if (
    leaked.processes.length !== 1 ||
    leaked.listeners.length !== 1 ||
    leaked.tmpDirectories.length !== 1 ||
    !culprits.some((line) => line.includes("pid=42"))
  ) {
    throw new Error(`Synthetic leak was not identified correctly: ${JSON.stringify(leaked)}`);
  }
  console.log("orphan-sweep self-test: PASS (ps/lsof parsers=2; clean delta=0; synthetic process/listener/tmp culprits=3)");
  for (const culprit of culprits) console.log(`synthetic culprit: ${culprit}`);
}

async function runCommand(command, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    runSyntheticSelfTest();
    return;
  }
  if (options.command.length === 0) {
    throw new Error("Usage: orphan-sweep.mjs [--root PATH] [--grace-ms N] -- <command> [args...]");
  }

  const before = captureSnapshot(options.root);
  const result = await runCommand(options.command, process.cwd());
  if (options.graceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.graceMs));
  }
  const after = captureSnapshot(options.root);
  const delta = diffSnapshots(before, after);
  if (hasDeltas(delta)) {
    console.error("orphan-sweep: FAIL — post-command resources remain:");
    for (const culprit of formatCulprits(delta)) console.error(`- ${culprit}`);
    process.exitCode = 1;
    return;
  }
  if (result.signal) {
    console.error(`orphan-sweep: command terminated by ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  if (result.code !== 0) {
    console.error(`orphan-sweep: command exited ${result.code}`);
    process.exitCode = result.code ?? 1;
    return;
  }
  console.log("orphan-sweep: PASS (no new matching process, listener, or temp directory)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`orphan-sweep: ERROR — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
