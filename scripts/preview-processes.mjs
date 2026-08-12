import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function processGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function processWorkingDirectory(pid) {
  const output = commandOutput("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return output
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) ?? "";
}

export function listenersOnPort(port) {
  const result = spawnSync("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ], { encoding: "utf-8" });
  if (result.status !== 0 && !(result.status === 1 && !result.stderr.trim())) {
    throw new Error(
      `lsof could not inspect preview port ${port}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  const output = result.stdout.trim();
  return [...new Set(output.split(/\s+/).filter(Boolean).map(Number))].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 1,
  );
}

export function occupiedPreviewPorts(ports, inspectPort = listenersOnPort) {
  return Object.entries(ports).flatMap(([role, port]) => {
    const listeners = inspectPort(port);
    return listeners.length > 0 ? [{ role, port, listeners }] : [];
  });
}

export async function waitForPreviewPortsFree(
  ports,
  timeoutMs,
  {
    inspectPort = listenersOnPort,
    now = Date.now,
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollIntervalMs = 100,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let occupied = occupiedPreviewPorts(ports, inspectPort);
  while (occupied.length > 0 && now() < deadline) {
    await pause(pollIntervalMs);
    occupied = occupiedPreviewPorts(ports, inspectPort);
  }
  return occupied;
}

function processGroupId(pid) {
  const psOutput = commandOutput("ps", ["-o", "pgid=", "-p", String(pid)]);
  if (/^\d+$/.test(psOutput)) return Number(psOutput);

  // Some managed macOS runners deny ps/pgrep while still permitting signals.
  const pythonOutput = commandOutput("python3", [
    "-c",
    "import os, sys; print(os.getpgid(int(sys.argv[1])))",
    String(pid),
  ]);
  if (/^\d+$/.test(pythonOutput)) return Number(pythonOutput);
  throw new Error(`Could not resolve process group for listener PID ${pid}.`);
}

function expectedWorkingDirectory(repositoryRoot, role) {
  if (role === "backend") return fs.realpathSync(path.join(repositoryRoot, "server"));
  if (role === "frontend") return fs.realpathSync(path.join(repositoryRoot, "web"));
  return fs.realpathSync(path.join(repositoryRoot, "server", "vendor", "pipeline-engine"));
}

export function collectPreviewListenerGroups(repositoryRoot, ports) {
  const groups = new Map();
  for (const [role, port] of Object.entries(ports)) {
    const expectedDirectory = expectedWorkingDirectory(repositoryRoot, role);
    for (const pid of listenersOnPort(port)) {
      const workingDirectory = processWorkingDirectory(pid);
      if (
        workingDirectory !== expectedDirectory &&
        !workingDirectory.startsWith(`${expectedDirectory}${path.sep}`)
      ) {
        throw new Error(
          `Port ${port} listener PID ${pid} has unexpected cwd ${workingDirectory || "<unknown>"}; refusing to signal it.`,
        );
      }
      const groupId = processGroupId(pid);
      if (groupId <= 1) {
        throw new Error(`Listener PID ${pid} resolved to unsafe process group ${groupId}.`);
      }
      const group = groups.get(groupId) ?? { groupId, listeners: [] };
      group.listeners.push({ pid, port, role });
      groups.set(groupId, group);
    }
  }
  return [...groups.values()];
}

export async function waitForProcessGroups(groups, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groups.some(({ groupId }) => processGroupAlive(groupId)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return groups.filter(({ groupId }) => processGroupAlive(groupId));
}

export async function stopProcessGroups(groups, timeoutMs = 10_000) {
  const liveGroups = groups.filter(({ groupId }) => processGroupAlive(groupId));
  for (const { groupId } of liveGroups) process.kill(-groupId, "SIGTERM");
  const stubbornGroups = await waitForProcessGroups(liveGroups, timeoutMs);
  for (const { groupId } of stubbornGroups) process.kill(-groupId, "SIGKILL");
  return waitForProcessGroups(stubbornGroups, 5_000);
}
