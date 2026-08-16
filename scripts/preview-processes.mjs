import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { previewPidStartIdentity } from "./preview-state.mjs";

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

export function processesHoldingFile(file) {
  const result = spawnSync("lsof", ["-t", file], { encoding: "utf-8" });
  if (result.status !== 0 && !(result.status === 1 && !result.stderr.trim())) {
    throw new Error(
      `lsof could not inspect preview lifecycle lock ${file}: ` +
        `${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
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

export function processGroupId(pid) {
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

function validRecordedProcess(record, generation) {
  return record &&
    Number.isSafeInteger(record.pid) && record.pid > 1 &&
    Number.isSafeInteger(record.pgid) && record.pgid > 1 &&
    record.generation === generation &&
    record.identity &&
    typeof record.identity.method === "string" &&
    typeof record.identity.value === "string";
}

export function recordedPreviewProcessGroup(
  record,
  generation,
  expectedDirectory,
  {
    resolveIdentity = previewPidStartIdentity,
    isAlive = processAlive,
    workingDirectory = processWorkingDirectory,
    resolveProcessGroup = processGroupId,
  } = {},
) {
  if (!validRecordedProcess(record, generation)) {
    throw new Error(`Preview process record is invalid for generation ${generation}.`);
  }
  if (!isAlive(record.pid)) return null;
  const currentIdentity = resolveIdentity(record.pid);
  if (
    !currentIdentity ||
    currentIdentity.method !== record.identity.method ||
    currentIdentity.value !== record.identity.value
  ) {
    throw new Error(
      `Preview process PID ${record.pid} identity no longer matches generation ${generation}; refusing to signal it.`,
    );
  }
  const currentGroup = resolveProcessGroup(record.pid);
  if (currentGroup !== record.pgid) {
    throw new Error(
      `Preview process PID ${record.pid} group changed from ${record.pgid} to ${currentGroup}; refusing to signal it.`,
    );
  }
  const currentDirectory = workingDirectory(record.pid);
  if (
    currentDirectory !== expectedDirectory &&
    !currentDirectory.startsWith(`${expectedDirectory}${path.sep}`)
  ) {
    throw new Error(
      `Preview process PID ${record.pid} has unexpected cwd ${currentDirectory || "<unknown>"}; refusing to signal it.`,
    );
  }
  return { groupId: record.pgid, listeners: [], record };
}

export function collectRecordedPreviewProcessGroups(
  repositoryRoot,
  lifecycleState,
  serviceStates,
  options = {},
) {
  const groups = new Map();
  const rootGroup = recordedPreviewProcessGroup(
    lifecycleState.rootProcess,
    lifecycleState.generation,
    lifecycleState.launchRoot,
    options,
  );
  if (rootGroup) groups.set(rootGroup.groupId, rootGroup);

  for (const [role, record] of Object.entries(serviceStates)) {
    const expectedDirectory = expectedWorkingDirectory(repositoryRoot, record.role ?? role);
    const group = recordedPreviewProcessGroup(
      record,
      lifecycleState.generation,
      expectedDirectory,
      options,
    );
    if (group) groups.set(group.groupId, group);
  }
  return [...groups.values()];
}

const PORT_SERVICE_ROLES = {
  backend: "backend",
  frontend: "frontend",
  engine: "pipeline-engine",
};

export function assertPreviewServiceListenersOwned(
  ports,
  serviceStates,
  generation,
  {
    inspectPort = listenersOnPort,
    resolveProcessGroup = processGroupId,
  } = {},
) {
  for (const [portRole, port] of Object.entries(ports)) {
    const serviceRole = PORT_SERVICE_ROLES[portRole];
    const record = serviceStates[serviceRole];
    if (!validRecordedProcess(record, generation)) {
      throw new Error(
        `Preview readiness lacks a valid ${serviceRole ?? portRole} process record for generation ${generation}.`,
      );
    }
    const listenerPids = inspectPort(port);
    if (listenerPids.length === 0) {
      throw new Error(`Preview port ${port} has no listener for generation ${generation}.`);
    }
    for (const listenerPid of listenerPids) {
      if (listenerPid === record.pid) continue;
      const listenerGroup = resolveProcessGroup(listenerPid);
      if (listenerGroup !== record.pgid) {
        throw new Error(
          `Preview port ${port} held by pid ${listenerPid} not owned by generation ${generation}.`,
        );
      }
    }
  }
}

function matchingLiveRecord(record, generation, { isAlive, resolveIdentity }) {
  if (!validRecordedProcess(record, generation) || !isAlive(record.pid)) return false;
  const identity = resolveIdentity(record.pid);
  if (!identity) return false;
  return identity.method === record.identity.method && identity.value === record.identity.value;
}

export function assertPreviewGenerationQuiesced(
  records,
  generation,
  ports,
  {
    isAlive = processAlive,
    resolveIdentity = previewPidStartIdentity,
    inspectPort = listenersOnPort,
  } = {},
) {
  const survivingPids = records
    .filter((record) => matchingLiveRecord(record, generation, { isAlive, resolveIdentity }))
    .map((record) => record.pid);
  if (survivingPids.length > 0) {
    throw new Error(
      `Preview generation ${generation} process records survived teardown: ${[...new Set(survivingPids)].join(", ")}.`,
    );
  }
  const occupied = occupiedPreviewPorts(ports, inspectPort);
  if (occupied.length > 0) {
    throw new Error(
      `Preview generation ${generation} ports still have listeners: ${occupied
        .map(({ role, port, listeners }) => `${role} :${port} (${listeners.join(", ")})`)
        .join("; ")}.`,
    );
  }
}

export function assertExplicitPreviewLockRecoverySafe(
  {
    lockFile,
    lockHolderPids,
    records,
    generation,
    ports,
  },
  options = {},
) {
  if (lockHolderPids.length > 0) {
    throw new Error(
      `Explicit preview lock recovery refuses ${lockFile}; lsof reports holder PID(s) ${lockHolderPids.join(", ")}.`,
    );
  }
  if (generation) {
    const invalidRecord = records.find((record) => !validRecordedProcess(record, generation));
    if (invalidRecord) {
      throw new Error(
        `Explicit preview lock recovery cannot validate recorded PID ${invalidRecord?.pid ?? "<missing>"} for generation ${generation}.`,
      );
    }
    assertPreviewGenerationQuiesced(records, generation, ports, options);
  } else if (Object.keys(ports).length > 0) {
    const occupied = occupiedPreviewPorts(ports, options.inspectPort ?? listenersOnPort);
    if (occupied.length > 0) {
      throw new Error(
        `Explicit preview lock recovery refuses listeners without a provable generation: ${occupied
          .map(({ role, port, listeners }) => `${role} :${port} (${listeners.join(", ")})`)
          .join("; ")}.`,
      );
    }
  }
}

function mergeGenerationRecords(recordMap, serviceStates, generation) {
  for (const [role, record] of Object.entries(serviceStates)) {
    if (!validRecordedProcess(record, generation)) continue;
    const identityKey = `${record.identity.method}:${record.identity.value}`;
    recordMap.set(`${record.role ?? role}:${record.pid}:${identityKey}`, {
      ...record,
      role: record.role ?? role,
    });
  }
}

export async function quiescePreviewGeneration(
  repositoryRoot,
  lifecycleState,
  {
    readServiceSnapshot,
    stopGroups = stopProcessGroups,
    inspectPort = listenersOnPort,
    now = Date.now,
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 30_000,
    pollIntervalMs = 50,
    processOptions = {},
  },
) {
  const recordMap = new Map();
  const rootRecord = lifecycleState.rootProcess;
  const rootGroup = recordedPreviewProcessGroup(
    rootRecord,
    lifecycleState.generation,
    lifecycleState.launchRoot,
    processOptions,
  );
  if (rootGroup) await stopGroups([rootGroup], timeoutMs);
  recordMap.set(`launcher:${rootRecord.pid}`, rootRecord);

  const deadline = now() + timeoutMs;
  let previousSignature = null;
  let identicalReads = 0;
  while (now() <= deadline) {
    const snapshot = readServiceSnapshot();
    if (snapshot.status && snapshot.status !== "valid") {
      throw new Error(
        `Preview generation ${lifecycleState.generation} service state is ${snapshot.status}; refusing teardown without a complete process record.`,
      );
    }
    mergeGenerationRecords(recordMap, snapshot.services, lifecycleState.generation);
    if (snapshot.signature === previousSignature) identicalReads += 1;
    else identicalReads = 1;
    previousSignature = snapshot.signature;

    const mergedServices = Object.fromEntries(
      [...recordMap.entries()].filter(([key]) => !key.startsWith("launcher:")),
    );
    const liveGroups = collectRecordedPreviewProcessGroups(
      repositoryRoot,
      lifecycleState,
      mergedServices,
      processOptions,
    );
    await stopGroups(liveGroups);

    if (identicalReads >= 2) {
      const records = [...recordMap.values()];
      assertPreviewGenerationQuiesced(
        records,
        lifecycleState.generation,
        lifecycleState.ports,
        {
          isAlive: processOptions.isAlive ?? processAlive,
          resolveIdentity: processOptions.resolveIdentity ?? previewPidStartIdentity,
          inspectPort,
        },
      );
      return records;
    }
    await pause(pollIntervalMs);
  }
  throw new Error(
    `Preview generation ${lifecycleState.generation} service records did not settle before teardown timeout.`,
  );
}

export function assertNoForeignPreviewListeners(
  ports,
  ownedGroups,
  {
    inspectPort = listenersOnPort,
    resolveProcessGroup = processGroupId,
  } = {},
) {
  const ownedGroupIds = new Set(ownedGroups.map(({ groupId }) => groupId));
  for (const [role, port] of Object.entries(ports)) {
    for (const pid of inspectPort(port)) {
      const groupId = resolveProcessGroup(pid);
      if (!ownedGroupIds.has(groupId)) {
        throw new Error(
          `Port ${port} ${role} listener PID ${pid} belongs to foreign process group ${groupId}; refusing to signal it.`,
        );
      }
    }
  }
}

function expectedWorkingDirectory(repositoryRoot, role) {
  if (role === "backend") return fs.realpathSync(path.join(repositoryRoot, "server"));
  if (role === "frontend") return fs.realpathSync(path.join(repositoryRoot, "web"));
  return fs.realpathSync(path.join(repositoryRoot, "server", "vendor", "pipeline-engine"));
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
