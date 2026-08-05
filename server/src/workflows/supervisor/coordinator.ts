import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProjectPaths } from "../../projects.ts";
import { resolvePaths } from "../../projects.ts";
import {
  disposeAllWorkflowDelegationSessions,
  disposeWorkflowDelegationSession,
  getOrCreateWorkflowDelegationSession,
  workflowDelegationSessionSnapshot,
  type WorkflowDelegationSession,
} from "../../agent/workflow-delegation-session.ts";
import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageLimits,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationV2Request,
} from "../../../pi-packages/dag-fusion-drive/index.ts";
import {
  assertNoHostedFusionQuarantine,
  hostedFusionQuarantineSnapshot,
  runHostedOpenRouterFusion,
  waitForHostedFusionQuarantines,
  type HostedOpenRouterFusionResult,
} from "../hosted-fusion.ts";
import type {
  SerializedHostedOpenRouterFusionRequest,
  WorkflowSupervisorAttemptSnapshot,
  WorkflowSupervisorSnapshot,
  WorkflowSupervisorState,
} from "./protocol.ts";
import {
  WorkflowSupervisorJournal,
  type WorkflowSupervisorRecordV1,
} from "./journal.ts";
import {
  workflowSupervisorDigest,
  workflowSupervisorMachineCode,
  workflowSupervisorOperationId,
  workflowSupervisorSettlementStatus,
  workflowSupervisorTerminalOutcome,
} from "./integrity.ts";
import {
  parseSupervisedWorkflowBudgetDescriptor,
  settleWorkflowBudgetInputForDagFusion,
  type SupervisedWorkflowBudgetDescriptorV1,
} from "../supervised-budget.ts";
import {
  workflowBudgetReservationId,
  workflowBudgetStore,
  type WorkflowBudgetReservationV1,
} from "../budget.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
} from "../../cost/billing.ts";
import { reloadWorkflowSupervisorCredentials } from "./credentials.ts";
import type { WorkflowSupervisorCredentialKey } from "./credential-contract.ts";

export type WorkflowSupervisorCoordinatorErrorCode =
  | "NOT_ATTACHED"
  | "STALE_EPOCH"
  | "SUPERVISOR_BUSY"
  | "PROJECT_QUIESCING"
  | "SHUTTING_DOWN"
  | "OPERATION_FAILED";

export class WorkflowSupervisorCoordinatorError extends Error {
  constructor(
    readonly code: WorkflowSupervisorCoordinatorErrorCode,
    message: string,
    readonly settlement?: DagFusionDelegationUsageSettlement,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowSupervisorCoordinatorError";
  }
}

export interface WorkflowSupervisorDelegateResult {
  receipt: DagFusionDelegationReceipt;
  settlement: DagFusionDelegationUsageSettlement;
}

export interface WorkflowSupervisorHostedResult {
  result: HostedOpenRouterFusionResult;
  settlement: DagFusionDelegationUsageSettlement;
}

export interface WorkflowSupervisorCoordinatorDependencies {
  pathsForProject(projectId: string): ProjectPaths;
  getDelegationSession(
    projectId: string,
    paths: ProjectPaths,
  ): Promise<WorkflowDelegationSession>;
  disposeDelegationSession(
    projectId: string,
    options?: { rejectIfOwnedLeaves?: boolean },
  ): Promise<void>;
  delegationSessionSnapshot(
    projectId: string,
  ): Promise<ReturnType<WorkflowDelegationSession["snapshot"]> | undefined>;
  disposeAllDelegationSessions(): Promise<void>;
  runHostedFusion(
    request: Parameters<typeof runHostedOpenRouterFusion>[0],
  ): Promise<HostedOpenRouterFusionResult>;
  hostedQuarantines(projectId?: string): ReturnType<typeof hostedFusionQuarantineSnapshot>;
  waitHostedQuarantines(): Promise<void>;
  assertNoHostedQuarantine(projectId?: string): void;
  settleBudget(
    projectId: string,
    descriptor: SupervisedWorkflowBudgetDescriptorV1,
    settlement: DagFusionDelegationUsageSettlement,
  ): Promise<void>;
  budgetReservation(
    projectId: string,
    reservationId: string,
  ): Pick<
    WorkflowBudgetReservationV1,
    | "id"
    | "projectId"
    | "runId"
    | "status"
    | "expiresAt"
    | "maxCostUsd"
    | "maxTokens"
    | "modelCallCount"
  > | undefined;
  reloadCredentials(keys: readonly WorkflowSupervisorCredentialKey[]): Promise<void>;
  now(): number;
}

export interface WorkflowSupervisorCoordinatorOptions {
  journal: WorkflowSupervisorJournal;
  instanceId?: string;
  dependencies?: Partial<WorkflowSupervisorCoordinatorDependencies>;
}

interface ActiveAttempt {
  operationId: string;
  messageId: string;
  projectId: string;
  backendEpoch: number;
  kind: "delegate" | "hosted-fusion";
  identity: DagFusionDelegationIdentity;
  state: WorkflowSupervisorAttemptSnapshot["state"];
  startedAt: number;
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
}

const defaultDependencies: WorkflowSupervisorCoordinatorDependencies = {
  pathsForProject: resolvePaths,
  getDelegationSession: getOrCreateWorkflowDelegationSession,
  disposeDelegationSession: disposeWorkflowDelegationSession,
  delegationSessionSnapshot: workflowDelegationSessionSnapshot,
  disposeAllDelegationSessions: disposeAllWorkflowDelegationSessions,
  runHostedFusion: runHostedOpenRouterFusion,
  hostedQuarantines: hostedFusionQuarantineSnapshot,
  waitHostedQuarantines: waitForHostedFusionQuarantines,
  assertNoHostedQuarantine: assertNoHostedFusionQuarantine,
  settleBudget: async (projectId, descriptor, settlement) => {
    await workflowBudgetStore.settle(
      projectId,
      descriptor.reservationId,
      settleWorkflowBudgetInputForDagFusion(descriptor, settlement),
    );
  },
  budgetReservation: (projectId, reservationId) =>
    workflowBudgetStore.list(projectId).find((record) => record.id === reservationId),
  reloadCredentials: reloadWorkflowSupervisorCredentials,
  now: Date.now,
};

function sameIdentity(
  left: DagFusionDelegationIdentity,
  right: DagFusionDelegationIdentity,
): boolean {
  return isDeepStrictEqual(left, right);
}

function isQuarantinedRecord(record: WorkflowSupervisorRecordV1): boolean {
  return record.state === "quarantined";
}

function coordinatorError(
  code: WorkflowSupervisorCoordinatorErrorCode,
  message: string,
  settlement?: DagFusionDelegationUsageSettlement,
  cause?: unknown,
): never {
  throw new WorkflowSupervisorCoordinatorError(
    code,
    message,
    settlement,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string {
  return workflowSupervisorMachineCode(error);
}

/**
 * Owns live Pi/Fusion work independently of Fastify. Durable graph state stays
 * in Kady's existing workflow store; this coordinator only guards the unsafe
 * interval between provider dispatch and a positive terminal acknowledgement.
 */
export class WorkflowSupervisorCoordinator {
  readonly journal: WorkflowSupervisorJournal;
  readonly instanceId: string;
  private readonly dependencies: WorkflowSupervisorCoordinatorDependencies;
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly runtimeQuarantines = new Map<string, ActiveAttempt>();
  private readonly quiescingProjects = new Set<string>();
  private attachedEpoch: number | null = null;
  private controlAttached = false;
  private shuttingDown = false;
  private configuring = false;
  private configurationReady = true;
  private attachChain: Promise<void> = Promise.resolve();

  constructor(options: WorkflowSupervisorCoordinatorOptions) {
    this.journal = options.journal;
    this.instanceId = options.instanceId ?? `supervisor-${crypto.randomUUID()}`;
    this.dependencies = { ...defaultDependencies, ...options.dependencies };
    this.journal.recoverStartup();
  }

  private state(): WorkflowSupervisorState {
    if (this.shuttingDown) return "shutting-down";
    if (this.configuring || !this.configurationReady) return "quiescing";
    if (this.quiescingProjects.size > 0) return "quiescing";
    return "ready";
  }

  private quarantineRecords(projectId?: string): WorkflowSupervisorRecordV1[] {
    return this.journal.list().filter(
      (record) => isQuarantinedRecord(record) &&
        (projectId === undefined || record.projectId === projectId),
    );
  }

  private assertNoUncertainOwnership(projectId?: string): void {
    const durable = this.quarantineRecords(projectId);
    const inMemory = [...this.runtimeQuarantines.values()].filter(
      (attempt) => projectId === undefined || attempt.projectId === projectId,
    );
    const hosted = this.dependencies.hostedQuarantines(projectId);
    if (durable.length > 0 || inMemory.length > 0 || hosted.length > 0) {
      coordinatorError(
        "SUPERVISOR_BUSY",
        "Workflow supervisor ownership is quarantined until exact terminal evidence is available.",
      );
    }
  }

  private requireEpoch(epoch: number): void {
    if (!this.controlAttached || this.attachedEpoch === null) {
      coordinatorError("NOT_ATTACHED", "No backend epoch is attached to the workflow supervisor.");
    }
    if (this.attachedEpoch !== epoch) {
      coordinatorError("STALE_EPOCH", "The workflow supervisor request used a stale backend epoch.");
    }
    if (this.shuttingDown) {
      coordinatorError("SHUTTING_DOWN", "The workflow supervisor is shutting down.");
    }
  }

  private attemptsForEpoch(epoch: number): ActiveAttempt[] {
    return [...this.active.values()].filter((attempt) => attempt.backendEpoch === epoch);
  }

  private async drainAttempts(
    attempts: ActiveAttempt[],
    projectId?: string,
  ): Promise<void> {
    await Promise.all(attempts.map((attempt) => attempt.done));
    this.assertNoUncertainOwnership(projectId);
  }

  async attach(epoch: number): Promise<void> {
    const previous = this.attachChain;
    let release!: () => void;
    this.attachChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.shuttingDown) {
        coordinatorError("SHUTTING_DOWN", "The workflow supervisor is shutting down.");
      }
      if (this.controlAttached) {
        coordinatorError(
          "SUPERVISOR_BUSY",
          "Another backend still owns the workflow supervisor control connection.",
        );
      }
      const previousEpoch = this.attachedEpoch;
      if (previousEpoch !== null) {
        const stale = this.attemptsForEpoch(previousEpoch);
        for (const attempt of stale) {
          attempt.state = "cancelling";
          attempt.controller.abort(new Error("The owning backend disconnected."));
        }
        await this.drainAttempts(stale);
      }
      this.assertNoUncertainOwnership();
      this.attachedEpoch = epoch;
      this.controlAttached = true;
    } finally {
      release();
    }
  }

  detach(epoch: number): void {
    if (!this.controlAttached || this.attachedEpoch !== epoch) return;
    this.controlAttached = false;
    for (const attempt of this.attemptsForEpoch(epoch)) {
      attempt.state = "cancelling";
      attempt.controller.abort(new Error("The owning backend disconnected."));
    }
  }

  /** Abort only the attempt owned by one disconnected operation socket. */
  cancelMessage(epoch: number, messageId: string): boolean {
    this.requireEpoch(epoch);
    const attempt = [...this.active.values()].find(
      (candidate) =>
        candidate.backendEpoch === epoch && candidate.messageId === messageId,
    );
    if (!attempt) return false;
    attempt.state = "cancelling";
    attempt.controller.abort(new Error("The workflow supervisor caller disconnected."));
    return true;
  }

  private beginAttempt(input: {
    operationId: string;
    messageId: string;
    projectId: string;
    backendEpoch: number;
    kind: ActiveAttempt["kind"];
    identity: DagFusionDelegationIdentity;
    budget: SupervisedWorkflowBudgetDescriptorV1;
    requestDigest: string;
  }): ActiveAttempt {
    this.requireEpoch(input.backendEpoch);
    if (this.configuring || !this.configurationReady) {
      coordinatorError(
        "SUPERVISOR_BUSY",
        "Workflow supervisor credentials are not ready for new provider work.",
      );
    }
    this.assertNoUncertainOwnership(input.projectId);
    if (this.quiescingProjects.has(input.projectId)) {
      coordinatorError(
        "PROJECT_QUIESCING",
        `Workflow project ${input.projectId} is quiescing.`,
      );
    }
    if (this.active.has(input.operationId)) {
      coordinatorError("SUPERVISOR_BUSY", "The same workflow attempt is already active.");
    }
    const existing = this.journal.snapshot(input.operationId);
    const prepared = this.journal.prepare({
      operationId: input.operationId,
      requestDigest: input.requestDigest,
      kind: input.kind === "delegate" ? "pi-subagent" : "hosted-fusion",
      projectId: input.projectId,
      backendEpoch: String(input.backendEpoch),
      ownerRunId: input.identity.ownerRunId,
      nodeId: input.identity.nodeId,
      executionId: input.budget.executionId,
      slotId: input.budget.slotId,
      reservationId: input.budget.reservationId,
    });
    if (existing || prepared.state !== "prepared") {
      coordinatorError(
        "OPERATION_FAILED",
        "The workflow attempt identity was already consumed by an earlier dispatch.",
      );
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const attempt: ActiveAttempt = {
      operationId: input.operationId,
      messageId: input.messageId,
      projectId: input.projectId,
      backendEpoch: input.backendEpoch,
      kind: input.kind,
      identity: structuredClone(input.identity),
      state: "running",
      startedAt: this.dependencies.now(),
      controller: new AbortController(),
      done,
      finish,
    };
    this.active.set(input.operationId, attempt);
    try {
      this.journal.markRunning(input.operationId, {
        ownerId: this.instanceId,
        pid: process.pid,
        processInstanceId: this.instanceId,
      });
    } catch (error) {
      this.active.delete(input.operationId);
      attempt.finish();
      try {
        this.journal.markTerminal(input.operationId, {
          outcome: "unstarted",
          code: "DISPATCH_NOT_STARTED",
        });
      } catch {
        // A prepared record is recovered as unstarted; never dispatch after a
        // failed running transition.
      }
      coordinatorError(
        "OPERATION_FAILED",
        "The workflow supervisor could not durably claim the attempt.",
        undefined,
        error,
      );
    }
    return attempt;
  }

  private retainQuarantine(attempt: ActiveAttempt, reasonCode: string, cause: unknown): never {
    attempt.state = "quarantined";
    this.runtimeQuarantines.set(attempt.operationId, attempt);
    try {
      this.journal.quarantine(attempt.operationId, { reasonCode });
    } catch {
      // The in-memory quarantine remains authoritative for this supervisor
      // process even when its durable transition itself failed.
    }
    coordinatorError(
      "SUPERVISOR_BUSY",
      "Workflow attempt ownership could not be proven terminal and remains quarantined.",
      undefined,
      cause,
    );
  }

  private finishAttempt(attempt: ActiveAttempt): void {
    // `done` tracks completion of the public operation promise, not proof of
    // provider termination. Quarantine ownership remains visible separately;
    // resolving here lets a concurrent drain reject on that quarantine instead
    // of waiting forever on an operation that already returned its refusal.
    this.active.delete(attempt.operationId);
    attempt.finish();
  }

  private normalizeSettlement(
    expectedIdentity: DagFusionDelegationIdentity,
    current: DagFusionDelegationUsageSettlement | undefined,
    settlement: DagFusionDelegationUsageSettlement,
  ): DagFusionDelegationUsageSettlement {
    if (!sameIdentity(settlement.identity, expectedIdentity)) {
      throw new Error("Workflow supervisor settlement identity did not match its attempt.");
    }
    if (current) {
      if (!isDeepStrictEqual(current, settlement)) {
        throw new Error("Workflow supervisor received conflicting terminal settlements.");
      }
      return current;
    }
    return structuredClone(settlement);
  }

  private async persistSettlement(
    attempt: ActiveAttempt,
    projectId: string,
    budget: SupervisedWorkflowBudgetDescriptorV1,
    settlement: DagFusionDelegationUsageSettlement,
  ): Promise<void> {
    // Persist accounting before the IPC result. The backend repeats this same
    // deterministic settlement intent, which the budget store accepts
    // idempotently, so Fastify death cannot strand observed provider usage.
    await this.dependencies.settleBudget(projectId, budget, settlement);
    this.journal.recordSettlement(attempt.operationId, {
      settlementId: workflowSupervisorDigest(settlement),
      status: workflowSupervisorSettlementStatus(settlement),
      usageComplete: settlement.usage !== undefined,
    });
  }

  private validateBudgetOwnership(
    projectId: string,
    identity: DagFusionDelegationIdentity,
    descriptor: SupervisedWorkflowBudgetDescriptorV1,
  ): SupervisedWorkflowBudgetDescriptorV1 {
    const stable = parseSupervisedWorkflowBudgetDescriptor(descriptor);
    if (
      stable.runId !== identity.ownerRunId ||
      `${stable.executionId}:${stable.slotId}` !== identity.nodeId ||
      stable.reservationId !== workflowBudgetReservationId(
        projectId,
        stable.runId,
        stable.executionId,
        stable.attempt,
        stable.slotId,
      )
    ) {
      throw new Error("Workflow supervisor budget ownership did not match the attempt.");
    }
    return stable;
  }

  private validateBudgetEnvelope(
    projectId: string,
    budget: SupervisedWorkflowBudgetDescriptorV1,
    requested: {
      maxTokens: number;
      maxCostUsd: number;
      modelCallCount: number;
    },
  ): void {
    if (
      !Number.isSafeInteger(requested.maxTokens) || requested.maxTokens < 1 ||
      typeof requested.maxCostUsd !== "number" ||
      !Number.isFinite(requested.maxCostUsd) || requested.maxCostUsd < 0 ||
      !Number.isSafeInteger(requested.modelCallCount) || requested.modelCallCount < 1
    ) {
      throw new Error("Workflow supervisor request budget envelope was invalid.");
    }
    const reservation = this.dependencies.budgetReservation(
      projectId,
      budget.reservationId,
    );
    if (
      !reservation ||
      reservation.id !== budget.reservationId ||
      reservation.projectId !== projectId ||
      reservation.runId !== budget.runId ||
      reservation.status !== "active" ||
      reservation.expiresAt <= this.dependencies.now()
    ) {
      throw new Error("Workflow supervisor budget reservation was not active for this attempt.");
    }
    const countsTowardBudget = billingCountsTowardBudget(
      billingForProvider(budget.provider, budget.authType),
    );
    const requestedCostUsd = countsTowardBudget ? requested.maxCostUsd : 0;
    if (
      requested.maxTokens > reservation.maxTokens ||
      requestedCostUsd > reservation.maxCostUsd + Number.EPSILON ||
      requested.modelCallCount > reservation.modelCallCount
    ) {
      throw new Error("Workflow supervisor request exceeded its durable budget reservation.");
    }
  }

  private markTerminal(
    attempt: ActiveAttempt,
    settlement: DagFusionDelegationUsageSettlement | undefined,
    error: unknown,
    proof: unknown,
  ): void {
    this.journal.markTerminal(attempt.operationId, {
      outcome: workflowSupervisorTerminalOutcome(settlement),
      code: error === undefined ? "TERMINAL_RESPONSE" : errorCode(error),
      proofSha256: workflowSupervisorDigest(proof),
    });
  }

  async delegate(input: {
    epoch: number;
    messageId: string;
    projectId: string;
    request: OwnedDelegationV2Request;
    limits: DagFusionDelegationUsageLimits;
    budget: SupervisedWorkflowBudgetDescriptorV1;
  }): Promise<WorkflowSupervisorDelegateResult> {
    const identity: DagFusionDelegationIdentity = {
      requestId: input.request.requestId,
      ownerRunId: input.request.ownerRunId,
      nodeId: input.request.nodeId,
    };
    const operationId = workflowSupervisorOperationId(
      "pi-subagent",
      input.projectId,
      identity,
    );
    const budget = this.validateBudgetOwnership(
      input.projectId,
      identity,
      input.budget,
    );
    const requestedProvider = input.request.model.split("/", 1)[0];
    if (!requestedProvider || budget.provider !== requestedProvider) {
      throw new Error("Workflow supervisor budget provider did not match delegation resolution.");
    }
    const expectedAuthType = requestedProvider === "openrouter"
      ? "api_key"
      : ["ollama", "openai-compatible"].includes(requestedProvider)
        ? "local"
        : ["openai-codex", "anthropic", "github-copilot", "xai"].includes(
            requestedProvider,
          )
          ? "oauth"
          : "none";
    if (budget.authType !== expectedAuthType) {
      throw new Error("Workflow supervisor budget auth did not match delegation resolution.");
    }
    this.validateBudgetEnvelope(input.projectId, budget, {
      maxTokens: input.limits.maxTokens,
      maxCostUsd: input.limits.maxCostUsd,
      modelCallCount: 1,
    });
    const attempt = this.beginAttempt({
      operationId,
      messageId: input.messageId,
      projectId: input.projectId,
      backendEpoch: input.epoch,
      kind: "delegate",
      identity,
      budget,
      requestDigest: workflowSupervisorDigest({
        version: 1,
        projectId: input.projectId,
        request: input.request,
        limits: input.limits,
        budget,
      }),
    });
    let settlement: DagFusionDelegationUsageSettlement | undefined;
    let session: WorkflowDelegationSession | undefined;
    try {
      const paths = this.dependencies.pathsForProject(input.projectId);
      if (input.request.cwd !== paths.sandbox) {
        throw new Error("Delegation cwd did not match the canonical project sandbox.");
      }
      session = await this.dependencies.getDelegationSession(input.projectId, paths);
      const receipt = await session.host.delegate(input.request, {
        limits: input.limits,
        signal: attempt.controller.signal,
        reconcileUsage: async (observed) => {
          settlement = this.normalizeSettlement(identity, settlement, observed);
          await this.persistSettlement(
            attempt,
            input.projectId,
            budget,
            settlement,
          );
        },
      });
      if (!settlement) {
        return this.retainQuarantine(
          attempt,
          "TERMINAL_SETTLEMENT_MISSING",
          new Error("Delegation completed without a durable settlement."),
        );
      }
      this.markTerminal(attempt, settlement, undefined, { receipt, settlement });
      return { receipt, settlement };
    } catch (error) {
      try {
        const quarantined = session?.host.snapshot().quarantined.some((entry) =>
          sameIdentity(entry, identity)
        ) ?? false;
        if (quarantined && session) await session.dispose();
        this.markTerminal(attempt, settlement, error, {
          identity,
          settlement,
          code: errorCode(error),
        });
      } catch (quiescenceError) {
        return this.retainQuarantine(
          attempt,
          "DELEGATION_TERMINAL_UNCONFIRMED",
          quiescenceError,
        );
      }
      coordinatorError(
        "OPERATION_FAILED",
        "The supervised Pi delegation failed after terminal ownership reconciliation.",
        settlement,
        error,
      );
    } finally {
      this.finishAttempt(attempt);
    }
  }

  async hostedFusion(input: {
    epoch: number;
    messageId: string;
    projectId: string;
    request: SerializedHostedOpenRouterFusionRequest;
    budget: SupervisedWorkflowBudgetDescriptorV1;
  }): Promise<WorkflowSupervisorHostedResult> {
    const identity = input.request.identity;
    const operationId = workflowSupervisorOperationId(
      "hosted-fusion",
      input.projectId,
      identity,
    );
    const budget = this.validateBudgetOwnership(
      input.projectId,
      identity,
      input.budget,
    );
    if (budget.provider !== "openrouter" || budget.authType !== "api_key") {
      throw new Error("Hosted Fusion requires an OpenRouter API-key budget descriptor.");
    }
    this.validateBudgetEnvelope(input.projectId, budget, {
      maxTokens: input.request.maxTokens,
      maxCostUsd: input.request.maxCostUsd,
      modelCallCount: input.request.resolved.members.length + 2,
    });
    const attempt = this.beginAttempt({
      operationId,
      messageId: input.messageId,
      projectId: input.projectId,
      backendEpoch: input.epoch,
      kind: "hosted-fusion",
      identity,
      budget,
      requestDigest: workflowSupervisorDigest({
        version: 1,
        projectId: input.projectId,
        request: input.request,
        budget,
      }),
    });
    let settlement: DagFusionDelegationUsageSettlement | undefined;
    try {
      if (input.request.projectId !== input.projectId) {
        throw new Error("Hosted Fusion project identity changed across IPC.");
      }
      const result = await this.dependencies.runHostedFusion({
        ...structuredClone(input.request),
        paths: this.dependencies.pathsForProject(input.projectId),
        signal: attempt.controller.signal,
        reconcileUsage: async (observed) => {
          settlement = this.normalizeSettlement(identity, settlement, observed);
          await this.persistSettlement(
            attempt,
            input.projectId,
            budget,
            settlement,
          );
        },
      });
      if (!settlement) {
        return this.retainQuarantine(
          attempt,
          "TERMINAL_SETTLEMENT_MISSING",
          new Error("Hosted Fusion completed without a durable settlement."),
        );
      }
      this.markTerminal(attempt, settlement, undefined, { result, settlement });
      return { result, settlement };
    } catch (error) {
      try {
        if (this.dependencies.hostedQuarantines(input.projectId).length > 0) {
          await this.dependencies.waitHostedQuarantines();
          this.dependencies.assertNoHostedQuarantine(input.projectId);
        }
        this.markTerminal(attempt, settlement, error, {
          identity,
          settlement,
          code: errorCode(error),
        });
      } catch (quiescenceError) {
        return this.retainQuarantine(
          attempt,
          "HOSTED_FUSION_TERMINAL_UNCONFIRMED",
          quiescenceError,
        );
      }
      coordinatorError(
        "OPERATION_FAILED",
        "The supervised hosted Fusion request failed after ownership reconciliation.",
        settlement,
        error,
      );
    } finally {
      this.finishAttempt(attempt);
    }
  }

  async quiesceProject(epoch: number, projectId: string): Promise<number> {
    this.requireEpoch(epoch);
    this.quiescingProjects.add(projectId);
    try {
      const attempts = [...this.active.values()].filter(
        (attempt) => attempt.projectId === projectId,
      );
      for (const attempt of attempts) {
        attempt.state = "cancelling";
        attempt.controller.abort(new Error(`Project ${projectId} is quiescing.`));
      }
      await this.drainAttempts(attempts, projectId);
      const delegation = await this.dependencies.delegationSessionSnapshot(projectId);
      if (delegation?.host.pending.length) {
        coordinatorError(
          "SUPERVISOR_BUSY",
          `Project ${projectId} still has supervised Pi ownership.`,
        );
      }
      await this.dependencies.disposeDelegationSession(projectId, {
        rejectIfOwnedLeaves: true,
      });
      this.dependencies.assertNoHostedQuarantine(projectId);
      return attempts.length;
    } finally {
      // The backend workflow controller keeps its own admission gate held for
      // the rest of project deletion. Releasing here also lets a failed delete
      // be retried without restarting the supervisor.
      this.quiescingProjects.delete(projectId);
    }
  }

  async reloadCredentials(
    epoch: number,
    keys: readonly WorkflowSupervisorCredentialKey[],
  ): Promise<void> {
    this.requireEpoch(epoch);
    if (this.configuring) {
      coordinatorError("SUPERVISOR_BUSY", "Workflow supervisor credentials are already reloading.");
    }
    this.configuring = true;
    this.configurationReady = false;
    try {
      await this.dependencies.reloadCredentials(keys);
      this.configurationReady = true;
    } catch (error) {
      coordinatorError(
        "OPERATION_FAILED",
        "Workflow supervisor credentials could not be reloaded.",
        undefined,
        error,
      );
    } finally {
      this.configuring = false;
    }
  }

  snapshot(projectId?: string): WorkflowSupervisorSnapshot {
    const attempts = [...this.active.values(), ...this.runtimeQuarantines.values()]
      .filter((attempt, index, all) =>
        all.findIndex((candidate) => candidate.operationId === attempt.operationId) === index
      )
      .filter((attempt) => projectId === undefined || attempt.projectId === projectId)
      .map((attempt): WorkflowSupervisorAttemptSnapshot => ({
        messageId: attempt.messageId,
        projectId: attempt.projectId,
        kind: attempt.kind,
        identity: structuredClone(attempt.identity),
        state: attempt.state,
        startedAt: attempt.startedAt,
      }));
    return {
      pid: process.pid,
      state: this.state(),
      attachedEpoch: this.controlAttached ? this.attachedEpoch : null,
      quiescingProjectIds: [...this.quiescingProjects].sort(),
      attempts,
    };
  }

  async shutdown(epoch: number): Promise<void> {
    this.requireEpoch(epoch);
    this.shuttingDown = true;
    const attempts = [...this.active.values()];
    for (const attempt of attempts) {
      attempt.state = "cancelling";
      attempt.controller.abort(new Error("Workflow supervisor shutdown requested."));
    }
    await this.drainAttempts(attempts);
    this.assertNoUncertainOwnership();
    await this.dependencies.waitHostedQuarantines();
    this.dependencies.assertNoHostedQuarantine();
    await this.dependencies.disposeAllDelegationSessions();
    this.assertNoUncertainOwnership();
  }
}
