import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderHttpHarness,
  type ProviderHttpCassette,
} from "./provider-http.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function cassettePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kady-provider-stub-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "provider.json");
}

function writeReplayCassette(targetPath: string): void {
  const bodyBase64 = Buffer.from('{"prompt":"synthetic"}').toString("base64");
  const cassette: ProviderHttpCassette = {
    version: 1,
    provider: "example",
    interactions: [
      {
        request: {
          method: "POST",
          url: "https://provider.example.test/v1/chat",
          contentType: "application/json",
          bodySha256: "bc1d0c76b51238f0d18b4fb034bcaf75cb18e8d2a708d48a1a11e3880cff9200",
          bodyBase64,
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          bodyBase64: Buffer.from('{"answer":"stubbed"}').toString("base64"),
        },
      },
    ],
  };
  fs.writeFileSync(targetPath, JSON.stringify(cassette));
}

describe("provider HTTP record/replay harness", () => {
  it("replays an ordered response without contacting the provider", async () => {
    const targetPath = cassettePath();
    writeReplayCassette(targetPath);
    const upstreamFetch = vi.fn<typeof fetch>();
    const harness = createProviderHttpHarness({
      cassettePath: targetPath,
      provider: "example",
      upstreamFetch,
    });

    const response = await harness.fetch("https://provider.example.test/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: '{"prompt":"synthetic"}',
    });

    expect(await response.json()).toEqual({ answer: "stubbed" });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(() => harness.assertExhausted()).not.toThrow();
  });

  it("fails when a request diverges from the recorded interaction", async () => {
    const targetPath = cassettePath();
    writeReplayCassette(targetPath);
    const harness = createProviderHttpHarness({ cassettePath: targetPath, provider: "example" });

    await expect(
      harness.fetch("https://provider.example.test/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"prompt":"different"}',
      }),
    ).rejects.toThrow(/replay mismatch/);
  });

  it("requires both live opt-ins before recording", () => {
    vi.stubEnv("LIVE_TESTS", "1");
    expect(() =>
      createProviderHttpHarness({
        cassettePath: cassettePath(),
        provider: "example",
        mode: "record",
      }),
    ).toThrow(/RECORD_PROVIDER_HTTP=1/);
  });

  it("records a sanitized request and an atomic replay cassette", async () => {
    vi.stubEnv("LIVE_TESTS", "1");
    vi.stubEnv("RECORD_PROVIDER_HTTP", "1");
    const targetPath = cassettePath();
    const upstreamFetch = vi.fn(async () =>
      new Response('{"answer":"recorded"}', {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "provider-secret=1",
        },
      }),
    );
    const harness = createProviderHttpHarness({
      cassettePath: targetPath,
      provider: "example",
      mode: "record",
      upstreamFetch,
    });

    await harness.fetch(
      "https://provider.example.test/v1/chat?api_key=query-secret&stable=yes",
      {
        method: "POST",
        headers: { authorization: "Bearer header-secret", "content-type": "application/json" },
        body: '{"prompt":"synthetic"}',
      },
    );
    harness.save();

    const saved = fs.readFileSync(targetPath, "utf-8");
    expect(saved).not.toContain("query-secret");
    expect(saved).not.toContain("header-secret");
    expect(saved).not.toContain("provider-secret");
    expect(saved).toContain("%5BREDACTED%5D");
  });
});
