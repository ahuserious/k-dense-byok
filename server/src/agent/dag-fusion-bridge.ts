import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import {
  createDagFusionDelegationHost,
  type DagFusionDelegationHost,
  type DagFusionDelegationHostOptions,
} from "../../pi-packages/dag-fusion-drive/index.ts";

/** Vendored package root; this becomes an external Pi package at release. */
export function dagFusionPackageDir(): string {
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "dag-fusion-drive");
}

/** Direct extension entry for a dedicated loader that does not use settings. */
export function dagFusionExtensionPath(): string {
  return path.join(dagFusionPackageDir(), "index.ts");
}

export interface DagFusionWorkflowSessionBridge {
  /** Add this hidden factory to the dedicated workflow session's resource loader. */
  extension: InlineExtension;
  /** Available after `DefaultResourceLoader.reload()` has invoked the factory. */
  getHost(): DagFusionDelegationHost;
  dispose(): Promise<void>;
}

/**
 * Bind a trusted host client to the exact `pi.events` bus owned by a dedicated
 * Kady workflow session. This closure is intentionally separate from ordinary
 * chat sessions: disposing/reloading a chat must not orphan DAG-owned leaves.
 */
export function createDagFusionWorkflowSessionBridge(
  options: Omit<DagFusionDelegationHostOptions, "events"> = {},
): DagFusionWorkflowSessionBridge {
  let host: DagFusionDelegationHost | undefined;
  let disposed = false;

  const extension: InlineExtension = {
    name: "dag-fusion-drive-kady-host",
    hidden: true,
    factory: async (pi: ExtensionAPI) => {
      if (disposed) {
        throw new Error("Cannot bind a disposed dag-fusion-drive session bridge.");
      }
      await host?.dispose();
      const boundHost = createDagFusionDelegationHost({
        ...options,
        events: pi.events,
      });
      host = boundHost;
      pi.on("session_shutdown", async () => {
        await boundHost.dispose();
        if (host === boundHost) host = undefined;
      });
    },
  };

  return {
    extension,
    getHost(): DagFusionDelegationHost {
      if (disposed) {
        throw new Error("The dag-fusion-drive session bridge is disposed.");
      }
      if (!host) {
        throw new Error(
          "The dag-fusion-drive host is unavailable until its dedicated resource loader has reloaded.",
        );
      }
      return host;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const activeHost = host;
      host = undefined;
      await activeHost?.dispose();
    },
  };
}

function isDagFusionSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]dag-fusion-drive$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Fail before a workflow can dispatch provider work unless child Pi will load
 * the exact package that writes its mandatory compaction attestation.
 */
export function assertDagFusionPackageSeeded(
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): void {
  const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (error) {
    throw new Error(
      "DAG workflow child settings are missing or malformed; dag-fusion-drive cannot be verified.",
      { cause: error },
    );
  }
  if (
    !isSettingsRecord(settings) ||
    !Array.isArray(settings.packages) ||
    !settings.packages.includes(dagFusionPackageDir())
  ) {
    throw new Error(
      "DAG workflow child settings do not contain the canonical dag-fusion-drive package.",
    );
  }
  if (new ProjectTrustStore(agentDir).get(paths.sandbox) !== true) {
    throw new Error(
      "DAG workflow child project resources are not trusted, so compaction auditing cannot load.",
    );
  }
}

/**
 * Make the package's skills available to the lead Kady session and child Pi
 * agents. Malformed user settings are left untouched rather than overwritten.
 */
export function seedDagFusionPackage(paths: ProjectPaths): boolean {
  const piDir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(piDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (!isSettingsRecord(parsed)) return false;
    settings = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const packageDir = dagFusionPackageDir();
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const kept = packages.filter(
    (entry) => !isDagFusionSource(entry) || entry === packageDir,
  );
  if (kept.includes(packageDir) && kept.length === packages.length) return false;
  if (!kept.includes(packageDir)) kept.push(packageDir);
  settings.packages = kept;
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}
