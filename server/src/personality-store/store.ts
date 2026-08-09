import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KADY_PERSONALITY_STORE_DIR,
  KADY_PI_AGENT_DIR,
  PERSONALITY_STORE_COMMIT,
  PERSONALITY_STORE_MANIFEST_SHA256,
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

export interface PersonalitySourcePin {
  source: string;
  commit: string;
  manifestSha256: string;
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

export function personalityContentManifestDigest(
  personalities: readonly ScientificPersonality[],
): string {
  const manifest = personalities.map((personality) => ({
    ref: personality.ref,
    title: personality.title,
    instructions: personality.instructions,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function configuredPersonalitySourcePin(): PersonalitySourcePin {
  const pin = {
    source: PERSONALITY_STORE_REPO.trim(),
    commit: PERSONALITY_STORE_COMMIT,
    manifestSha256: PERSONALITY_STORE_MANIFEST_SHA256,
  };
  if (
    !pin.source ||
    !/^[a-f0-9]{40}$/.test(pin.commit) ||
    !/^[a-f0-9]{64}$/.test(pin.manifestSha256)
  ) {
    throw new Error(
      "Personality source is not pinned: configure an immutable 40-hex commit and 64-hex content-manifest SHA-256.",
    );
  }
  return pin;
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
  pin?: PersonalitySourcePin;
  storeDir?: string;
  storeRef?: string;
}): PersonalityStoreSnapshot {
  const storeDir = path.resolve(options.storeDir ?? KADY_PERSONALITY_STORE_DIR);
  assertPersonalityStoreIsPiInvisible(storeDir);
  const storeRef = options.storeRef ?? DEFAULT_PERSONALITY_STORE_REF;
  const pin = options.pin ?? configuredPersonalitySourcePin();
  if (
    !pin.source.trim() ||
    !/^[a-f0-9]{40}$/.test(pin.commit) ||
    !/^[a-f0-9]{64}$/.test(pin.manifestSha256)
  ) {
    throw new Error("Personality source pin is malformed.");
  }
  const personalities = readScientificPersonalities(options.sourceDir);
  const digest = personalityContentManifestDigest(personalities);
  if (digest !== pin.manifestSha256) {
    throw new Error(
      `Personality content-manifest digest mismatch: expected ${pin.manifestSha256}, received ${digest}.`,
    );
  }
  const snapshot: PersonalityStoreSnapshot = {
    schemaVersion: STORE_SCHEMA_VERSION,
    storeRef,
    source: pin.source,
    revision: pin.commit,
    digest,
    personalities,
  };
  const snapshotPath = path.join(storeDir, "snapshots", `${digest}-${pin.commit}.json`);
  if (fs.existsSync(snapshotPath)) {
    loadPersonalityStoreSnapshot(storeRef, digest, storeDir, {
      source: pin.source,
      revision: pin.commit,
      refs: personalities.map((personality) => personality.ref),
    });
  } else {
    writeJsonAtomic(snapshotPath, snapshot);
  }
  const pointer: PersonalityStorePointer = {
    schemaVersion: STORE_SCHEMA_VERSION,
    storeRef,
    source: pin.source,
    revision: pin.commit,
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
    typeof pointer.revision !== "string" || !/^[a-f0-9]{40}$/.test(pointer.revision) ||
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
  pin: PersonalitySourcePin = configuredPersonalitySourcePin(),
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
  if (
    pointer.source !== pin.source ||
    pointer.revision !== pin.commit ||
    pointer.digest !== pin.manifestSha256
  ) {
    throw new Error("Installed personality store does not match the configured immutable source pin.");
  }
  return loadPersonalityStoreSnapshot(storeRef, pointer.digest, storeDir, {
    source: pointer.source,
    revision: pointer.revision,
    refs: pointer.refs,
  });
}

export function loadPersonalityStoreSnapshot(
  storeRef: string,
  digest: string,
  storeDir = KADY_PERSONALITY_STORE_DIR,
  expected?: { source?: string; revision?: string; refs?: readonly string[] },
): PersonalityStoreSnapshot {
  assertPersonalityStoreIsPiInvisible(storeDir);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Personality snapshot digest is malformed: ${digest}.`);
  }
  if (!expected?.revision || !/^[a-f0-9]{40}$/.test(expected.revision)) {
    throw new Error("Personality snapshot lookup requires its immutable 40-hex revision.");
  }
  const snapshotPath = path.join(
    storeDir,
    "snapshots",
    `${digest}-${expected.revision}.json`,
  );
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Personality snapshot ${digest} is unavailable.`);
  }
  const snapshot = JSON.parse(fs.readFileSync(
    snapshotPath,
    "utf8",
  )) as PersonalityStoreSnapshot;
  const personalitiesAreValid = Array.isArray(snapshot.personalities) &&
    snapshot.personalities.every((personality) =>
      personality && typeof personality === "object" &&
      typeof personality.ref === "string" &&
      typeof personality.title === "string" &&
      typeof personality.instructions === "string"
    );
  if (
    snapshot.schemaVersion !== STORE_SCHEMA_VERSION ||
    snapshot.storeRef !== storeRef || snapshot.digest !== digest ||
    typeof snapshot.source !== "string" || !snapshot.source.trim() ||
    !/^[a-f0-9]{40}$/.test(snapshot.revision) ||
    (expected?.source !== undefined && snapshot.source !== expected.source) ||
    (expected?.revision !== undefined && snapshot.revision !== expected.revision) ||
    !personalitiesAreValid ||
    personalityContentManifestDigest(snapshot.personalities) !== digest ||
    (expected?.refs !== undefined &&
      snapshot.personalities.map((personality) => personality.ref).join("\0") !==
        expected.refs.join("\0"))
  ) {
    throw new Error("Personality store snapshot failed its content-addressed verification.");
  }
  return structuredClone(snapshot);
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    let output = "";
    let errorText = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 4_096) output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (errorText.length < 4_096) errorText += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(errorText.trim() || `git exited with status ${code}`));
    });
  });
}

async function cloneRemoteSource(target: string, pin: PersonalitySourcePin): Promise<void> {
  const source = pin.source.includes("://")
    ? pin.source
    : `https://github.com/${pin.source}.git`;
  await runGit(["init", "--quiet", target]);
  await runGit(["-C", target, "fetch", "--quiet", "--depth", "1", source, pin.commit]);
  await runGit(["-C", target, "checkout", "--quiet", "--detach", pin.commit]);
  const checkedOutCommit = await runGit(["-C", target, "rev-parse", "HEAD"]);
  if (checkedOutCommit !== pin.commit) {
    throw new Error("Personality checkout did not resolve to the configured immutable commit.");
  }
}

let installationPromise: Promise<PersonalityStoreSnapshot> | undefined;

/** Install the server-only profile store on first deliberation use. */
export async function ensurePersonalityStoreInstalled(): Promise<PersonalityStoreSnapshot> {
  const pin = configuredPersonalitySourcePin();
  try {
    return loadPersonalityStore(DEFAULT_PERSONALITY_STORE_REF, KADY_PERSONALITY_STORE_DIR, pin);
  } catch (error) {
    if (error instanceof Error && /overlaps Pi-visible root|\.pi directory/.test(error.message)) {
      throw error;
    }
  }
  installationPromise ??= (async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-personalities-"));
    const checkout = path.join(temporaryRoot, "source");
    try {
      await cloneRemoteSource(checkout, pin);
      return installPersonalityStoreFromDirectory({ sourceDir: checkout, pin });
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
