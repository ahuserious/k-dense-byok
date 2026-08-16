#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSecretRepresentations,
  findSecretRepresentation,
} from "./hosted-evidence-secrets.mjs";

export const HOSTED_EVIDENCE_ARTIFACT_PATHS = [
  "playwright-report",
  "test-results",
  ".stably/test-results",
  "stably-install.log",
  "playwright-install.log",
  "browser-install-method.txt",
  "preview-up.scrubbed.log",
  "stably-test.scrubbed.log",
  "runner-fingerprint.json",
  "hosted-evidence-manifest.json",
];

function archiveEntries(archivePath, artifactPath, representations) {
  const result = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("could not inspect archive");
  }
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (findSecretRepresentation(Buffer.from(entry, "utf8"), representations)) {
      throw new Error(`secret representation detected in artifact: ${artifactPath}`);
    }
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error("archive contains an unsafe path");
    }
  }
}

function scanArchive(archivePath, artifactPath, representations) {
  archiveEntries(archivePath, artifactPath, representations);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-evidence-scan-"),
  );
  try {
    const result = spawnSync("unzip", ["-qq", archivePath, "-d", temporaryDirectory], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`could not extract artifact archive: ${displayPath}`);
    }
    scanPath(temporaryDirectory, artifactPath, representations);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function scanPath(filePath, artifactPath, representations) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing uninspectable artifact symlink: ${artifactPath}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(filePath).sort()) {
      if (findSecretRepresentation(Buffer.from(entry, "utf8"), representations)) {
        throw new Error(`secret representation detected in artifact: ${artifactPath}`);
      }
      scanPath(path.join(filePath, entry), artifactPath, representations);
    }
    return;
  }
  if (!stat.isFile()) return;

  const bytes = fs.readFileSync(filePath);
  if (findSecretRepresentation(bytes, representations)) {
    throw new Error(`secret representation detected in artifact: ${artifactPath}`);
  }
  if (/\.zip$/i.test(filePath)) {
    scanArchive(filePath, artifactPath, representations);
  }
}

export function scanHostedEvidenceArtifacts({
  workingDirectory = process.cwd(),
  environment = process.env,
  artifactPaths = HOSTED_EVIDENCE_ARTIFACT_PATHS,
} = {}) {
  const representations = collectSecretRepresentations(environment);
  let scannedPaths = 0;
  for (const artifactPath of artifactPaths) {
    const resolvedPath = path.resolve(workingDirectory, artifactPath);
    if (!fs.existsSync(resolvedPath)) continue;
    scanPath(resolvedPath, artifactPath, representations);
    scannedPaths += 1;
  }
  return { scannedPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = scanHostedEvidenceArtifacts();
    process.stdout.write(
      `hosted-evidence-scan: PASS (${result.scannedPaths} artifact paths)\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact scan failed";
    process.stderr.write(`hosted-evidence-scan: FAIL: ${message}\n`);
    process.exitCode = 1;
  }
}
