export const WORKFLOW_BEHAVIOR_REGISTRY_VERSION = 1 as const;

export const WORKFLOW_BEHAVIOR_CAPABILITIES = [
  "restart-workflow",
  "escalate-fix-redeploy",
  "lateral-pass",
  "stop-workflow",
] as const;

export type WorkflowBehaviorCapability =
  (typeof WORKFLOW_BEHAVIOR_CAPABILITIES)[number];

export interface WorkflowBehaviorDispatch {
  capability: WorkflowBehaviorCapability;
  runId: string;
  nodeId?: string;
  payload?: Readonly<Record<string, unknown>>;
}

export interface WorkflowBehaviorResult {
  handled: boolean;
  detail?: string;
}

export type WorkflowBehaviorHandler = (
  dispatch: WorkflowBehaviorDispatch,
) => WorkflowBehaviorResult | Promise<WorkflowBehaviorResult>;

export type WorkflowBehaviorRegistryErrorCode =
  | "INVALID_NAME"
  | "INVALID_CAPABILITIES"
  | "ALREADY_REGISTERED"
  | "NOT_REGISTERED"
  | "CAPABILITY_NOT_REGISTERED";

export class WorkflowBehaviorRegistryError extends Error {
  constructor(
    readonly code: WorkflowBehaviorRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowBehaviorRegistryError";
  }
}

interface RegisteredWorkflowBehavior {
  capabilities: ReadonlySet<WorkflowBehaviorCapability>;
  handler: WorkflowBehaviorHandler;
}

const BEHAVIOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY_SET = new Set<WorkflowBehaviorCapability>(
  WORKFLOW_BEHAVIOR_CAPABILITIES,
);

/** Handler registry only; S7 owns the watcher and rescue implementations. */
export class WorkflowBehaviorRegistry {
  readonly version = WORKFLOW_BEHAVIOR_REGISTRY_VERSION;
  readonly #behaviors = new Map<string, RegisteredWorkflowBehavior>();

  register(
    name: string,
    capabilities: readonly WorkflowBehaviorCapability[],
    handler: WorkflowBehaviorHandler,
  ): void {
    if (!BEHAVIOR_NAME_PATTERN.test(name)) {
      throw new WorkflowBehaviorRegistryError(
        "INVALID_NAME",
        `Invalid workflow behavior name: ${name}`,
      );
    }
    const uniqueCapabilities = new Set(capabilities);
    if (
      capabilities.length === 0 || uniqueCapabilities.size !== capabilities.length ||
      capabilities.some((capability) => !CAPABILITY_SET.has(capability))
    ) {
      throw new WorkflowBehaviorRegistryError(
        "INVALID_CAPABILITIES",
        "Workflow behaviors require a non-empty, unique capability list.",
      );
    }
    if (this.#behaviors.has(name)) {
      throw new WorkflowBehaviorRegistryError(
        "ALREADY_REGISTERED",
        `Workflow behavior ${name} is already registered.`,
      );
    }
    this.#behaviors.set(name, {
      capabilities: uniqueCapabilities,
      handler,
    });
  }

  has(name: string): boolean {
    return this.#behaviors.has(name);
  }

  capabilities(name: string): readonly WorkflowBehaviorCapability[] {
    const behavior = this.#behaviors.get(name);
    if (!behavior) return [];
    return WORKFLOW_BEHAVIOR_CAPABILITIES.filter((capability) =>
      behavior.capabilities.has(capability)
    );
  }

  async dispatch(
    name: string,
    request: WorkflowBehaviorDispatch,
  ): Promise<WorkflowBehaviorResult> {
    const behavior = this.#behaviors.get(name);
    if (!behavior) {
      throw new WorkflowBehaviorRegistryError(
        "NOT_REGISTERED",
        `Workflow behavior ${name} is not registered.`,
      );
    }
    if (!behavior.capabilities.has(request.capability)) {
      throw new WorkflowBehaviorRegistryError(
        "CAPABILITY_NOT_REGISTERED",
        `Workflow behavior ${name} cannot ${request.capability}.`,
      );
    }
    return behavior.handler(request);
  }
}
