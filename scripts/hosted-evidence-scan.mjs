#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  collectSecretByteRepresentations,
  findSecretRepresentation,
  scrubAndVerifyText,
} from "./hosted-evidence-secrets.mjs";

const MANIFEST_FILE_NAME = "hosted-evidence-manifest.json";
const PAYLOAD_ARCHIVE_NAME = "hosted-evidence-payload.tar";
export const HOSTED_EVIDENCE_BUNDLE_NAME = "hosted-evidence-bundle.tar";
export const MAX_ARCHIVE_DEPTH = 4;
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;

const PAYLOAD_ARTIFACTS = [
  { path: ".stably/test-results", required: true },
  { path: "stably-install.log", required: true },
  { path: "browser-install-method.txt", required: true },
  { path: "preview-up.scrubbed.log", required: true },
  { path: "stably-test.scrubbed.log", required: true },
  { path: "runner-fingerprint.json", required: true },
  { path: "playwright-report", required: false },
  { path: "test-results", required: false },
  { path: "playwright-install.log", required: false },
];

export const HOSTED_EVIDENCE_ARTIFACT_PATHS = PAYLOAD_ARTIFACTS.map(
  ({ path: artifactPath }) => artifactPath,
);

const UNSUPPORTED_COMPRESSION_SIGNATURES = [
  { name: "bz2", magic: Buffer.from("BZh", "ascii") },
  { name: "xz", magic: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { name: "7z", magic: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: "rar", magic: Buffer.from("Rar!\x1a\x07", "binary") },
  { name: "zstd", magic: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) },
];

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function artifactReference(index, artifactPath) {
  return `artifact[${index}]#${sha256Bytes(Buffer.from(artifactPath)).slice(0, 12)}`;
}

function nestedArtifactReference(parentReference, index, entryName) {
  const nameHash = sha256Bytes(Buffer.from(entryName)).slice(0, 12);
  return `${parentReference}/entry[${index}]#${nameHash}`;
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function archiveKind(bytes) {
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  ) {
    return "zip";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "gzip";
  }
  if (bytes.length >= 262 && bytes.subarray(257, 262).toString("ascii") === "ustar") {
    return "tar";
  }
  if (
    UNSUPPORTED_COMPRESSION_SIGNATURES.some((signature) =>
      bytes.subarray(0, signature.magic.length).equals(signature.magic),
    )
  ) {
    return "unsupported";
  }
  return null;
}

function warningKind(message) {
  if (message.startsWith("malformed percent")) return "malformed-percent";
  if (message.startsWith("invalid UTF-8")) return "invalid-utf8";
  if (message.startsWith("unknown binary")) return "unknown-binary";
  return message;
}

function emitWarning(message, context) {
  const kind = warningKind(message);
  const key = `${context.topLevelRef}:${kind}`;
  if (context.emittedWarnings.has(key)) return;
  context.emittedWarnings.add(key);
  process.stderr.write(`hosted-evidence: WARN: ${message}\n`);
}

function searchBytes(bytes, artifactRef, byteRepresentations, context) {
  const warnings = [];
  const found = findSecretRepresentation(
    bytes,
    byteRepresentations,
    artifactRef,
    warnings,
  );
  for (const warning of warnings) emitWarning(warning, context);
  if (found) {
    throw new Error(`secret representation detected in ${artifactRef}`);
  }
}

function validateArchiveEntries(entries, artifactRef, byteRepresentations, context) {
  for (const [index, entry] of entries.entries()) {
    const entryReference = nestedArtifactReference(artifactRef, index, entry);
    searchBytes(Buffer.from(entry, "utf8"), entryReference, byteRepresentations, context);
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`unreadable member in ${entryReference}`);
    }
  }
}

function accountDecompressedBytes(size, artifactRef, context) {
  context.decompressedBytes += size;
  if (context.decompressedBytes > context.maxDecompressedBytes) {
    throw new Error(
      `decompressed-bytes bound exceeded for ${artifactRef}: ` +
        `bound=${context.maxDecompressedBytes} observed=${context.decompressedBytes}`,
    );
  }
}

function extractZipOrTar(archivePath, kind, artifactRef, byteRepresentations, context) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-evidence-scan-"),
  );
  try {
    const listCommand = kind === "zip"
      ? ["unzip", ["-Z1", archivePath]]
      : ["tar", ["-tf", archivePath]];
    const listed = spawnSync(listCommand[0], listCommand[1], { encoding: "utf8" });
    if (listed.status !== 0) throw new Error(`unreadable member in ${artifactRef}`);
    const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries, artifactRef, byteRepresentations, context);

    const extractCommand = kind === "zip"
      ? ["unzip", ["-qq", archivePath, "-d", temporaryDirectory]]
      : ["tar", ["-xf", archivePath, "-C", temporaryDirectory]];
    const extracted = spawnSync(extractCommand[0], extractCommand[1], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) throw new Error(`unreadable member in ${artifactRef}`);
    scanExtractedTree(
      temporaryDirectory,
      artifactRef,
      byteRepresentations,
      context,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function extractGzip(bytes, artifactRef, byteRepresentations, context) {
  let decompressed;
  try {
    decompressed = zlib.gunzipSync(bytes);
  } catch {
    throw new Error(`unreadable member in ${artifactRef}`);
  }
  accountDecompressedBytes(decompressed.length, artifactRef, context);
  inspectBytes(
    decompressed,
    `${artifactRef}/gzip`,
    byteRepresentations,
    context,
  );
}

function scanExtractedTree(rootDirectory, artifactRef, byteRepresentations, context) {
  const stack = [[rootDirectory, artifactRef]];
  while (stack.length > 0) {
    const [currentDirectory, parentReference] = stack.pop();
    const entries = fs.readdirSync(currentDirectory).sort();
    for (const [index, entry] of entries.entries()) {
      const entryReference = nestedArtifactReference(parentReference, index, entry);
      const entryPath = path.join(currentDirectory, entry);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`unreadable member in ${entryReference}`);
      }
      searchBytes(Buffer.from(entry, "utf8"), entryReference, byteRepresentations, context);
      if (stat.isDirectory()) {
        stack.push([entryPath, entryReference]);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`unreadable member in ${entryReference}`);
      }
      accountDecompressedBytes(stat.size, entryReference, context);
      const bytes = fs.readFileSync(entryPath);
      inspectBytes(bytes, entryReference, byteRepresentations, context);
    }
  }
}

function inspectBytes(
  bytes,
  artifactRef,
  byteRepresentations,
  context,
  existingArchivePath = null,
) {
  searchBytes(bytes, artifactRef, byteRepresentations, context);
  const kind = archiveKind(bytes);
  if (kind === "unsupported") {
    throw new Error(`unsupported compressed member in ${artifactRef}`);
  }
  if (kind === null) return;
  if (context.depth >= MAX_ARCHIVE_DEPTH) return;

  const nestedContext = {
    ...context,
    depth: context.depth + 1,
    collectDigests: false,
  };
  if (kind === "gzip") {
    extractGzip(bytes, artifactRef, byteRepresentations, nestedContext);
    return;
  }

  if (existingArchivePath) {
    extractZipOrTar(
      existingArchivePath,
      kind,
      artifactRef,
      byteRepresentations,
      nestedContext,
    );
    return;
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-evidence-archive-"),
  );
  const temporaryArchive = path.join(
    temporaryDirectory,
    kind === "zip" ? "archive.zip" : "archive.tar",
  );
  try {
    fs.writeFileSync(temporaryArchive, bytes);
    extractZipOrTar(
      temporaryArchive,
      kind,
      artifactRef,
      byteRepresentations,
      nestedContext,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function scanPath(filePath, relativePath, artifactRef, byteRepresentations, context) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`unreadable member in ${artifactRef}`);
  }
  if (stat.isDirectory()) {
    for (const [index, entry] of fs.readdirSync(filePath).sort().entries()) {
      const entryReference = nestedArtifactReference(artifactRef, index, entry);
      searchBytes(Buffer.from(entry, "utf8"), entryReference, byteRepresentations, context);
      scanPath(
        path.join(filePath, entry),
        path.join(relativePath, entry),
        entryReference,
        byteRepresentations,
        context,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unreadable member in ${artifactRef}`);
  }

  const bytes = fs.readFileSync(filePath);
  if (context.collectDigests) {
    context.digests.push({
      path: toPosixPath(relativePath),
      sha256: sha256Bytes(bytes),
    });
  }
  inspectBytes(bytes, artifactRef, byteRepresentations, context, filePath);
}

function normalizeArtifactSpecs(artifactPaths) {
  return artifactPaths.map((artifact, index) =>
    typeof artifact === "string"
      ? { path: artifact, required: true, index }
      : { ...artifact, index },
  );
}

function createScanContext({
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
  collectDigests = false,
} = {}) {
  return {
    depth: 0,
    decompressedBytes: 0,
    maxDecompressedBytes,
    collectDigests,
    digests: [],
    topLevelRef: "",
    emittedWarnings: new Set(),
  };
}

export function scanHostedEvidenceArtifacts({
  workingDirectory = process.cwd(),
  environment = process.env,
  artifactPaths = PAYLOAD_ARTIFACTS,
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
  collectDigests = false,
} = {}) {
  const byteRepresentations = collectSecretByteRepresentations(environment);
  const includedPaths = [];
  const context = createScanContext({ maxDecompressedBytes, collectDigests });
  for (const artifact of normalizeArtifactSpecs(artifactPaths)) {
    const artifactRef = artifactReference(artifact.index, artifact.path);
    const resolvedPath = path.resolve(workingDirectory, artifact.path);
    if (!fs.existsSync(resolvedPath)) {
      if (artifact.required) throw new Error(`required ${artifactRef} is missing`);
      continue;
    }
    context.topLevelRef = artifactRef;
    scanPath(
      resolvedPath,
      artifact.path,
      artifactRef,
      byteRepresentations,
      context,
    );
    includedPaths.push(artifact.path);
  }
  return { includedPaths, artifactDigests: context.digests };
}

function createTar(workingDirectory, archiveName, entries) {
  const archivePath = path.join(workingDirectory, archiveName);
  fs.rmSync(archivePath, { force: true });
  const result = spawnSync("tar", ["-cf", archivePath, ...entries], {
    cwd: workingDirectory,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("could not seal hosted evidence archive");
  return archivePath;
}

function appendWorkflowEvidence(environment, payloadSha256, bundleSha256) {
  if (environment.GITHUB_OUTPUT) {
    fs.appendFileSync(
      environment.GITHUB_OUTPUT,
      `payload_sha256=${payloadSha256}\nbundle_sha256=${bundleSha256}\n`,
    );
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    const summary = scrubAndVerifyText(
      `- Sealed payload SHA-256: ${payloadSha256}\n- Uploaded bundle SHA-256: ${bundleSha256}\n`,
      environment,
    );
    fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  }
}

export function sealHostedEvidenceBundle({
  workingDirectory = process.cwd(),
  environment = process.env,
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
} = {}) {
  const manifestPath = path.join(workingDirectory, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`required ${artifactReference(PAYLOAD_ARTIFACTS.length, MANIFEST_FILE_NAME)} is missing`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const specs = [...PAYLOAD_ARTIFACTS];
  if (manifest.stably?.state === "attached") {
    if (typeof manifest.stably.lastRunFile !== "string") {
      throw new Error("attached reporter evidence lacks a last-run file reference");
    }
    specs.push({ path: manifest.stably.lastRunFile, required: true });
  }
  const scanned = scanHostedEvidenceArtifacts({
    workingDirectory,
    environment,
    artifactPaths: specs,
    maxDecompressedBytes,
    collectDigests: true,
  });
  const payloadPath = createTar(
    workingDirectory,
    PAYLOAD_ARCHIVE_NAME,
    scanned.includedPaths,
  );
  const payloadSha256 = sha256File(payloadPath);

  manifest.sealedPayload = {
    file: PAYLOAD_ARCHIVE_NAME,
    sha256: payloadSha256,
    artifacts: scanned.artifactDigests,
  };
  const serializedManifest = scrubAndVerifyText(JSON.stringify(manifest), environment);
  JSON.parse(serializedManifest);
  fs.writeFileSync(manifestPath, serializedManifest);
  const manifestRef = artifactReference(PAYLOAD_ARTIFACTS.length, MANIFEST_FILE_NAME);
  searchBytes(
    Buffer.from(serializedManifest, "utf8"),
    manifestRef,
    collectSecretByteRepresentations(environment),
    {
      topLevelRef: manifestRef,
      emittedWarnings: new Set(),
    },
  );

  const bundlePath = createTar(
    workingDirectory,
    HOSTED_EVIDENCE_BUNDLE_NAME,
    [PAYLOAD_ARCHIVE_NAME, MANIFEST_FILE_NAME],
  );
  const bundleSha256 = sha256File(bundlePath);
  appendWorkflowEvidence(environment, payloadSha256, bundleSha256);
  fs.rmSync(payloadPath, { force: true });
  return {
    bundleSha256,
    payloadSha256,
    artifactDigests: scanned.artifactDigests,
  };
}

function safeDiagnostic(value, environment) {
  try {
    return scrubAndVerifyText(value, environment);
  } catch {
    return "hosted-evidence: diagnostic redacted\n";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = sealHostedEvidenceBundle();
    process.stdout.write(
      safeDiagnostic(
        `hosted-evidence: sealed payload=${result.payloadSha256} bundle=${result.bundleSha256}\n`,
        process.env,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact scan failed";
    process.stderr.write(
      safeDiagnostic(`hosted-evidence: FAIL: ${message}\n`, process.env),
    );
    process.exitCode = 1;
  }
}
