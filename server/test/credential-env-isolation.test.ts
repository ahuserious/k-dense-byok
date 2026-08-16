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

const previewSetup = vi.hoisted(() => {
  const temporaryRoot = `${process.env.TMPDIR ?? "/tmp"}/` +
    `kady-credential-env-isolation-${process.pid}-${Date.now()}`;
  const originalKadyEnvFile = process.env.KADY_ENV_FILE;
  const originalKadyPreview = process.env.KADY_PREVIEW;
  const previewEnvPath = `${temporaryRoot}/launch/.env`;
  process.env.KADY_ENV_FILE = previewEnvPath;
  process.env.KADY_PREVIEW = "1";
  return {
    originalKadyEnvFile,
    originalKadyPreview,
    previewEnvPath,
    temporaryRoot,
  };
});

const modelRuntime = vi.hoisted(() => ({
  setRuntimeApiKey: vi.fn(async () => undefined),
  removeRuntimeApiKey: vi.fn(async () => undefined),
}));

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: () => modelRuntime,
}));

import {
  registerCredentialRoutes,
  setCredentialEnvPathForTests,
} from "../src/api/credentials.ts";

const checkoutEnvPath = path.join(previewSetup.temporaryRoot, "checkout", ".env");
const originalExaApiKey = process.env.EXA_API_KEY;

beforeAll(() => {
  fs.mkdirSync(path.dirname(previewSetup.previewEnvPath), { recursive: true });
  fs.mkdirSync(path.dirname(checkoutEnvPath), { recursive: true });
});

beforeEach(() => {
  process.env.KADY_ENV_FILE = previewSetup.previewEnvPath;
  process.env.KADY_PREVIEW = "1";
  delete process.env.EXA_API_KEY;
  fs.writeFileSync(previewSetup.previewEnvPath, "# blank preview env\n", {
    mode: 0o600,
  });
  fs.writeFileSync(checkoutEnvPath, "OPENROUTER_API_KEY=sentinel\n", { mode: 0o600 });
  setCredentialEnvPathForTests(null);
});

afterEach(() => {
  setCredentialEnvPathForTests(null);
  if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalExaApiKey;
});

afterAll(() => {
  if (previewSetup.originalKadyEnvFile === undefined) delete process.env.KADY_ENV_FILE;
  else process.env.KADY_ENV_FILE = previewSetup.originalKadyEnvFile;
  if (previewSetup.originalKadyPreview === undefined) delete process.env.KADY_PREVIEW;
  else process.env.KADY_PREVIEW = previewSetup.originalKadyPreview;
  fs.rmSync(previewSetup.temporaryRoot, { recursive: true, force: true });
});

async function credentialApp() {
  const app = Fastify({ logger: false });
  await registerCredentialRoutes(app);
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
      expect(fs.readFileSync(previewSetup.previewEnvPath, "utf8")).toContain(
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
    setCredentialEnvPathForTests(checkoutEnvPath);
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
    setCredentialEnvPathForTests(checkoutEnvPath);
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
