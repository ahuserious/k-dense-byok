/**
 * Vendor-local compatibility shims for upstream instrumentation hooks.
 *
 * The standalone K-Dense product does not emit analytics. These exports remain
 * so the vendored engine's existing call sites keep their stable types without
 * constructing a client, persisting an install identifier, or performing any
 * network I/O.
 */

export const TELEMETRY_SCHEMA_VERSION = 0;

export type WorkflowTelemetrySource = 'bundled' | 'global' | 'project';

export function classifyWorkflowForTelemetry(
  name: string,
  source: WorkflowTelemetrySource | undefined
): { workflow_name: string; is_builtin: boolean; workflow_source: WorkflowTelemetrySource } {
  const isBuiltin = source === 'bundled';
  return {
    is_builtin: isBuiltin,
    workflow_name: isBuiltin ? name : 'custom',
    workflow_source: source ?? 'project',
  };
}

export function sanitizeModelForTelemetry(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  return /^[a-zA-Z0-9/._:-]{1,64}$/.test(model) ? model : undefined;
}

export type TelemetryDisabledReason = 'VENDOR_DISABLED';

export interface TelemetryStatus {
  enabled: false;
  disabledReason: TelemetryDisabledReason;
  distinctId: '';
  host: '';
  keySource: 'none';
}

export function isTelemetryDisabled(): boolean {
  return true;
}

export function getTelemetryStatus(): TelemetryStatus {
  return {
    enabled: false,
    disabledReason: 'VENDOR_DISABLED',
    distinctId: '',
    host: '',
    keySource: 'none',
  };
}

export function getOrCreateTelemetryId(): string {
  return '';
}

export function resetTelemetryId(): string {
  return '';
}

export interface WorkflowInvokedProperties {
  workflowName: string;
  workflowSource?: WorkflowTelemetrySource;
  platform?: string;
  provider?: string;
  model?: string;
  nodeCount?: number;
  usesLoop?: boolean;
  usesApproval?: boolean;
  usesScript?: boolean;
  usesBash?: boolean;
  usesOutputFormat?: boolean;
  usesOutputType?: boolean;
  usesPersistSession?: boolean;
  usesMcp?: boolean;
  usesSkills?: boolean;
  usesFreshContext?: boolean;
  interactive?: boolean;
  usedIsolation?: boolean;
  isResume?: boolean;
}

export interface DeploymentShapeProperties {
  dbKind?: 'sqlite' | 'postgresql';
  webAuthEnabled?: boolean;
  multiUser?: boolean;
  githubAuthMode?: 'app' | 'pat' | 'none' | 'conflict';
  adapterSlack?: boolean;
  adapterDiscord?: boolean;
  adapterGitea?: boolean;
  adapterGitlab?: boolean;
}

export interface ArchonStartedProperties extends DeploymentShapeProperties {
  surface: 'cli' | 'server';
}

export interface ChatTurnProperties {
  platform?: string;
  provider?: string;
  model?: string;
  outcome: 'completed' | 'failed';
  durationMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export type WorkflowExitReason = 'no_nodes_completed' | 'node_error' | 'unhandled_error';
export type WorkflowErrorClass = 'fatal' | 'transient' | 'unknown';
export type WorkflowNodeType =
  | 'command'
  | 'prompt'
  | 'bash'
  | 'script'
  | 'loop'
  | 'approval'
  | 'cancel';

export interface WorkflowCompletedProperties {
  outcome: 'completed' | 'failed';
  workflowName: string;
  workflowSource?: WorkflowTelemetrySource;
  provider?: string;
  durationMs?: number;
  nodesCompleted?: number;
  nodesFailed?: number;
  nodesSkipped?: number;
  nodesTotal?: number;
  exitReason?: WorkflowExitReason;
  errorClass?: WorkflowErrorClass;
  failedNodeType?: WorkflowNodeType;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  loopIterations?: number;
}

export function captureWorkflowInvoked(_props: WorkflowInvokedProperties): void {}
export function captureArchonStarted(_props: ArchonStartedProperties): void {}
export function captureArchonActive(_props: ArchonStartedProperties): void {}
export function captureChatTurn(_props: ChatTurnProperties): void {}
export function captureApprovalResolved(_props: {
  resolution: 'approved' | 'rejected';
}): void {}
export function captureCodebaseRegistered(): void {}
export function captureWorkflowCompleted(_props: WorkflowCompletedProperties): void {}
export async function shutdownTelemetry(): Promise<void> {}
export function resetTelemetryForTests(): void {}
