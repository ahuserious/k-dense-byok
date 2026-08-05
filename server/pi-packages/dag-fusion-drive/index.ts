import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDagFusionCompactionAudit } from "./compaction-audit.ts";

export * from "./compaction-audit.ts";
export * from "./delegation-host.ts";
export * from "./runtime-contract.ts";

export const DAG_FUSION_DRIVE_RUNTIME_VERSION = 1 as const;
export const DAG_FUSION_DRIVE_READY_EVENT = "dag-fusion-drive:runtime:ready";
export const DAG_FUSION_DRIVE_STOPPED_EVENT = "dag-fusion-drive:runtime:stopped";

/**
 * Package entrypoint. It exposes no model-facing tool and starts no delegated
 * work on its own: a trusted workflow host imports the owned Delegation V2
 * client and supplies the shared `pi.events` bus. In a pi-subagents child it
 * also records bounded compaction attestations for the trusted Kady reader.
 */
export default function dagFusionDriveExtension(pi: ExtensionAPI): void {
  installDagFusionCompactionAudit(pi);
  const capability = Object.freeze({
    runtimeVersion: DAG_FUSION_DRIVE_RUNTIME_VERSION,
    delegationProtocolVersion: 2 as const,
  });
  pi.events.emit(DAG_FUSION_DRIVE_READY_EVENT, capability);
  pi.on("session_shutdown", () => {
    pi.events.emit(DAG_FUSION_DRIVE_STOPPED_EVENT, capability);
  });
}
