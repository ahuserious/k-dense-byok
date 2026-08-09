import type { TrustedDagFusionCompactionAudit } from
  "../../pi-packages/dag-fusion-drive/compaction-audit.ts";
import {
  createCompactionWatcher,
  type CompactionSemanticModelRequest,
  type CompactionWatcher,
  type WatcherOperationStore,
  type WatcherRepairReceipt,
  type WatcherRepairRequest,
  type WatcherRescueProposalReceipt,
  type WatcherRescueProposalRequest,
  type WatcherRestartReceipt,
  type WatcherRestartRequest,
} from "./compaction-watcher.ts";
import type { WorkflowBehaviorRegistry } from "./behavior-registry.ts";
import {
  registerLateralPassBehavior,
  type LateralPassModelRequest,
  type OpenCleanWindowRequest,
} from "../context/lateral-pass.ts";

export type ContextEngineeringBudgetKind =
  | "compaction-audit"
  | "fix-redeploy"
  | "lateral-pass";

export interface ContextEngineeringBudgetRequest {
  kind: ContextEngineeringBudgetKind;
  model: string;
  runId: string;
}

export interface ContextEngineeringDependencies {
  registry: WorkflowBehaviorRegistry;
  runner: {
    restartWorkflow(request: WatcherRestartRequest): Promise<WatcherRestartReceipt>;
    repairAndRedeploy(request: WatcherRepairRequest): Promise<WatcherRepairReceipt>;
    proposeRescue(
      request: WatcherRescueProposalRequest,
    ): Promise<WatcherRescueProposalReceipt>;
    operationStore: WatcherOperationStore;
    readFingerprintAudit?: (
      sandboxRoot: string,
      childRunId: string,
    ) => TrustedDagFusionCompactionAudit;
  };
  sessions: {
    summarizeLateralPass(request: LateralPassModelRequest): Promise<unknown>;
    openCleanWindow(request: OpenCleanWindowRequest): Promise<{ sessionId: string }>;
  };
  models: {
    auditCompaction(request: CompactionSemanticModelRequest): Promise<unknown>;
  };
  budget: {
    admit(request: ContextEngineeringBudgetRequest): Promise<void>;
  };
  env?: NodeJS.ProcessEnv;
  watcherModel?: string;
  repairModel?: string;
  lateralPassModel?: string;
}

export interface RegisteredContextEngineering {
  watcher: CompactionWatcher;
  lateralPass: { model: string };
}

/**
 * Production composition root for S7. Consumers should register this once and
 * feed runner/session events through the returned watcher and frozen registry.
 */
export function registerContextEngineering(
  dependencies: ContextEngineeringDependencies,
): RegisteredContextEngineering {
  const watcher = createCompactionWatcher({
    registry: dependencies.registry,
    semanticModel: async (request) => {
      await dependencies.budget.admit({
        kind: "compaction-audit",
        model: request.model,
        runId: request.runId,
      });
      return dependencies.models.auditCompaction(request);
    },
    restartWorkflow: (request) => dependencies.runner.restartWorkflow(request),
    repairAndRedeploy: async (request) => {
      await dependencies.budget.admit({
        kind: "fix-redeploy",
        model: request.model,
        runId: request.runId,
      });
      return dependencies.runner.repairAndRedeploy(request);
    },
    proposeRescue: (request) => dependencies.runner.proposeRescue(request),
    operationStore: dependencies.runner.operationStore,
    ...(dependencies.runner.readFingerprintAudit
      ? {
          readFingerprintAudit: (sandboxRoot, childRunId) =>
            dependencies.runner.readFingerprintAudit!(sandboxRoot, childRunId),
        }
      : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.watcherModel ? { watcherModel: dependencies.watcherModel } : {}),
    ...(dependencies.repairModel ? { repairModel: dependencies.repairModel } : {}),
  });
  const lateralPass = registerLateralPassBehavior({
    registry: dependencies.registry,
    summarize: async (request) => {
      await dependencies.budget.admit({
        kind: "lateral-pass",
        model: request.model,
        runId: request.runId,
      });
      return dependencies.sessions.summarizeLateralPass(request);
    },
    openCleanWindow: (request) => dependencies.sessions.openCleanWindow(request),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.lateralPassModel ? { model: dependencies.lateralPassModel } : {}),
  });
  return { watcher, lateralPass };
}
