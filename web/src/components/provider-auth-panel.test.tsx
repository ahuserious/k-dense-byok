import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "@/components/provider-auth-panel";

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const GROUPS = [
  "cerebras",
  "openai",
  "openrouter",
  "anthropic",
  "groq",
  "xai",
  "local",
  "modal",
].map((id) => ({
  id,
  label: id === "xai" ? "xAI" : id.charAt(0).toUpperCase() + id.slice(1),
  kind: "api-key",
  projectsFrom: "none",
  runtimeProviderIds: [id],
  credentialVariableNames: [`${id.toUpperCase()}_API_KEY`],
  parameterSupport: {
    temperature: true,
    topP: true,
    maxTokens: true,
    reasoningEffort: true,
    seed: true,
  },
  dispatchableAsChatModel: id !== "modal",
  directDispatch:
    id === "modal"
      ? { supported: false, reason: "Modal presets describe a compute job rather than a chat model." }
      : { supported: true },
  configured: false,
  notConfiguredReason: `${id} is not configured. Set ${id.toUpperCase()}_API_KEY.`,
}));

const BINDING_TABLE = {
  direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
  "chat-session": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Chat uses this preset's provider and model only.",
  },
  "workflow-node": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Workflow nodes use the node's own settings.",
  },
  "hosted-fusion-supervised": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Hosted Fusion nodes use the node's own settings.",
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/model-presets")) {
      return json({ presets: [], groups: GROUPS, bindingsByGroup: Object.fromEntries(GROUPS.map((group) => [group.id, BINDING_TABLE])) });
    }
    if (url.endsWith("/model-providers")) {
      return json({
        providers: [
          {
            id: "openai-codex",
            name: "OpenAI Codex",
            accountLabel: "ChatGPT Plus/Pro",
            billingMode: "subscription",
            billingNote: "note",
            connected: false,
            needsReauth: false,
            credentialType: null,
            source: null,
            loginLabel: null,
            modelCount: 0,
          },
        ],
      });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings ▸ Model providers", () => {
  it("keeps the OAuth subscription panel and adds Model presets below it", async () => {
    render(<ProviderAuthPanel />);

    expect(
      await screen.findByRole("heading", { name: "Model providers" }),
    ).toBeVisible();
    // The pre-existing OAuth surface is untouched.
    expect(await screen.findByRole("heading", { name: "OpenAI Codex" })).toBeVisible();
    // …and the preset section is reachable from the same tab.
    expect(await screen.findByRole("heading", { name: "Model presets" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Model preset/ })).toBeVisible();
  });

  it("shows all eight owner-named provider groups", async () => {
    render(<ProviderAuthPanel />);
    await screen.findByRole("heading", { name: "Model presets" });

    for (const label of [
      "Cerebras",
      "Openai",
      "Openrouter",
      "Anthropic",
      "Groq",
      "xAI",
      "Local",
      "Modal",
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    }
  });
});
