import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KADY_PERSONALITY_STORE_DIR,
  KADY_PI_AGENT_DIR,
  PERSONALITY_STORE_BRANCH,
  PERSONALITY_STORE_REPO,
  PROJECTS_ROOT,
} from "../config.ts";
import { apiRelative } from "../sandbox-fs.ts";

export const DEFAULT_PERSONALITY_STORE_REF = "scientific-agents/v1";
const STORE_SCHEMA_VERSION = 1;
const MAX_PERSONALITIES = 2_048;
const MAX_PERSONALITY_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1_000;

export interface ScientificPersonality {
  ref: string;
  title: string;
  instructions: string;
}

export interface PersonalityStoreSnapshot {
  schemaVersion: 1;
  storeRef: string;
  source: string;
  revision: string;
  digest: string;
  personalities: ScientificPersonality[];
}

interface PersonalityStorePointer {
  schemaVersion: 1;
  storeRef: string;
  source: string;
  revision: string;
  digest: string;
  refs: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = apiRelative(path.resolve(root), path.resolve(candidate));
  return relative === "" ||
    (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Pi discovers global files below its agent directory and project files from
 * project sandboxes. A personality store under either root could be loaded as
 * ambient Pi context, so configuration fails closed before any installation.
 */
export function assertPersonalityStoreIsPiInvisible(
  storeDir = KADY_PERSONALITY_STORE_DIR,
  piVisibleRoots: readonly string[] = [KADY_PI_AGENT_DIR, PROJECTS_ROOT],
): void {
  const resolvedStore = path.resolve(storeDir);
  if (resolvedStore.split(path.sep).includes(".pi")) {
    throw new Error("The personality store cannot be installed in a .pi directory.");
  }
  for (const root of piVisibleRoots) {
    if (isWithin(root, resolvedStore) || isWithin(resolvedStore, root)) {
      throw new Error(
        `The personality store ${resolvedStore} overlaps Pi-visible root ${path.resolve(root)}.`,
      );
    }
  }
}

function normalizePersonalityRef(relativeDirectory: string): string | undefined {
  const normalized = relativeDirectory.split(path.sep).join("/")
    .replace(/^scientific-agents\//, "")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!normalized || normalized.length > 256) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ? normalized : undefined;
}

function personalityTitle(ref: string, instructions: string): string {
  const heading = instructions.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || ref.split("/").at(-1) || ref).slice(0, 256);
}

function collectPersonalityFiles(
  root: string,
  current = root,
  files: string[] = [],
): string[] {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectPersonalityFiles(root, entryPath, files);
    } else if (entry.isFile() && entry.name === "AGENTS.md") {
      files.push(entryPath);
      if (files.length > MAX_PERSONALITIES) {
        throw new Error(`Personality source exceeds ${MAX_PERSONALITIES} profiles.`);
      }
    }
  }
  return files;
}

export function readScientificPersonalities(sourceDir: string): ScientificPersonality[] {
  const sourceRoot = fs.realpathSync(sourceDir);
  const conventionalProfileRoot = path.join(sourceRoot, "scientific-agents");
  const profileRoot = fs.existsSync(conventionalProfileRoot) &&
      fs.statSync(conventionalProfileRoot).isDirectory()
    ? fs.realpathSync(conventionalProfileRoot)
    : sourceRoot;
  if (!isWithin(sourceRoot, profileRoot)) {
    throw new Error("Personality profile root escapes its source checkout.");
  }
  const personalities: ScientificPersonality[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const profilePath of collectPersonalityFiles(profileRoot).sort()) {
    const realProfilePath = fs.realpathSync(profilePath);
    if (!isWithin(profileRoot, realProfilePath)) {
      throw new Error(`Personality profile escapes its source root: ${profilePath}`);
    }
    const size = fs.statSync(realProfilePath).size;
    if (size < 1 || size > MAX_PERSONALITY_BYTES) {
      throw new Error(`Personality profile has an invalid size: ${profilePath}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_STORE_BYTES) {
      throw new Error(`Personality source exceeds ${MAX_STORE_BYTES} bytes.`);
    }
    const ref = normalizePersonalityRef(apiRelative(profileRoot, path.dirname(profilePath)));
    if (!ref || seen.has(ref)) {
      throw new Error(`Personality source has an invalid or duplicate ref: ${String(ref)}`);
    }
    seen.add(ref);
    const instructions = fs.readFileSync(realProfilePath, "utf8").trim();
    if (!instructions) throw new Error(`Personality profile is empty: ${profilePath}`);
    personalities.push({
      ref,
      title: personalityTitle(ref, instructions),
      instructions,
    });
  }
  if (personalities.length === 0) {
    throw new Error("Personality source contains no AGENTS.md profiles.");
  }
  return personalities;
}

function digestPersonalities(personalities: readonly ScientificPersonality[]): string {
  const hash = crypto.createHash("sha256");
  for (const personality of personalities) {
    hash.update(personality.ref).update("\0");
    hash.update(personality.title).update("\0");
    hash.update(personality.instructions).update("\0");
  }
  return hash.digest("hex");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

export function installPersonalityStoreFromDirectory(options: {
  sourceDir: string;
  source?: string;
  revision?: string;
  storeDir?: string;
  storeRef?: string;
}): PersonalityStoreSnapshot {
  const storeDir = path.resolve(options.storeDir ?? KADY_PERSONALITY_STORE_DIR);
  assertPersonalityStoreIsPiInvisible(storeDir);
  const storeRef = options.storeRef ?? DEFAULT_PERSONALITY_STORE_REF;
  const source = options.source ?? PERSONALITY_STORE_REPO;
  const revision = options.revision ?? PERSONALITY_STORE_BRANCH;
  const personalities = readScientificPersonalities(options.sourceDir);
  const digest = digestPersonalities(personalities);
  const snapshot: PersonalityStoreSnapshot = {
    schemaVersion: STORE_SCHEMA_VERSION,
    storeRef,
    source,
    revision,
    digest,
    personalities,
  };
  const snapshotPath = path.join(storeDir, "snapshots", `${digest}.json`);
  if (!fs.existsSync(snapshotPath)) writeJsonAtomic(snapshotPath, snapshot);
  const pointer: PersonalityStorePointer = {
    schemaVersion: STORE_SCHEMA_VERSION,
    storeRef,
    source,
    revision,
    digest,
    refs: personalities.map((personality) => personality.ref),
  };
  writeJsonAtomic(path.join(storeDir, "current.json"), pointer);
  return structuredClone(snapshot);
}

function parsePointer(value: unknown): PersonalityStorePointer {
  const pointer = value as Partial<PersonalityStorePointer>;
  if (
    !pointer || pointer.schemaVersion !== STORE_SCHEMA_VERSION ||
    typeof pointer.storeRef !== "string" || typeof pointer.source !== "string" ||
    typeof pointer.revision !== "string" ||
    typeof pointer.digest !== "string" || !/^[a-f0-9]{64}$/.test(pointer.digest) ||
    !Array.isArray(pointer.refs) || pointer.refs.some((ref) => typeof ref !== "string")
  ) {
    throw new Error("Personality store pointer is malformed.");
  }
  return pointer as PersonalityStorePointer;
}

export function loadPersonalityStore(
  storeRef = DEFAULT_PERSONALITY_STORE_REF,
  storeDir = KADY_PERSONALITY_STORE_DIR,
): PersonalityStoreSnapshot {
  assertPersonalityStoreIsPiInvisible(storeDir);
  const pointer = parsePointer(JSON.parse(
    fs.readFileSync(path.join(storeDir, "current.json"), "utf8"),
  ));
  if (pointer.storeRef !== storeRef) {
    throw new Error(
      `Personality store ref ${storeRef} is unavailable; installed ref is ${pointer.storeRef}.`,
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(storeDir, "snapshots", `${pointer.digest}.json`),
    "utf8",
  )) as PersonalityStoreSnapshot;
  if (
    snapshot.schemaVersion !== STORE_SCHEMA_VERSION ||
    snapshot.storeRef !== pointer.storeRef || snapshot.source !== pointer.source ||
    snapshot.revision !== pointer.revision || snapshot.digest !== pointer.digest ||
    !Array.isArray(snapshot.personalities) ||
    digestPersonalities(snapshot.personalities) !== pointer.digest ||
    snapshot.personalities.map((personality) => personality.ref).join("\0") !==
      pointer.refs.join("\0")
  ) {
    throw new Error("Personality store snapshot does not match its atomic pointer.");
  }
  return structuredClone(snapshot);
}

function cloneRemoteSource(target: string): Promise<void> {
  const source = PERSONALITY_STORE_REPO.includes("://")
    ? PERSONALITY_STORE_REPO
    : `https://github.com/${PERSONALITY_STORE_REPO}.git`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["clone", "--depth", "1", "--branch", PERSONALITY_STORE_BRANCH, source, target],
      { stdio: ["ignore", "ignore", "pipe"], timeout: GIT_TIMEOUT_MS },
    );
    let errorText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (errorText.length < 4_096) errorText += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || `git clone exited with status ${code}`));
    });
  });
}

let installationPromise: Promise<PersonalityStoreSnapshot> | undefined;

/** Install the server-only profile store on first deliberation use. */
export async function ensurePersonalityStoreInstalled(): Promise<PersonalityStoreSnapshot> {
  try {
    return loadPersonalityStore();
  } catch (error) {
    if (error instanceof Error && /overlaps Pi-visible root|\.pi directory/.test(error.message)) {
      throw error;
    }
  }
  installationPromise ??= (async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-personalities-"));
    const checkout = path.join(temporaryRoot, "source");
    try {
      await cloneRemoteSource(checkout);
      return installPersonalityStoreFromDirectory({ sourceDir: checkout });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  })().finally(() => {
    installationPromise = undefined;
  });
  return installationPromise;
}

function taskTerms(text: string): Set<string> {
  const terms = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const normalized = terms
    .filter((term) =>
      !["the", "and", "for", "with", "from", "that", "this", "into"].includes(term)
    )
    .map((term) => {
      if (term.endsWith("omics") && term.length > 5) return `${term.slice(0, -5)}ome`;
      if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
      if (term.endsWith("s") && !term.endsWith("ss") && term.length > 4) {
        return term.slice(0, -1);
      }
      return term;
    });
  return new Set(normalized);
}

/** Deterministic content match; ties use the stable personality ref. */
export function selectBestPersonalities(
  task: string,
  count: number,
  snapshot: PersonalityStoreSnapshot,
  allowedRefs?: readonly string[],
): ScientificPersonality[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) {
    throw new Error("Personality selection count must be an integer from 1 through 32.");
  }
  const allowed = allowedRefs ? new Set(allowedRefs) : undefined;
  const candidates = snapshot.personalities.filter((personality) =>
    allowed ? allowed.has(personality.ref) : true
  );
  if (allowed && candidates.length !== allowed.size) {
    const known = new Set(candidates.map((personality) => personality.ref));
    const missing = [...allowed].filter((ref) => !known.has(ref));
    throw new Error(`Unknown personality refs: ${missing.join(", ")}.`);
  }
  if (candidates.length < count) {
    throw new Error(
      `Personality store has ${candidates.length} eligible profiles, fewer than requested ${count}.`,
    );
  }
  const terms = taskTerms(task);
  return candidates
    .map((personality) => {
      const identityTerms = taskTerms(`${personality.ref} ${personality.title}`);
      const instructionTerms = taskTerms(personality.instructions.slice(0, 32_768));
      let score = 0;
      for (const term of terms) {
        if (identityTerms.has(term)) score += 8;
        if (instructionTerms.has(term)) score += 1;
      }
      return { personality, score };
    })
    .sort((left, right) =>
      right.score - left.score || left.personality.ref.localeCompare(right.personality.ref)
    )
    .slice(0, count)
    .map(({ personality }) => structuredClone(personality));
}
