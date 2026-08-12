import assert from "node:assert/strict";
import test from "node:test";

import { removePreviewStateFile } from "./preview-state.mjs";

test("state removal blocks until the lifecycle file is absent", async () => {
  let checks = 0;
  let removed = false;
  const cleared = await removePreviewStateFile("preview-state.json", 100, {
    removeFile: () => {
      removed = true;
    },
    fileExists: () => removed && checks++ < 2,
    now: (() => {
      let time = 0;
      return () => time++;
    })(),
    pause: async () => {},
  });

  assert.equal(cleared, true);
  assert.ok(checks >= 3);
});

test("state removal reports a lifecycle file that never clears", async () => {
  const cleared = await removePreviewStateFile("preview-state.json", 2, {
    removeFile: () => {},
    fileExists: () => true,
    now: (() => {
      let time = 0;
      return () => time++;
    })(),
    pause: async () => {},
  });

  assert.equal(cleared, false);
});
