import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentFilePaths } from "../src/environment-files.ts";

const TRACKED_ENV_NAMES = [
  "KADY_ENV_FILE",
  "KADY_PREVIEW",
  "KADY_PREVIEW_LAUNCH_ROOT",
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
  process.env.KADY_PREVIEW_LAUNCH_ROOT = path.dirname(previewEnvPath);
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
  function previewEnvironment(
    overrides: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv {
    return {
      KADY_PREVIEW: "1",
      KADY_PREVIEW_LAUNCH_ROOT: path.dirname(previewEnvPath),
      ...overrides,
    };
  }

  it("fails closed when preview KADY_ENV_FILE is missing", () => {
    expect(() =>
      environmentFilePaths(checkoutRoot, previewEnvironment()),
    ).toThrow("KADY_PREVIEW=1 requires an absolute KADY_ENV_FILE.");
  });

  it("fails closed when preview KADY_ENV_FILE is blank", () => {
    expect(() =>
      environmentFilePaths(
        checkoutRoot,
        previewEnvironment({ KADY_ENV_FILE: "   " }),
      ),
    ).toThrow("KADY_PREVIEW=1 requires an absolute KADY_ENV_FILE.");
  });

  it("fails closed when preview KADY_ENV_FILE is relative", () => {
    expect(() =>
      environmentFilePaths(
        checkoutRoot,
        previewEnvironment({ KADY_ENV_FILE: "launch/.env" }),
      ),
    ).toThrow("KADY_PREVIEW=1 requires KADY_ENV_FILE to be absolute.");
  });

  it("fails closed when preview KADY_ENV_FILE resolves outside the launch root", () => {
    const outsideEnvPath = path.join(temporaryRoot, "outside.env");
    fs.writeFileSync(outsideEnvPath, "OPENROUTER_API_KEY=sentinel\n");

    expect(() =>
      environmentFilePaths(
        checkoutRoot,
        previewEnvironment({ KADY_ENV_FILE: outsideEnvPath }),
      ),
    ).toThrow("KADY_ENV_FILE must resolve within KADY_PREVIEW_LAUNCH_ROOT.");
  });

  it("fails closed when preview KADY_ENV_FILE is a symlink outside the launch root", () => {
    if (process.platform === "win32") return;
    const outsideEnvPath = path.join(temporaryRoot, "outside-symlink-target.env");
    const symlinkPath = path.join(path.dirname(previewEnvPath), "symlink.env");
    fs.writeFileSync(outsideEnvPath, "OPENROUTER_API_KEY=sentinel\n");
    fs.symlinkSync(outsideEnvPath, symlinkPath);

    expect(() =>
      environmentFilePaths(
        checkoutRoot,
        previewEnvironment({ KADY_ENV_FILE: symlinkPath }),
      ),
    ).toThrow("KADY_ENV_FILE must resolve within KADY_PREVIEW_LAUNCH_ROOT.");
  });

  it("canonicalizes a regular preview env file under the launch root", () => {
    expect(
      environmentFilePaths(
        checkoutRoot,
        previewEnvironment({ KADY_ENV_FILE: previewEnvPath }),
      ),
    ).toEqual([fs.realpathSync(previewEnvPath)]);
  });

  it("rejects KADY_ENV_FILE outside preview mode", () => {
    expect(() =>
      environmentFilePaths(checkoutRoot, { KADY_ENV_FILE: previewEnvPath }),
    ).toThrow("KADY_ENV_FILE is supported only when KADY_PREVIEW=1.");
  });

  it("refuses backend env startup when preview KADY_ENV_FILE is missing", async () => {
    delete process.env.KADY_ENV_FILE;

    await expect(import("../src/env.ts")).rejects.toThrow(
      "KADY_PREVIEW=1 requires an absolute KADY_ENV_FILE.",
    );
  });

  it("refuses backend env startup when normal mode sets KADY_ENV_FILE", async () => {
    delete process.env.KADY_PREVIEW;

    await expect(import("../src/env.ts")).rejects.toThrow(
      "KADY_ENV_FILE is supported only when KADY_PREVIEW=1.",
    );
  });

  it("loads only KADY_ENV_FILE when preview mode is active", async () => {
    const { loadEnvironmentFiles } = await import("../src/env.ts");

    loadEnvironmentFiles(checkoutRoot);

    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("retains normal checkout env discovery outside preview mode", async () => {
    const { loadEnvironmentFiles } = await import("../src/env.ts");
    delete process.env.KADY_PREVIEW;
    delete process.env.KADY_ENV_FILE;
    delete process.env.KADY_PREVIEW_LAUNCH_ROOT;

    loadEnvironmentFiles(checkoutRoot);

    expect(process.env.OPENROUTER_API_KEY).toBe("sentinel");
  });
});
