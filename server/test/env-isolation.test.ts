import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRACKED_ENV_NAMES = [
  "KADY_ENV_FILE",
  "KADY_PREVIEW",
  "OPENROUTER_API_KEY",
  "PI_CODING_AGENT_DIR",
] as const;
const originalEnvironment = new Map(
  TRACKED_ENV_NAMES.map((name) => [name, process.env[name]] as const),
);

let temporaryRoot: string;
let checkoutRoot: string;
let previewEnvPath: string;

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-env-isolation-"));
  checkoutRoot = path.join(temporaryRoot, "checkout");
  previewEnvPath = path.join(temporaryRoot, "launch", ".env");
  fs.mkdirSync(path.dirname(previewEnvPath), { recursive: true });
  fs.mkdirSync(checkoutRoot, { recursive: true });
  fs.writeFileSync(
    path.join(checkoutRoot, ".env"),
    "OPENROUTER_API_KEY=sentinel\n",
  );
  fs.writeFileSync(previewEnvPath, "# blank preview env\n");
  process.env.KADY_ENV_FILE = previewEnvPath;
  process.env.KADY_PREVIEW = "1";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  vi.resetModules();
});

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("server env isolation", () => {
  it("loads only KADY_ENV_FILE when preview mode is active", async () => {
    const { loadEnvironmentFiles } = await import("../src/env.ts");

    loadEnvironmentFiles(checkoutRoot);

    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("retains normal checkout env discovery outside preview mode", async () => {
    const { loadEnvironmentFiles } = await import("../src/env.ts");
    delete process.env.KADY_PREVIEW;

    loadEnvironmentFiles(checkoutRoot);

    expect(process.env.OPENROUTER_API_KEY).toBe("sentinel");
  });
});
