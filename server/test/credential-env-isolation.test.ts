import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const modelRuntime = vi.hoisted(() => ({
  setRuntimeApiKey: vi.fn(async () => undefined),
  removeRuntimeApiKey: vi.fn(async () => undefined),
}));

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: () => modelRuntime,
}));

const temporaryRoot = fs.mkdtempSync(
  path.join(process.env.TMPDIR ?? "/tmp", "kady-credential-env-isolation-"),
);
const launchRoot = path.join(temporaryRoot, "launch");
const previewEnvPath = path.join(launchRoot, ".env");
const checkoutEnvPath = path.join(temporaryRoot, "checkout", ".env");
const originalKadyEnvFile = process.env.KADY_ENV_FILE;
const originalKadyPreview = process.env.KADY_PREVIEW;
const originalKadyPreviewLaunchRoot = process.env.KADY_PREVIEW_LAUNCH_ROOT;
const originalExaApiKey = process.env.EXA_API_KEY;
let credentialModule: typeof import("../src/api/credentials.ts");

beforeAll(async () => {
  fs.mkdirSync(launchRoot, { recursive: true });
  fs.mkdirSync(path.dirname(checkoutEnvPath), { recursive: true });
  fs.writeFileSync(previewEnvPath, "# blank preview env\n", { mode: 0o600 });
  process.env.KADY_ENV_FILE = previewEnvPath;
  process.env.KADY_PREVIEW = "1";
  process.env.KADY_PREVIEW_LAUNCH_ROOT = launchRoot;
  vi.resetModules();
  credentialModule = await import("../src/api/credentials.ts");
});

beforeEach(() => {
  process.env.KADY_ENV_FILE = previewEnvPath;
  process.env.KADY_PREVIEW = "1";
  process.env.KADY_PREVIEW_LAUNCH_ROOT = launchRoot;
  delete process.env.EXA_API_KEY;
  fs.writeFileSync(previewEnvPath, "# blank preview env\n", {
    mode: 0o600,
  });
  fs.writeFileSync(checkoutEnvPath, "OPENROUTER_API_KEY=sentinel\n", { mode: 0o600 });
  credentialModule.setCredentialEnvPathForTests(null);
});

afterEach(() => {
  credentialModule.setCredentialEnvPathForTests(null);
  if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalExaApiKey;
});

afterAll(() => {
  if (originalKadyEnvFile === undefined) delete process.env.KADY_ENV_FILE;
  else process.env.KADY_ENV_FILE = originalKadyEnvFile;
  if (originalKadyPreview === undefined) delete process.env.KADY_PREVIEW;
  else process.env.KADY_PREVIEW = originalKadyPreview;
  if (originalKadyPreviewLaunchRoot === undefined) {
    delete process.env.KADY_PREVIEW_LAUNCH_ROOT;
  } else {
    process.env.KADY_PREVIEW_LAUNCH_ROOT = originalKadyPreviewLaunchRoot;
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function credentialApp() {
  const app = Fastify({ logger: false });
  await credentialModule.registerCredentialRoutes(app);
  return app;
}

describe("credential env isolation", () => {
  it("writes preview credential changes only to KADY_ENV_FILE", async () => {
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "preview-exa-key" },
      });

      expect(response.statusCode).toBe(200);
      expect(fs.readFileSync(previewEnvPath, "utf8")).toContain(
        "EXA_API_KEY=preview-exa-key",
      );
      expect(fs.readFileSync(checkoutEnvPath, "utf8")).toBe(
        "OPENROUTER_API_KEY=sentinel\n",
      );
    } finally {
      await app.close();
    }
  });

  it("refuses a preview write redirected outside KADY_ENV_FILE", async () => {
    credentialModule.setCredentialEnvPathForTests(checkoutEnvPath);
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "preview-exa-key" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        reason: "preview_credential_path_refused",
        saved: false,
      });
      expect(fs.readFileSync(checkoutEnvPath, "utf8")).toBe(
        "OPENROUTER_API_KEY=sentinel\n",
      );
    } finally {
      await app.close();
    }
  });

  it("retains the existing repo-env writer behavior outside preview mode", async () => {
    delete process.env.KADY_PREVIEW;
    delete process.env.KADY_ENV_FILE;
    delete process.env.KADY_PREVIEW_LAUNCH_ROOT;
    credentialModule.setCredentialEnvPathForTests(checkoutEnvPath);
    const app = await credentialApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { exaApiKey: "normal-exa-key" },
      });

      expect(response.statusCode).toBe(200);
      expect(fs.readFileSync(checkoutEnvPath, "utf8")).toContain(
        "EXA_API_KEY=normal-exa-key",
      );
    } finally {
      await app.close();
    }
  });
});
