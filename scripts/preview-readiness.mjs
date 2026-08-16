import fs from "node:fs";

import { collectRecordedPreviewProcessGroups } from "./preview-processes.mjs";

// The launcher spawns and owns exactly these three roles, so it is also the
// process that records their exits. The workflow supervisor is spawned by the
// backend and only reported to the launcher over IPC: the launcher never
// observes its exit, so its record stays "spawned" forever and readiness must
// not require it to be live. Teardown keeps every recorded role, owned or not.
export const LAUNCHER_OWNED_PREVIEW_ROLES = ["backend", "frontend", "pipeline-engine"];

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function probePreviewService(service, fetchImplementation = fetch) {
  try {
    const response = await fetchImplementation(service.url, {
      signal: AbortSignal.timeout(service.probeTimeoutMs ?? 2_000),
    });
    if (response.ok) {
      if (service.expectedGeneration) {
        let payload;
        try {
          payload = JSON.parse(await response.text());
        } catch {
          return { ok: false, detail: `HTTP ${response.status}: invalid generation body` };
        }
        if (payload?.generation !== service.expectedGeneration) {
          return {
            ok: false,
            detail: `HTTP ${response.status}: generation ${payload?.generation ?? "missing"} does not match ${service.expectedGeneration}`,
          };
        }
      }
      return { ok: true, detail: `HTTP ${response.status}` };
    }
    let responseDetail = "";
    try {
      responseDetail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1_000);
    } catch {
      // The status alone remains useful when an unhealthy service has no readable body.
    }
    return {
      ok: false,
      detail: `HTTP ${response.status}${responseDetail ? `: ${responseDetail}` : ""}`,
    };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}

export function readPreviewServiceStates(serviceStatePath, expectedGeneration) {
  return readPreviewServiceStateSnapshot(serviceStatePath, expectedGeneration).services;
}

export function readPreviewServiceStateSnapshot(serviceStatePath, expectedGeneration) {
  let raw;
  try {
    raw = fs.readFileSync(serviceStatePath, "utf-8");
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unreadable",
      signature: error?.code === "ENOENT" ? "<missing>" : `<unreadable:${error?.code ?? "unknown"}>`,
      services: {},
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (expectedGeneration && parsed?.generation !== expectedGeneration) {
      return { status: "generation-mismatch", signature: raw, services: {} };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !parsed.services || typeof parsed.services !== "object" || Array.isArray(parsed.services)) {
      return { status: "invalid", signature: raw, services: {} };
    }
    return {
      status: "valid",
      signature: raw,
      services: parsed.services,
    };
  } catch {
    return {
      status: "malformed",
      signature: "<malformed>",
      services: {},
    };
  }
}

export function assertPreviewReadinessProcessesLive(
  repositoryRoot,
  lifecycleState,
  serviceStates,
  processOptions = {},
) {
  // Every recorded role is still resolved here: an identity-, group- or
  // cwd-mismatched record refuses readiness exactly as it refuses teardown.
  const liveGroups = collectRecordedPreviewProcessGroups(
    repositoryRoot,
    lifecycleState,
    serviceStates,
    processOptions,
  );
  const livePids = new Set(liveGroups.map(({ record }) => record.pid));
  const ownedRecords = [
    lifecycleState.rootProcess,
    ...LAUNCHER_OWNED_PREVIEW_ROLES
      .map((role) => serviceStates[role])
      .filter(Boolean),
  ];
  for (const record of ownedRecords) {
    if (!livePids.has(record.pid)) {
      throw new Error(
        `Preview readiness process PID ${record.pid} is no longer live for generation ${lifecycleState.generation}.`,
      );
    }
  }
  return liveGroups;
}

export function previewLogExcerpt(logPath, maximumLines = 30) {
  try {
    return fs.readFileSync(logPath, "utf-8").trimEnd().split("\n").slice(-maximumLines).join("\n");
  } catch {
    return "<preview log unavailable>";
  }
}

function launcherDescription(launcherProcess) {
  if (!launcherProcess) return "launcher status unavailable";
  if (launcherProcess.exitCode === null && launcherProcess.signalCode === null) {
    return `launcher PID ${launcherProcess.pid} still running`;
  }
  return `launcher PID ${launcherProcess.pid} exited with code ${launcherProcess.exitCode ?? "null"} and signal ${launcherProcess.signalCode ?? "none"}`;
}

function serviceExitDescription(service, processState, lastProbe, launcherProcess, logExcerpt) {
  return [
    `${service.label} service process PID ${processState.pid} exited before all preview services became healthy`,
    `(exit code ${processState.exitCode ?? "null"}, signal ${processState.signal ?? "none"}; last probe: ${lastProbe}; ${launcherDescription(launcherProcess)}).`,
    "Preview log tail:",
    logExcerpt,
  ].join("\n");
}

function timeoutDescription(service, elapsedMs, lastProbe, launcherProcess, logExcerpt) {
  return [
    `${service.label} health timed out after ${elapsedMs}ms (last probe: ${lastProbe}; ${launcherDescription(launcherProcess)}).`,
    "Preview log tail:",
    logExcerpt,
  ].join("\n");
}

export async function waitForPreviewReadiness({
  services,
  launcherProcess,
  serviceStatePath,
  logPath,
  probe = probePreviewService,
  readServiceStates = (generation) => readPreviewServiceStates(serviceStatePath, generation),
  readLogExcerpt = () => previewLogExcerpt(logPath),
  now = Date.now,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 500,
  expectedGeneration,
  validateReady = () => {},
}) {
  const startedAt = now();
  const lastProbeByRole = new Map(services.map((service) => [service.role, "not ready"]));

  while (true) {
    // Probe every endpoint in every pass. Readiness is declared only when all
    // three return success in the same convergence pass.
    const probeResults = await Promise.all(
      services.map(async (service) => [service, await probe(service)]),
    );
    for (const [service, result] of probeResults) {
      lastProbeByRole.set(service.role, result.detail);
    }
    const serviceStates = readServiceStates(expectedGeneration);
    let processBindingPending = false;
    if (probeResults.every(([, result]) => result.ok)) {
      try {
        validateReady(serviceStates);
        return probeResults;
      } catch (error) {
        processBindingPending = true;
        for (const [service] of probeResults) {
          lastProbeByRole.set(
            service.role,
            `process binding pending: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const currentTime = now();
    for (const [service, result] of probeResults) {
      if (result.ok && !processBindingPending) continue;
      const processState = serviceStates[service.role];
      if (processState?.state === "exited") {
        throw new Error(
          serviceExitDescription(
            service,
            processState,
            lastProbeByRole.get(service.role),
            launcherProcess,
            readLogExcerpt(),
          ),
        );
      }
      const elapsedMs = currentTime - startedAt;
      if (elapsedMs >= service.timeoutMs) {
        throw new Error(
          timeoutDescription(
            service,
            elapsedMs,
            lastProbeByRole.get(service.role),
            launcherProcess,
            readLogExcerpt(),
          ),
        );
      }
    }
    await pause(pollIntervalMs);
  }
}
