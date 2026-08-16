import fs from "node:fs";

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
  try {
    const raw = fs.readFileSync(serviceStatePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (expectedGeneration && parsed?.generation !== expectedGeneration) {
      return { status: "generation-mismatch", signature: raw, services: {} };
    }
    return {
      status: "valid",
      signature: raw,
      services: parsed && typeof parsed === "object" && parsed.services && typeof parsed.services === "object"
        ? parsed.services
        : {},
    };
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "malformed",
      signature: error?.code === "ENOENT" ? "<missing>" : "<malformed>",
      services: {},
    };
  }
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
  readServiceStates = () => readPreviewServiceStates(serviceStatePath),
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
