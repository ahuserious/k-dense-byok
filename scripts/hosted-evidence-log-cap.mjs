#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_HOSTED_EVIDENCE_LOG_BYTES = 32 * 1024 * 1024;

export function assertHostedEvidenceLogWithinLimit(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("raw evidence log is not a regular file");
  if (stat.size > MAX_HOSTED_EVIDENCE_LOG_BYTES) {
    throw new Error(
      `raw evidence log exceeds ${MAX_HOSTED_EVIDENCE_LOG_BYTES}-byte validation limit`,
    );
  }
  return stat.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertHostedEvidenceLogWithinLimit(
    path.resolve(process.argv[2] ?? "stably-test.log"),
  );
}
