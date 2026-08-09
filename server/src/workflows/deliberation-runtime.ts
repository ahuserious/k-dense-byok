import crypto from "node:crypto";
import { mimeographSubagentForPersonality } from "../agent/subagents.ts";
import {
  DEFAULT_PERSONALITY_STORE_REF,
  ensurePersonalityStoreInstalled,
  loadPersonalityStoreSnapshot,
  personalityContentManifestDigest,
  selectBestPersonalities,
  type PersonalityStoreSnapshot,
  type ScientificPersonality,
} from "../personality-store/store.ts";
import type {
  WorkflowNodeExecutor,
  WorkflowNodeExecutorContext,
} from "./runner.ts";
import type { WorkflowDeliberationStaffingReceipt } from "./run-state.ts";
import type { WorkflowNode } from "./schema.ts";
import {
  materializeEffectiveHostedFusionNode,
  type HostedOpenRouterFusionNode,
} from "./hosted-fusion-definition.ts";

const MAX_DELIBERATION_DIRECTIVE_CHARS = 20_000;
const MAX_NODE_GOAL_CHARS = 32_768;

export type DeliberationNode = Extract<
  WorkflowNode,
  { kind: "best-of-n" | "council" | "fusion" }
>;

export interface BoundDeliberationStaffing {
  storeRef: string;
  mode: "auto" | "manual";
  personalities: ScientificPersonality[];
  node: DeliberationNode;
}

type CouncilMember = Extract<DeliberationNode, { kind: "council" }>["members"][number];
type FusionMember = Extract<DeliberationNode, { kind: "fusion" }>["fusion"]["members"][number];

function nodeTask(node: DeliberationNode): string {
  return node.goal;
}

function boundedMimeographPrompts(personalities: readonly ScientificPersonality[]): string {
  const fixedOverhead = personalities.length * 128;
  const perPersonality = Math.max(
    256,
    Math.floor((MAX_DELIBERATION_DIRECTIVE_CHARS - fixedOverhead) / personalities.length),
  );
  return personalities.map((personality, index) => {
    const mimeograph = mimeographSubagentForPersonality(personality);
    const prompt = mimeograph.systemPrompt.length <= perPersonality
      ? mimeograph.systemPrompt
      : `${mimeograph.systemPrompt.slice(0, perPersonality - 24)}\n[profile bounded]`;
    return `${index + 1}. ${mimeograph.name} (${personality.ref})\n${prompt}`;
  }).join("\n\n");
}

function staffingDirective(input: {
  storeRef: string;
  mode: "auto" | "manual";
  nodeKind: DeliberationNode["kind"];
  personalities: readonly ScientificPersonality[];
}): string {
  const assignment = input.nodeKind === "best-of-n"
    ? "Candidate path k must adopt roster entry ((k - 1) mod roster size) + 1. The candidate evaluator remains independent of model-candidate selection."
    : "Each authored panel member must adopt the correspondingly ordered roster entry, cycling only when there are more members than selected personalities.";
  return [
    "[Trusted Scientific DAG mimeograph staffing]",
    `Personality store: ${input.storeRef}`,
    `Staffing mode: ${input.mode}`,
    `Selected personality count: ${input.personalities.length}`,
    assignment,
    "Personality selection changes perspective only; the typed node goal, evidence rules, model receipts, and runtime limits remain authoritative.",
    boundedMimeographPrompts(input.personalities),
    "[End trusted mimeograph staffing]",
  ].join("\n\n");
}

function appendPersonalityToRole(
  role: string,
  personality: ScientificPersonality,
): string {
  const suffix = ` [mimeograph:${personality.ref}]`;
  const available = Math.max(1, 256 - suffix.length);
  return `${role.slice(0, available)}${suffix}`.slice(0, 256);
}

function withoutDeliberationSettings(node: DeliberationNode): DeliberationNode {
  if (!node.settings?.deliberation) return node;
  const settings = { ...node.settings };
  delete settings.deliberation;
  const { settings: _authoredSettings, ...baseNode } = node;
  return {
    ...baseNode,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  } as DeliberationNode;
}

/** Resolve configured personalities and materialize them into provider-visible node input. */
export function bindDeliberationStaffing(
  node: DeliberationNode,
  snapshot: PersonalityStoreSnapshot,
  receiptedPersonalityRefs?: readonly string[],
): BoundDeliberationStaffing {
  const deliberation = node.settings?.deliberation;
  if (!deliberation) {
    throw new Error(`Node ${node.id} has no configured deliberation staffing.`);
  }
  const storeRef = deliberation.personalityStoreRef ?? DEFAULT_PERSONALITY_STORE_REF;
  if (snapshot.storeRef !== storeRef) {
    throw new Error(
      `Node ${node.id} requested personality store ${storeRef}, but ${snapshot.storeRef} is installed.`,
    );
  }
  const count = deliberation.bestOfNPersonalityCount ?? 2;
  const mode = deliberation.mimeographs?.mode ?? "auto";
  const manualRefs = deliberation.mimeographs?.personalityRefs ?? [];
  if (new Set(manualRefs).size !== manualRefs.length) {
    throw new Error(`Node ${node.id} has duplicate mimeograph personality refs.`);
  }
  if (mode === "auto" && manualRefs.length > 0) {
    throw new Error(`Node ${node.id} cannot combine auto mimeographs with manual refs.`);
  }
  if (mode === "manual" && manualRefs.length !== count) {
    throw new Error(
      `Node ${node.id} requires exactly ${count} manual mimeograph personality refs.`,
    );
  }
  if (receiptedPersonalityRefs && receiptedPersonalityRefs.length !== count) {
    throw new Error(
      `Node ${node.id} receipted ${receiptedPersonalityRefs.length} personalities, expected ${count}.`,
    );
  }
  const personalities = receiptedPersonalityRefs
    ? receiptedPersonalityRefs.map((ref) => {
        const personality = snapshot.personalities.find((candidate) => candidate.ref === ref);
        if (!personality) throw new Error(`Receipted personality ref is unavailable: ${ref}.`);
        return structuredClone(personality);
      })
    : mode === "manual"
    ? manualRefs.map((ref) => {
        const personality = snapshot.personalities.find((candidate) => candidate.ref === ref);
        if (!personality) throw new Error(`Unknown personality ref: ${ref}.`);
        return structuredClone(personality);
      })
    : selectBestPersonalities(nodeTask(node), count, snapshot);
  const directive = staffingDirective({
    storeRef,
    mode,
    nodeKind: node.kind,
    personalities,
  });
  const goal = `${directive}\n\nOriginal typed node goal:\n${node.goal}`;
  if (goal.length > MAX_NODE_GOAL_CHARS) {
    throw new Error(`Deliberation staffing for node ${node.id} exceeds the node goal bound.`);
  }
  let bound = withoutDeliberationSettings(node);
  bound = { ...bound, goal };
  if (bound.kind === "council") {
    bound = {
      ...bound,
      members: bound.members.map((member: CouncilMember, index: number) => ({
        ...member,
        role: appendPersonalityToRole(member.role, personalities[index % personalities.length]),
      })),
    };
  } else if (bound.kind === "fusion") {
    bound = {
      ...bound,
      fusion: {
        ...bound.fusion,
        members: bound.fusion.members.map((member: FusionMember, index: number) => ({
          ...member,
          role: appendPersonalityToRole(member.role, personalities[index % personalities.length]),
        })),
      },
    } as DeliberationNode;
  }
  return { storeRef, mode, personalities, node: bound };
}

export function effectiveDeliberationPromptSha256(node: DeliberationNode): string {
  const roles = node.kind === "council"
    ? node.members.map((member) => ({ id: member.id, role: member.role }))
    : node.kind === "fusion"
    ? node.fusion.members.map((member) => ({ id: member.id, role: member.role }))
    : [];
  return crypto.createHash("sha256").update(JSON.stringify({
    kind: node.kind,
    goal: node.goal,
    roles,
  })).digest("hex");
}

function assertVerifiedPersonalitySnapshot(snapshot: PersonalityStoreSnapshot): void {
  if (
    !snapshot.source.trim() ||
    !/^[a-f0-9]{40}$/.test(snapshot.revision) ||
    !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
    personalityContentManifestDigest(snapshot.personalities) !== snapshot.digest
  ) {
    throw new Error("Deliberation personality snapshot failed commit/content verification.");
  }
}

function isDeliberationNode(node: WorkflowNode): node is DeliberationNode {
  return node.kind === "best-of-n" || node.kind === "council" || node.kind === "fusion";
}

function isHostedFusionNode(node: WorkflowNode): node is HostedOpenRouterFusionNode {
  return node.kind === "fusion" && node.fusion.mode === "openrouter-router";
}

export interface DeliberationExecutorDependencies {
  loadStore(storeRef: string): Promise<PersonalityStoreSnapshot>;
  loadStoreSnapshot?(
    storeRef: string,
    digest: string,
    revision: string,
  ): Promise<PersonalityStoreSnapshot>;
}

export function withDeliberationBindings(
  executeNode: WorkflowNodeExecutor,
  dependencies: DeliberationExecutorDependencies = {
    async loadStore(storeRef) {
      const snapshot = await ensurePersonalityStoreInstalled();
      if (snapshot.storeRef !== storeRef) {
        throw new Error(
          `Requested personality store ${storeRef} is not installed (${snapshot.storeRef}).`,
        );
      }
      return snapshot;
    },
    async loadStoreSnapshot(storeRef, digest, revision) {
      return loadPersonalityStoreSnapshot(storeRef, digest, undefined, { revision });
    },
  },
): WorkflowNodeExecutor {
  return async (context: WorkflowNodeExecutorContext) => {
    const effectiveNode = isHostedFusionNode(context.node)
      ? materializeEffectiveHostedFusionNode(context.node)
      : context.node;
    if (!effectiveNode.settings?.deliberation) {
      return executeNode({ ...context, node: effectiveNode });
    }
    if (!isDeliberationNode(effectiveNode)) {
      throw new Error(
        `NodeSpec deliberation is executable only on council, fusion, and best-of-n nodes; received ${String((effectiveNode as WorkflowNode).kind)}.`,
      );
    }
    const storeRef = effectiveNode.settings.deliberation.personalityStoreRef ??
      DEFAULT_PERSONALITY_STORE_REF;
    const durableReceipt = context.deliberationStaffingReceipt;
    let snapshot: PersonalityStoreSnapshot;
    if (durableReceipt) {
      if (storeRef !== durableReceipt.storeRef) {
        throw new Error(
          `Deliberation store ref for run ${context.runId} changed from its receipt.`,
        );
      }
      if (!dependencies.loadStoreSnapshot) {
        throw new Error(
          `Deliberation snapshot ${durableReceipt.storeDigest} required by run ${context.runId} cannot be loaded; refusing to restaff.`,
        );
      }
      try {
        snapshot = await dependencies.loadStoreSnapshot(
          durableReceipt.storeRef,
          durableReceipt.storeDigest,
          durableReceipt.revision,
        );
      } catch (error) {
        throw new Error(
          `Deliberation snapshot ${durableReceipt.storeDigest} required by run ${context.runId} is unavailable; refusing to restaff.`,
          { cause: error },
        );
      }
      assertVerifiedPersonalitySnapshot(snapshot);
      if (
        snapshot.storeRef !== durableReceipt.storeRef ||
        snapshot.source !== durableReceipt.source ||
        snapshot.revision !== durableReceipt.revision ||
        snapshot.digest !== durableReceipt.storeDigest
      ) {
        throw new Error(`Deliberation snapshot for run ${context.runId} does not match its receipt.`);
      }
    } else {
      snapshot = await dependencies.loadStore(storeRef);
      assertVerifiedPersonalitySnapshot(snapshot);
      if (snapshot.storeRef !== storeRef) {
        throw new Error(
          `Requested personality store ${storeRef} is not installed (${snapshot.storeRef}).`,
        );
      }
    }
    const staffing = bindDeliberationStaffing(
      effectiveNode,
      snapshot,
      durableReceipt?.selectedPersonalityRefs,
    );
    const effectivePromptSha256 = effectiveDeliberationPromptSha256(staffing.node);
    if (durableReceipt) {
      if (
        staffing.personalities.map((personality) => personality.ref).join("\0") !==
          durableReceipt.selectedPersonalityRefs.join("\0") ||
        effectivePromptSha256 !== durableReceipt.effectivePromptSha256
      ) {
        throw new Error(`Deliberation staffing for run ${context.runId} changed from its receipt.`);
      }
    } else {
      if (!context.recordDeliberationStaffingReceipt) {
        throw new Error(
          `Run ${context.runId} cannot persist deliberation staffing; refusing ephemeral execution.`,
        );
      }
      const receipt: WorkflowDeliberationStaffingReceipt = {
        storeRef,
        source: snapshot.source,
        revision: snapshot.revision,
        storeDigest: snapshot.digest,
        selectedPersonalityRefs: staffing.personalities.map((personality) => personality.ref),
        effectivePromptSha256,
      };
      context.recordDeliberationStaffingReceipt(receipt);
    }
    return executeNode({
      ...context,
      node: staffing.node,
    });
  };
}
