#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSecretByteRepresentations,
  containsLiteralSecretRepresentation,
  findSecretRepresentation,
  scrubAndVerifyText,
} from "./hosted-evidence-secrets.mjs";

const MANIFEST_FILE_NAME = "hosted-evidence-manifest.json";
const PAYLOAD_ARCHIVE_NAME = "hosted-evidence-payload.tar";
export const HOSTED_EVIDENCE_BUNDLE_NAME = "hosted-evidence-bundle.tar";

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

function archiveKind(bytes) {
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  ) {
    return "zip";
  }
  if (bytes.length >= 262 && bytes.subarray(257, 262).toString("ascii") === "ustar") {
    return "tar";
  }
  const unsupportedSignatures = [
    Buffer.from([0x1f, 0x8b]),
    Buffer.from("BZh", "ascii"),
    Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    Buffer.from("Rar!\x1a\x07", "binary"),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
  ];
  if (unsupportedSignatures.some((signature) => bytes.subarray(0, signature.length).equals(signature))) {
    return "unsupported";
  }
  return null;
}

function validateArchiveEntries(entries, artifactRef, byteRepresentations) {
  for (const [index, entry] of entries.entries()) {
    const entryReference = nestedArtifactReference(artifactRef, index, entry);
    if (
      findSecretRepresentation(
        Buffer.from(entry, "utf8"),
        byteRepresentations,
        entryReference,
      )
    ) {
      throw new Error(`secret representation detected in ${entryReference}`);
    }
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`unsafe archive entry in ${entryReference}`);
    }
  }
}

function extractArchive(archivePath, kind, artifactRef, byteRepresentations) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-evidence-scan-"),
  );
  try {
    const listCommand = kind === "zip"
      ? ["unzip", ["-Z1", archivePath]]
      : ["tar", ["-tf", archivePath]];
    const listed = spawnSync(listCommand[0], listCommand[1], { encoding: "utf8" });
    if (listed.status !== 0) throw new Error(`unreadable archive in ${artifactRef}`);
    const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries, artifactRef, byteRepresentations);

    const extractCommand = kind === "zip"
      ? ["unzip", ["-qq", archivePath, "-d", temporaryDirectory]]
      : ["tar", ["-xf", archivePath, "-C", temporaryDirectory]];
    const extracted = spawnSync(extractCommand[0], extractCommand[1], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) throw new Error(`unreadable archive in ${artifactRef}`);
    scanPath(temporaryDirectory, artifactRef, byteRepresentations);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function scanPath(filePath, artifactRef, byteRepresentations) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`uninspectable symlink in ${artifactRef}`);
  }
  if (stat.isDirectory()) {
    for (const [index, entry] of fs.readdirSync(filePath).sort().entries()) {
      const entryReference = nestedArtifactReference(artifactRef, index, entry);
      if (
        findSecretRepresentation(
          Buffer.from(entry, "utf8"),
          byteRepresentations,
          entryReference,
        )
      ) {
        throw new Error(`secret representation detected in ${entryReference}`);
      }
      scanPath(path.join(filePath, entry), entryReference, byteRepresentations);
    }
    return;
  }
  if (!stat.isFile()) return;

  const bytes = fs.readFileSync(filePath);
  if (containsLiteralSecretRepresentation(bytes, byteRepresentations)) {
    throw new Error(`secret representation detected in ${artifactRef}`);
  }
  const kind = archiveKind(bytes);
  if (kind === "unsupported") {
    throw new Error(`unsupported compressed artifact in ${artifactRef}`);
  }
  if (kind === "zip" || kind === "tar") {
    extractArchive(filePath, kind, artifactRef, byteRepresentations);
    return;
  }
  if (findSecretRepresentation(bytes, byteRepresentations, artifactRef)) {
    throw new Error(`secret representation detected in ${artifactRef}`);
  }
}

function normalizeArtifactSpecs(artifactPaths) {
  return artifactPaths.map((artifact, index) =>
    typeof artifact === "string"
      ? { path: artifact, required: true, index }
      : { ...artifact, index },
  );
}

export function scanHostedEvidenceArtifacts({
  workingDirectory = process.cwd(),
  environment = process.env,
  artifactPaths = PAYLOAD_ARTIFACTS,
} = {}) {
  const byteRepresentations = collectSecretByteRepresentations(environment);
  const includedPaths = [];
  for (const artifact of normalizeArtifactSpecs(artifactPaths)) {
    const artifactRef = artifactReference(artifact.index, artifact.path);
    const resolvedPath = path.resolve(workingDirectory, artifact.path);
    if (!fs.existsSync(resolvedPath)) {
      if (artifact.required) throw new Error(`required ${artifactRef} is missing`);
      continue;
    }
    scanPath(resolvedPath, artifactRef, byteRepresentations);
    includedPaths.push(artifact.path);
  }
  return { includedPaths };
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
  });
  const payloadPath = createTar(
    workingDirectory,
    PAYLOAD_ARCHIVE_NAME,
    scanned.includedPaths,
  );
  scanHostedEvidenceArtifacts({
    workingDirectory,
    environment,
    artifactPaths: [PAYLOAD_ARCHIVE_NAME],
  });
  const payloadSha256 = sha256File(payloadPath);

  manifest.sealedPayload = {
    file: PAYLOAD_ARCHIVE_NAME,
    sha256: payloadSha256,
  };
  const serializedManifest = scrubAndVerifyText(JSON.stringify(manifest), environment);
  JSON.parse(serializedManifest);
  fs.writeFileSync(manifestPath, serializedManifest);

  const bundlePath = createTar(
    workingDirectory,
    HOSTED_EVIDENCE_BUNDLE_NAME,
    [PAYLOAD_ARCHIVE_NAME, MANIFEST_FILE_NAME],
  );
  scanHostedEvidenceArtifacts({
    workingDirectory,
    environment,
    artifactPaths: [HOSTED_EVIDENCE_BUNDLE_NAME],
  });
  const bundleSha256 = sha256File(bundlePath);
  appendWorkflowEvidence(environment, payloadSha256, bundleSha256);
  fs.rmSync(payloadPath, { force: true });
  return { bundleSha256, payloadSha256 };
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
