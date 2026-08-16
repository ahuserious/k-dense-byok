import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("instruments every direct preview service spawn and exit", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "start.mjs"), "utf-8");
  const instrumented = instrumentPreviewLauncher(source);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "spawned"\)/g)?.length, 2);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "exited", exitCode, signal\)/g)?.length, 2);
  assert.match(instrumented, /KADY_PREVIEW_SERVICE_STATE_FILE/);
  assert.match(instrumented, /KADY_PREVIEW_START_GATE_FILE/);
  assert.match(instrumented, /KADY_PREVIEW_GENERATION/);
  assert.match(instrumented, /ps-lstart-utc/);
  assert.equal(instrumented.match(/process\.kill\(child\.pid, "SIGSTOP"\)/g)?.length, 2);
  assert.equal(instrumented.match(/process\.kill\(child\.pid, "SIGCONT"\)/g)?.length, 2);
});

test("fails closed when launcher anchors drift", () => {
  assert.throws(
    () => instrumentPreviewLauncher("const sleep = () => {};"),
    /expected one stable anchor/,
  );
});
