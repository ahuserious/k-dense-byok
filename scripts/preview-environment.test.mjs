import assert from "node:assert/strict";
import test from "node:test";
import { previewEnvironment } from "./preview-environment.mjs";

test("pins both engine clients to the preview port and scrubs legacy engine variables", () => {
  const environment = previewEnvironment(
    "/tmp/kady-preview-test",
    "/tmp/kady-preview-test/launch",
    "/tmp/kady-preview-test/launch/bin",
    { backend: 18000, frontend: 13000, engine: 13091 },
    {
      PATH: "/usr/bin",
      ARCHON_BASE_URL: "http://ambient.invalid:3091",
      NEXT_PUBLIC_ARCHON_URL: "http://ambient.invalid:3091",
      KADY_ARCHON_PORT: "3091",
    },
  );

  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13091");
  assert.equal(environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL, "http://127.0.0.1:13091");
  assert.equal(environment.KADY_PIPELINE_ENGINE_PORT, "13091");
  assert.equal("ARCHON_BASE_URL" in environment, false);
  assert.equal("NEXT_PUBLIC_ARCHON_URL" in environment, false);
  assert.equal("KADY_ARCHON_PORT" in environment, false);
});
