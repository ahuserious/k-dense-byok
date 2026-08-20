import type { ProjectPaths } from "../projects.ts";
import {
  loadPersonalityStore,
  type ScientificPersonality,
} from "../personality-store/store.ts";
import type {
  WorkflowGraphDocument,
  WorkflowNode,
} from "../workflows/schema.ts";
import {
  WorkflowStore,
  workflowStore,
  type StoredWorkflowDefinitionV1,
} from "../workflows/store.ts";
import {
  findSkillDir,
  globalSkillRoot,
  listProjectSkills,
  projectSkillRoot,
} from "./skills.ts";
import {
  installStagedSkills,
  type InstallStagedOptions,
  type InstallResult,
} from "./skills-install.ts";

export const F11_SKILL_NAMES = [
  "autoresearch-graph-architect",
  "autoresearch-squared",
  "prompt-elevation-to-dag",
  "workflow-supervisor",
  "lean4-prover",
  "create-scientific-agent",
  "infranodus-ontology-creator",
] as const;

export type F11SkillName = (typeof F11_SKILL_NAMES)[number];
export type CuratorSkillMode = "auto" | "auto-manual" | "manual";
export type CuratorWriteMode = "merge" | "replace";
export type CuratorMimeographMode = "auto" | "manual";

export const MAX_CURATED_SKILLS = 64;
export const MAX_CURATED_PERSONALITIES = 32;

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export class SkillCuratorError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillCuratorError";
  }
}

function fail(
  status: SkillCuratorError["status"],
  code: string,
  message: string,
): never {
  throw new SkillCuratorError(status, code, message);
}

function uniqueReferences(
  values: readonly string[],
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(values)) fail(400, "INVALID_REFERENCES", `${label} must be an array.`);
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length > maximum) {
    fail(422, "REFERENCE_CAP_EXCEEDED", `${label} is limited to ${maximum} references.`);
  }
  const invalid = normalized.find((value) => !REFERENCE_RE.test(value));
  if (invalid) {
    fail(
      400,
      "INVALID_REFERENCE",
      `${label} contains an invalid reference. Use 1-256 safe identifier characters.`,
    );
  }
  return normalized;
}

export interface CuratorPersonalityInventory {
  available: boolean;
  storeRef: string | null;
  personalities: Array<Pick<ScientificPersonality, "ref" | "title">>;
  reason: string | null;
}

export function readCuratorPersonalityInventory(): CuratorPersonalityInventory {
  try {
    const snapshot = loadPersonalityStore();
    return {
      available: true,
      storeRef: snapshot.storeRef,
      personalities: snapshot.personalities.map(({ ref, title }) => ({ ref, title })),
      reason: null,
    };
  } catch {
    return {
      available: false,
      storeRef: null,
      personalities: [],
      reason:
        "The reusable personality library is unavailable. Configure the pinned KADY_PERSONALITY_STORE_REPO, KADY_PERSONALITY_STORE_COMMIT, and KADY_PERSONALITY_STORE_MANIFEST_SHA256 names before selecting council heads.",
    };
  }
}

export interface CuratorSkillInventoryEntry {
  ref: string;
  description: string;
  scope: "project" | "global";
  featured: boolean;
}

export function listCuratorSkills(paths: ProjectPaths): CuratorSkillInventoryEntry[] {
  const project = projectSkillRoot(paths);
  const global = globalSkillRoot();
  const byName = new Map<string, CuratorSkillInventoryEntry>();
  for (const skill of listProjectSkills(global)) {
    byName.set(skill.name, {
      ref: skill.name,
      description: skill.description,
      scope: "global",
      featured: F11_SKILL_NAMES.includes(skill.name as F11SkillName),
    });
  }
  // Project skills shadow global skills in Pi, so they overwrite the map.
  for (const skill of listProjectSkills(project)) {
    byName.set(skill.name, {
      ref: skill.name,
      description: skill.description,
      scope: "project",
      featured: F11_SKILL_NAMES.includes(skill.name as F11SkillName),
    });
  }
  return [...byName.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

export interface CuratorNodeStatus {
  id: string;
  name: string;
  kind: WorkflowNode["kind"];
  skillsMode: CuratorSkillMode;
  skillRefs: string[];
  mimeographsMode: CuratorMimeographMode;
  personalityRefs: string[];
}

function nodeStatus(node: WorkflowNode): CuratorNodeStatus {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    skillsMode: node.settings?.skills?.mode ?? "auto",
    skillRefs: [...(node.settings?.skills?.list ?? [])],
    mimeographsMode: node.settings?.deliberation?.mimeographs?.mode ?? "auto",
    personalityRefs: [
      ...(node.settings?.deliberation?.mimeographs?.personalityRefs ?? []),
    ],
  };
}

export interface SkillCuratorSnapshot {
  definition: StoredWorkflowDefinitionV1;
  skills: CuratorSkillInventoryEntry[];
  personalities: CuratorPersonalityInventory;
  nodes: CuratorNodeStatus[];
}

export function readSkillCuratorSnapshot(
  projectId: string,
  paths: ProjectPaths,
  workflowId: string,
  store: WorkflowStore = workflowStore,
): SkillCuratorSnapshot {
  const definition = store.readDefinition(projectId, workflowId);
  if (!definition) {
    fail(404, "WORKFLOW_NOT_FOUND", `No saved workflow named "${workflowId}" exists.`);
  }
  return {
    definition,
    skills: listCuratorSkills(paths),
    personalities: readCuratorPersonalityInventory(),
    nodes: definition.graph.nodes.map(nodeStatus),
  };
}

export interface SkillCurationInput {
  expectedRevision: number;
  nodeIds: string[];
  skillRefs: string[];
  skillsMode: CuratorSkillMode;
  writeMode?: CuratorWriteMode;
  mimeographs?: {
    mode: CuratorMimeographMode;
    personalityRefs: string[];
  };
  install?: InstallStagedOptions;
}

export interface SkillCurationResult {
  outcome: "unchanged" | "updated";
  definition: StoredWorkflowDefinitionV1;
  installed: InstallResult | null;
  attached: {
    nodeIds: string[];
    skillRefs: string[];
    personalityRefs: string[];
  };
}

export interface SkillCurationDependencies {
  store?: WorkflowStore;
  install?: typeof installStagedSkills;
  personalityInventory?: () => CuratorPersonalityInventory;
}

function ensureSkillsAreLoaded(paths: ProjectPaths, skillRefs: readonly string[]): void {
  const project = projectSkillRoot(paths);
  const global = globalSkillRoot();
  const missing = skillRefs.filter(
    (ref) => !findSkillDir(project, ref) && !findSkillDir(global, ref),
  );
  if (missing.length > 0) {
    fail(
      422,
      "SKILL_NOT_LOADED",
      `Install and enable these skills before attaching them: ${missing.join(", ")}.`,
    );
  }
}

function applyNodeCuration(
  node: WorkflowNode,
  input: {
    skillRefs: string[];
    skillsMode: CuratorSkillMode;
    writeMode: CuratorWriteMode;
    mimeographs?: {
      mode: CuratorMimeographMode;
      personalityRefs: string[];
    };
  },
): WorkflowNode {
  const existingSkillRefs = node.settings?.skills?.list ?? [];
  const skillRefs = input.writeMode === "replace"
    ? input.skillRefs
    : uniqueReferences(
      [...existingSkillRefs, ...input.skillRefs],
      "Node skill list",
      MAX_CURATED_SKILLS,
    );
  const settings = {
    ...(node.settings ?? {}),
    skills: {
      ...(node.settings?.skills ?? {}),
      mode: input.skillsMode,
      list: skillRefs,
    },
  };

  if (input.mimeographs) {
    const currentDeliberation = node.settings?.deliberation ?? {};
    settings.deliberation = {
      ...currentDeliberation,
      ...(input.mimeographs.mode === "manual"
        ? { bestOfNPersonalityCount: input.mimeographs.personalityRefs.length }
        : {}),
      mimeographs: {
        ...(currentDeliberation.mimeographs ?? {}),
        mode: input.mimeographs.mode,
        personalityRefs:
          input.mimeographs.mode === "manual" ? input.mimeographs.personalityRefs : [],
      },
    };
  }

  return { ...node, settings } as WorkflowNode;
}

export async function applySkillCuration(
  projectId: string,
  paths: ProjectPaths,
  workflowId: string,
  input: SkillCurationInput,
  dependencies: SkillCurationDependencies = {},
): Promise<SkillCurationResult> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail(400, "INVALID_REVISION", "expectedRevision must be a positive safe integer.");
  }
  const nodeIds = uniqueReferences(input.nodeIds, "Node ids", MAX_CURATED_SKILLS);
  if (nodeIds.length === 0) {
    fail(400, "NO_TARGET_NODES", "Select at least one workflow node.");
  }
  const skillRefs = uniqueReferences(input.skillRefs, "Skill list", MAX_CURATED_SKILLS);
  if (!["auto", "auto-manual", "manual"].includes(input.skillsMode)) {
    fail(400, "INVALID_SKILL_MODE", "skillsMode must be auto, auto-manual, or manual.");
  }
  const writeMode = input.writeMode ?? "merge";
  if (writeMode !== "merge" && writeMode !== "replace") {
    fail(400, "INVALID_WRITE_MODE", "writeMode must be merge or replace.");
  }

  const personalityRefs = input.mimeographs
    ? uniqueReferences(
      input.mimeographs.personalityRefs,
      "Personality list",
      MAX_CURATED_PERSONALITIES,
    )
    : [];
  if (
    input.mimeographs &&
    input.mimeographs.mode !== "auto" &&
    input.mimeographs.mode !== "manual"
  ) {
    fail(400, "INVALID_MIMEOGRAPH_MODE", "Mimeograph mode must be auto or manual.");
  }
  if (input.mimeographs?.mode === "manual" && personalityRefs.length === 0) {
    fail(400, "NO_PERSONALITIES", "Manual mimeograph mode requires at least one personality.");
  }
  if (input.mimeographs?.mode === "auto" && personalityRefs.length > 0) {
    fail(400, "AUTO_PERSONALITIES", "Auto mimeograph mode cannot name manual personalities.");
  }
  if (input.mimeographs?.mode === "manual") {
    const inventory = (dependencies.personalityInventory ?? readCuratorPersonalityInventory)();
    if (!inventory.available) {
      fail(422, "PERSONALITY_LIBRARY_UNAVAILABLE", inventory.reason ?? "Personality library unavailable.");
    }
    const available = new Set(inventory.personalities.map((personality) => personality.ref));
    const missing = personalityRefs.filter((ref) => !available.has(ref));
    if (missing.length > 0) {
      fail(
        422,
        "PERSONALITY_NOT_FOUND",
        `The reusable personality library does not contain: ${missing.join(", ")}.`,
      );
    }
  }

  const store = dependencies.store ?? workflowStore;
  const current = store.readDefinition(projectId, workflowId);
  if (!current) {
    fail(404, "WORKFLOW_NOT_FOUND", `No saved workflow named "${workflowId}" exists.`);
  }
  const knownNodes = new Set(current.graph.nodes.map((node) => node.id));
  const unknownNode = nodeIds.find((id) => !knownNodes.has(id));
  if (unknownNode) {
    fail(404, "NODE_NOT_FOUND", `Workflow "${workflowId}" has no node named "${unknownNode}".`);
  }

  let installed: InstallResult | null = null;
  if (input.install) {
    installed = await (dependencies.install ?? installStagedSkills)(paths, input.install);
  }
  ensureSkillsAreLoaded(paths, skillRefs);

  const targets = new Set(nodeIds);
  const nextGraph: WorkflowGraphDocument = {
    ...structuredClone(current.graph),
    nodes: current.graph.nodes.map((node) =>
      targets.has(node.id)
        ? applyNodeCuration(node, {
          skillRefs,
          skillsMode: input.skillsMode,
          writeMode,
          ...(input.mimeographs
            ? {
              mimeographs: {
                mode: input.mimeographs.mode,
                personalityRefs,
              },
            }
            : {}),
        })
        : structuredClone(node)
    ),
  };

  const saved = store.saveDefinitionWithIntent(
    projectId,
    workflowId,
    nextGraph,
    { kind: "update", expectedRevision: input.expectedRevision },
  );
  const readBack = store.readDefinition(projectId, workflowId);
  if (!readBack || readBack.revision !== saved.definition.revision) {
    fail(409, "WORKFLOW_READBACK_FAILED", "The saved workflow could not be read back at its new revision.");
  }

  return {
    outcome: saved.outcome === "unchanged" ? "unchanged" : "updated",
    definition: readBack,
    installed,
    attached: {
      nodeIds,
      skillRefs,
      personalityRefs,
    },
  };
}
