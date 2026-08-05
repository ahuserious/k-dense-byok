import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { seedAgentFiles } from "./agent-files.ts";
import {
  assertDagFusionPackageSeeded,
  createDagFusionWorkflowSessionBridge,
  dagFusionExtensionPath,
  seedDagFusionPackage,
} from "./dag-fusion-bridge.ts";
import type {
  DagFusionDelegationHost,
  DagFusionDelegationHostSnapshot,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import { defaultModel } from "./models.ts";
import {
  getModelRegistry,
  getModelRuntime,
} from "./session-registry.ts";
import { subagentsExtensionPath } from "./subagent-bridge.ts";
import { ensureWebAccess } from "./web-access-bridge.ts";

export interface WorkflowDelegationSession {
  readonly projectId: string;
  /** In-memory Pi session used only to own extension runtime state. */
  readonly session: AgentSession;
  /** Trusted host API; prompts never receive this object as a tool. */
  readonly host: DagFusionDelegationHost;
  readonly disposed: boolean;
  snapshot(): WorkflowDelegationSessionSnapshot;
  dispose(options?: DisposeWorkflowDelegationSessionOptions): Promise<void>;
}

export interface WorkflowDelegationSessionSnapshot {
  projectId: string;
  disposed: boolean;
  host: DagFusionDelegationHostSnapshot;
}

export interface DisposeWorkflowDelegationSessionOptions {
  /** Project deletion uses this non-blocking guard to preserve an owned Pi session. */
  rejectIfOwnedLeaves?: boolean;
}

interface LiveWorkflowDelegationSession extends WorkflowDelegationSession {
  readonly disposed: boolean;
}

const liveSessions = new Map<string, Promise<LiveWorkflowDelegationSession>>();
const closingSessions = new Map<string, Promise<void>>();

function assertProjectIdentity(projectId: string, paths: ProjectPaths): void {
  if (projectId !== paths.id) {
    throw new Error(
      `Workflow delegation project ${projectId} does not match paths for ${paths.id}.`,
    );
  }
}

async function buildWorkflowDelegationSession(
  projectId: string,
  paths: ProjectPaths,
  removeFromRegistry: () => void,
): Promise<LiveWorkflowDelegationSession> {
  assertProjectIdentity(projectId, paths);

  // Child Pi processes discover their project-scoped specialist roster and
  // package resources from the sandbox. These seeders are idempotent and do
  // not make the host session an ordinary persistent chat.
  seedAgentFiles(paths);
  ensureWebAccess(paths);
  seedDagFusionPackage(paths);
  assertDagFusionPackageSeeded(paths);

  const bridge = createDagFusionWorkflowSessionBridge();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.sandbox,
    agentDir: getAgentDir(),
    settingsManager,
    // Load only the two public runtime entries needed by the trusted host.
    // Project packages remain available to the child Pi processes through the
    // seeded settings file, but unrelated parent extensions are not admitted.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      subagentsExtensionPath(),
      dagFusionExtensionPath(),
    ],
    extensionFactories: [bridge.extension],
  });

  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: paths.sandbox,
      agentDir: getAgentDir(),
      model: defaultModel(getModelRegistry()),
      modelRuntime: getModelRuntime(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(paths.sandbox),
      settingsManager,
      // This session exists to give pi-subagents a live extension context and
      // event bus. It is never prompted and exposes no model-facing tools.
      noTools: "all",
      tools: [],
    });
    session = created.session;
    const host = bridge.getHost();
    let disposed = false;
    let disposal: Promise<void> | undefined;

    return {
      projectId,
      session,
      host,
      get disposed(): boolean {
        return disposed;
      },
      snapshot(): WorkflowDelegationSessionSnapshot {
        return {
          projectId,
          disposed,
          host: host.snapshot(),
        };
      },
      dispose(options: DisposeWorkflowDelegationSessionOptions = {}): Promise<void> {
        if (disposal) return disposal;
        const hostSnapshot = host.snapshot();
        if (options.rejectIfOwnedLeaves && hostSnapshot.pending.length > 0) {
          const quarantined = hostSnapshot.quarantined.length;
          return Promise.reject(
            new Error(
              quarantined > 0
                ? `Project ${projectId} has ${quarantined} quarantined DAG child execution(s); deletion is blocked until exact terminal acknowledgement.`
                : `Project ${projectId} still owns ${hostSnapshot.pending.length} DAG child execution(s); deletion is blocked until they settle.`,
            ),
          );
        }
        disposed = true;

        let closing!: Promise<void>;
        closing = (async () => {
          // Stop owned leaves before tearing down the event bus they use for
          // cancellation and terminal usage reconciliation.
          try {
            await bridge.dispose();
          } finally {
            session?.clearQueue();
            try {
              if (session && !session.isIdle) await session.abort();
            } finally {
              session?.dispose();
            }
          }
        })().finally(() => {
          // Keep the disposed-but-closing session discoverable for diagnostics
          // while the host waits for a quarantined tuple's exact terminal
          // acknowledgement. `getOrCreate` still waits on `closingSessions`, so
          // retaining this registry entry cannot reopen or reuse the session.
          removeFromRegistry();
          if (closingSessions.get(projectId) === closing) {
            closingSessions.delete(projectId);
          }
        });
        disposal = closing;
        closingSessions.set(projectId, closing);
        return closing;
      },
    };
  } catch (error) {
    try {
      await bridge.dispose();
    } finally {
      session?.dispose();
    }
    throw error;
  }
}

/**
 * Return the one process-local workflow extension session for a project.
 * Concurrent callers share the same construction promise and host.
 */
export function getOrCreateWorkflowDelegationSession(
  projectId: string,
  paths: ProjectPaths,
): Promise<WorkflowDelegationSession> {
  try {
    assertProjectIdentity(projectId, paths);
  } catch (error) {
    return Promise.reject(error);
  }
  const closing = closingSessions.get(projectId);
  if (closing) {
    return closing.then(
      () => getOrCreateWorkflowDelegationSession(projectId, paths),
      () => getOrCreateWorkflowDelegationSession(projectId, paths),
    );
  }
  const existing = liveSessions.get(projectId);
  if (existing) return existing;

  let creation!: Promise<LiveWorkflowDelegationSession>;
  creation = buildWorkflowDelegationSession(projectId, paths, () => {
    if (liveSessions.get(projectId) === creation) liveSessions.delete(projectId);
  }).catch((error) => {
    if (liveSessions.get(projectId) === creation) liveSessions.delete(projectId);
    throw error;
  });
  liveSessions.set(projectId, creation);
  return creation;
}

/** Dispose the dedicated host for one project, including an in-flight build. */
export async function disposeWorkflowDelegationSession(
  projectId: string,
  options: DisposeWorkflowDelegationSessionOptions = {},
): Promise<void> {
  const pending = liveSessions.get(projectId);
  if (pending) {
    const session = await pending;
    await session.dispose(options);
    return;
  }
  await closingSessions.get(projectId);
}

/** Read-only process-local diagnostics for project deletion and operators. */
export async function workflowDelegationSessionSnapshot(
  projectId: string,
): Promise<WorkflowDelegationSessionSnapshot | undefined> {
  const pending = liveSessions.get(projectId);
  if (!pending) return undefined;
  return (await pending).snapshot();
}

/** Deterministic process-shutdown hook for all dedicated workflow sessions. */
export async function disposeAllWorkflowDelegationSessions(): Promise<void> {
  const pending = [...liveSessions.values()];
  await Promise.allSettled(
    pending.map(async (entry) => {
      const session = await entry;
      await session.dispose();
    }),
  );
  await Promise.allSettled([...closingSessions.values()]);
}

/** Test/diagnostic snapshot; does not expose mutable registry state. */
export function workflowDelegationSessionCount(): number {
  return liveSessions.size;
}
