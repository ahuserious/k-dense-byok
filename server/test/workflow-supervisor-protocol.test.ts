import { describe, expect, it } from "vitest";
import type {
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationRequest,
} from "../pi-packages/dag-fusion-drive/index.ts";
import {
  MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES,
  WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
  WorkflowSupervisorProtocolError,
  encodeWorkflowSupervisorRequestLine,
  encodeWorkflowSupervisorResponseLine,
  isWorkflowSupervisorEpoch,
  isWorkflowSupervisorId,
  isWorkflowSupervisorToken,
  parseWorkflowSupervisorRequestLine,
  parseWorkflowSupervisorResponseLine,
  workflowSupervisorErrorResponse,
  type SerializedHostedOpenRouterFusionRequest,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
} from "../src/workflows/supervisor/protocol.ts";
import { workflowBudgetReservationId } from "../src/workflows/budget.ts";
import { createSupervisedWorkflowBudgetDescriptor } from "../src/workflows/supervised-budget.ts";

const TOKEN = "supervisor_token_0123456789abcdef";

function budget() {
  const runId = "wrun_0123456789abcdef";
  const executionId = "node-1";
  const attempt = 1;
  const slotId = "agent";
  return createSupervisedWorkflowBudgetDescriptor({
    reservationId: workflowBudgetReservationId(
      "default",
      runId,
      executionId,
      attempt,
      slotId,
    ),
    runId,
    executionId,
    attempt,
    slotId,
    provider: "openrouter",
    authKind: "api-key",
  });
}

function delegationRequest(): OwnedDelegationRequest {
  return {
    requestId: "dagcall_run-1_node-1_agent",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "node-1:agent",
    agent: "dag-workflow-readonly-executor",
    task: "Analyze the supplied evidence.",
    context: "fresh",
    cwd: "/tmp/kady-project/sandbox",
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 12, graceTurns: 2 },
    toolBudget: { soft: 20, hard: 30, block: "*" },
    skill: false,
    artifacts: false,
    result: {
      kind: "structured",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  };
}

function openRouterModelRequest(model: string) {
  return {
    requested: {
      source: "fixed" as const,
      provider: "openrouter",
      model,
      auth: { kind: "api-key" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
  };
}

function modelReceipt(model: string) {
  return {
    request: openRouterModelRequest(model),
    resolved: {
      provider: "openrouter",
      model,
      auth: { kind: "api-key" },
      reasoning: "high" as const,
      runtime: "openrouter-fusion" as const,
    },
    fallbackUsed: false,
  };
}

function hostedRequest(): SerializedHostedOpenRouterFusionRequest {
  const router = openRouterModelRequest("openrouter/fusion");
  const analyst = openRouterModelRequest("anthropic/claude-sonnet-4.5");
  const critic = openRouterModelRequest("openai/gpt-5.4");
  const judge = openRouterModelRequest("google/gemini-3-pro");
  return {
    projectId: "default",
    identity: {
      requestId: "dagfusion_run-1_fusion-1",
      ownerRunId: "wrun_0123456789abcdef",
      nodeId: "fusion-1:hosted",
    },
    fusion: {
      mode: "openrouter-router",
      router,
      members: [
        { id: "analyst", role: "Analyst", model: analyst },
        { id: "critic", role: "Critic", model: critic },
      ],
      judge,
    },
    resolved: {
      members: [
        { memberId: "analyst", role: "Analyst", receipt: modelReceipt("anthropic/claude-sonnet-4.5") },
        { memberId: "critic", role: "Critic", receipt: modelReceipt("openai/gpt-5.4") },
      ],
      judgeDeliberation: modelReceipt("google/gemini-3-pro"),
      judgeFinal: modelReceipt("google/gemini-3-pro"),
    },
    task: "Fuse the independent analyses.",
    maxTokens: 10_000,
    maxCostUsd: 12,
    timeoutMs: 120_000,
  };
}

function usage() {
  return {
    input: 100,
    output: 40,
    cacheRead: 10,
    cacheWrite: 0,
    cost: 0.25,
    turns: 2,
    toolCalls: 0,
    durationMs: 1_200,
  };
}

function settlement(): DagFusionDelegationUsageSettlement {
  return {
    identity: {
      requestId: "dagcall_run-1_node-1_agent",
      ownerRunId: "wrun_0123456789abcdef",
      nodeId: "node-1:agent",
    },
    reason: "terminal-response",
    responseStatus: "completed",
    usage: usage(),
    progress: {
      started: true,
      model: "openai-codex/gpt-5.4",
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function receipt(): DagFusionDelegationReceipt {
  const request = delegationRequest();
  return {
    identity: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    },
    requested: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
    },
    resolved: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      launchContractDigest: "a".repeat(64),
    },
    response: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      result: { kind: "structured", value: { answer: "Supported." } },
      usage: usage(),
    },
    usage: { ...usage(), totalTokens: 150 },
    progress: {
      started: true,
      model: request.model,
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function requests(): WorkflowSupervisorRequest[] {
  const common = {
    version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
    messageId: "msg-0001",
    token: TOKEN,
  } as const;
  return [
    { ...common, op: "ping" },
    { ...common, messageId: "msg-0002", op: "attach", epoch: 4 },
    {
      ...common,
      messageId: "msg-0003",
      op: "delegate",
      epoch: 4,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 10_000, maxCostUsd: 2 },
      budget: budget(),
    },
    {
      ...common,
      messageId: "msg-0004",
      op: "hosted-fusion",
      epoch: 4,
      projectId: "default",
      request: hostedRequest(),
      budget: budget(),
    },
    {
      ...common,
      messageId: "msg-0005",
      op: "reload-credentials",
      epoch: 4,
      keys: ["openrouter", "exa"],
    },
    {
      ...common,
      messageId: "msg-0006",
      op: "quiesce-project",
      epoch: 4,
      projectId: "default",
      reason: "restart-recovery",
    },
    {
      ...common,
      messageId: "msg-0007",
      op: "snapshot",
      epoch: 4,
      projectId: "default",
    },
    {
      ...common,
      messageId: "msg-0008",
      op: "shutdown",
      epoch: 4,
      reason: "backend-shutdown",
    },
  ];
}

function responses(): WorkflowSupervisorResponse[] {
  return [
    {
      version: 1,
      messageId: "msg-0001",
      ok: true,
      op: "ping",
      result: { pid: 42, state: "ready", attachedEpoch: 4 },
    },
    {
      version: 1,
      messageId: "msg-0002",
      ok: true,
      op: "attach",
      result: { attached: true, epoch: 4 },
    },
    {
      version: 1,
      messageId: "msg-0003",
      ok: true,
      op: "delegate",
      result: { receipt: receipt(), settlement: settlement() },
    },
    {
      version: 1,
      messageId: "msg-0004",
      ok: true,
      op: "hosted-fusion",
      result: {
        result: { text: "Fused.", textTruncated: false, usage: usage() },
        settlement: settlement(),
      },
    },
    {
      version: 1,
      messageId: "msg-0005",
      ok: true,
      op: "reload-credentials",
      result: { reloaded: true, keys: ["openrouter", "exa"] },
    },
    {
      version: 1,
      messageId: "msg-0006",
      ok: true,
      op: "quiesce-project",
      result: { projectId: "default", quiescent: true, cancelledAttempts: 2 },
    },
    {
      version: 1,
      messageId: "msg-0007",
      ok: true,
      op: "snapshot",
      result: {
        snapshot: {
          pid: 42,
          state: "quiescing",
          attachedEpoch: 4,
          quiescingProjectIds: ["default"],
          attempts: [{
            messageId: "msg-0003",
            projectId: "default",
            kind: "delegate",
            identity: settlement().identity,
            state: "cancelling",
            startedAt: 1_700_000_000_000,
          }],
        },
      },
    },
    {
      version: 1,
      messageId: "msg-0008",
      ok: true,
      op: "shutdown",
      result: { accepted: true },
    },
  ];
}

function expectProtocolCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected protocol validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowSupervisorProtocolError);
    expect(error).toMatchObject({ code });
  }
}

describe("workflow supervisor IPC protocol", () => {
  it("round-trips every strict request operation as one newline-JSON frame", () => {
    for (const request of requests()) {
      const line = encodeWorkflowSupervisorRequestLine(request);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(parseWorkflowSupervisorRequestLine(line)).toEqual(request);
      expect(parseWorkflowSupervisorRequestLine(line.slice(0, -1))).toEqual(request);
      expect(parseWorkflowSupervisorRequestLine(`${line.slice(0, -1)}\r\n`)).toEqual(request);
    }
  });

  it("round-trips typed terminal results, exact settlements, and snapshots", () => {
    for (const response of responses()) {
      const line = encodeWorkflowSupervisorResponseLine(response);
      expect(parseWorkflowSupervisorResponseLine(line)).toEqual(response);
    }
  });

  it("rejects unknown fields, invalid correlation ids, weak tokens, and invalid epochs", () => {
    const ping = requests()[0]!;
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...ping, extra: true })),
      "INVALID_MESSAGE",
    );
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...ping, messageId: "bad id" })),
      "INVALID_MESSAGE",
    );
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...ping, token: "short" })),
      "INVALID_MESSAGE",
    );
    const attach = requests()[1]!;
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...attach, epoch: 0 })),
      "INVALID_MESSAGE",
    );
    const snapshot = requests()[6]!;
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...snapshot, projectId: "archive" })),
      "INVALID_MESSAGE",
    );
    expect(isWorkflowSupervisorId("run:node-1")).toBe(true);
    expect(isWorkflowSupervisorId("bad id")).toBe(false);
    expect(isWorkflowSupervisorToken(TOKEN)).toBe(true);
    expect(isWorkflowSupervisorToken("short")).toBe(false);
    expect(isWorkflowSupervisorEpoch(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isWorkflowSupervisorEpoch(1.5)).toBe(false);
  });

  it("rejects unlisted nested fields and never accepts host-only Fusion values", () => {
    const delegate = structuredClone(requests()[2]!) as unknown as Record<string, unknown>;
    (delegate.request as Record<string, unknown>).unexpected = "not-on-wire";
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify(delegate)),
      "INVALID_MESSAGE",
    );

    const hosted = structuredClone(requests()[3]!) as unknown as Record<string, unknown>;
    (hosted.request as Record<string, unknown>).paths = {
      sandbox: "/private/project",
    };
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify(hosted)),
      "INVALID_MESSAGE",
    );

    const mismatched = structuredClone(requests()[3]!) as unknown as Record<string, unknown>;
    (mismatched.request as Record<string, unknown>).projectId = "different-project";
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify(mismatched)),
      "INVALID_MESSAGE",
    );
  });

  it("rejects legacy version'd V2 delegation requests and requests missing result", () => {
    const legacy = structuredClone(requests()[2]!) as unknown as Record<string, unknown>;
    (legacy.request as Record<string, unknown>).version = 2;
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify(legacy)),
      "INVALID_MESSAGE",
    );

    const missingResult = structuredClone(requests()[2]!) as unknown as Record<string, unknown>;
    delete (missingResult.request as Record<string, unknown>).result;
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify(missingResult)),
      "INVALID_MESSAGE",
    );
  });

  it("enforces one fatal-UTF8, bounded JSON line and distinguishes unsupported versions", () => {
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(new Uint8Array([0xff, 0xfe])),
      "INVALID_UTF8",
    );
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(`${JSON.stringify(requests()[0])}\n${JSON.stringify(requests()[0])}\n`),
      "INVALID_JSON",
    );
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(JSON.stringify({ ...requests()[0], version: 2 })),
      "UNSUPPORTED_VERSION",
    );
    expectProtocolCode(
      () => parseWorkflowSupervisorRequestLine(new Uint8Array(MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES + 1)),
      "FRAME_TOO_LARGE",
    );

    const oversized = structuredClone(requests()[2]!);
    if (oversized.op !== "delegate" || oversized.request.result.kind !== "structured") {
      throw new Error("Expected the delegate fixture.");
    }
    oversized.request.result.schema = {
      description: "x".repeat(MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES),
    };
    expectProtocolCode(
      () => encodeWorkflowSupervisorRequestLine(oversized),
      "FRAME_TOO_LARGE",
    );
  });

  it("uses only fixed safe error text and may carry validated terminal accounting", () => {
    const response = workflowSupervisorErrorResponse(
      "msg-0008",
      "OPERATION_FAILED",
      settlement(),
    );
    expect(response).toEqual({
      version: 1,
      messageId: "msg-0008",
      ok: false,
      error: {
        code: "OPERATION_FAILED",
        message: "The workflow supervisor operation failed.",
        retryable: false,
      },
      settlement: settlement(),
    });
    expect(parseWorkflowSupervisorResponseLine(
      encodeWorkflowSupervisorResponseLine(response),
    )).toEqual(response);

    const untrustedMessage = "OPENROUTER_API_KEY=secret-value";
    const unattributed = workflowSupervisorErrorResponse(
      untrustedMessage,
      "UNAUTHORIZED",
    );
    const encoded = encodeWorkflowSupervisorResponseLine(unattributed);
    expect(unattributed.messageId).toBeNull();
    expect(encoded).not.toContain(untrustedMessage);
    expect(encoded).not.toContain("secret-value");

    const forged = structuredClone(response) as unknown as Record<string, unknown>;
    (forged.error as Record<string, unknown>).message = untrustedMessage;
    expectProtocolCode(
      () => parseWorkflowSupervisorResponseLine(JSON.stringify(forged)),
      "INVALID_MESSAGE",
    );
  });
});
