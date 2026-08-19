import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector, type Model } from "@/components/model-selector";

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const GROQ_GROUP = {
  id: "groq",
  label: "Groq",
  kind: "api-key",
  projectsFrom: "none",
  runtimeProviderIds: ["groq"],
  credentialVariableNames: ["GROQ_API_KEY"],
  parameterSupport: {
    temperature: true,
    topP: true,
    maxTokens: true,
    reasoningEffort: false,
    seed: true,
  },
  dispatchableAsChatModel: true,
  configured: true,
};

const MODAL_GROUP = { ...GROQ_GROUP, id: "modal", label: "Modal", dispatchableAsChatModel: false };

const PRESET = {
  id: "mp_groq",
  name: "Fast summariser",
  providerId: "groq",
  modelId: "llama-3.3-70b-versatile",
  ref: "groq/llama-3.3-70b-versatile",
  hyperparameters: { temperature: 0.2 },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const MODAL_PRESET = {
  id: "mp_modal",
  name: "Llama on GPUs",
  providerId: "modal",
  modelId: "meta-llama/Llama-3.3-70B-Instruct",
  ref: "modal/meta-llama/Llama-3.3-70B-Instruct",
  modal: { huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct", gpuCount: 2 },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const GROQ_MODEL = {
  id: "groq/llama-3.3-70b-versatile",
  label: "Llama 3.3 70B",
  provider: "Groq",
  sourceId: "groq",
  sourceLabel: "Groq",
  tier: "mid",
  context_length: 131_072,
  pricing: { prompt: 0.59, completion: 0.79 },
  modality: "text->text",
  description: "Groq",
  reasoning: false,
  billingMode: "payg",
  available: true,
};

const SELECTED: Model = {
  id: "openrouter/anthropic/claude-opus-4.8",
  label: "Claude Opus 4.8",
  provider: "Anthropic",
  tier: "flagship",
  context_length: 200_000,
  pricing: { prompt: 5, completion: 25 },
  modality: "text->text",
  description: "selected",
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/model-presets")) {
      return json({
        presets: [PRESET, MODAL_PRESET],
        groups: [GROQ_GROUP, MODAL_GROUP],
        bindings: {
          direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
          "chat-session": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
          "workflow-node": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
          "hosted-fusion-supervised": {
            hyperparameters: "dropped",
            systemPromptOverride: "dropped",
          },
        },
      });
    }
    if (url.endsWith("/groq/models")) {
      return json({
        configured: true,
        credentialVariableName: "GROQ_API_KEY",
        models: [GROQ_MODEL],
      });
    }
    if (url.endsWith("/cerebras/models")) {
      return json({ configured: false, credentialVariableName: "CEREBRAS_API_KEY", models: [] });
    }
    if (url.endsWith("/ollama/models")) return json({ available: false, models: [] });
    if (url.endsWith("/openai-compatible/models")) {
      return json({ available: false, configured: false, models: [] });
    }
    if (url.endsWith("/nvidia/models")) return json({ configured: false, models: [] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    if (url.endsWith("/model-providers")) return json({ providers: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPicker(onChange: (model: Model) => void = vi.fn()) {
  const user = userEvent.setup();
  render(<ModelSelector selected={SELECTED} onChange={onChange} />);
  // The trigger's accessible name reports the current model AND its provider
  // state ("checking…" until discovery settles), so match the stable prefix.
  await user.click(await screen.findByRole("button", { name: /^Select model/ }));
  return user;
}

describe("model selector — presets and the new API-key providers", () => {
  it("shows saved presets as their own group, ahead of the catalogue", async () => {
    await openPicker();

    expect(await screen.findByText("Model presets")).toBeVisible();
    const preset = await screen.findByRole("option", {
      name: "Fast summariser by Groq",
    });
    expect(preset).toBeVisible();
    // A preset has no price of its own; printing $0.00 would read as free.
    expect(screen.getByText(/Saved preset · resolves to its provider and model/)).toBeVisible();
  });

  it("omits a Modal preset, which is a compute job rather than a chat model", async () => {
    await openPicker();
    await screen.findByText("Model presets");
    expect(screen.queryByRole("option", { name: /Llama on GPUs/ })).toBeNull();
  });

  it("selecting a preset hands back its preset/<id> ref, not a copy of its contents", async () => {
    const onSelect = vi.fn();
    const user = await openPicker(onSelect);

    await user.click(
      await screen.findByRole("option", { name: "Fast summariser by Groq" }),
    );

    // The id is the indirection the whole feature rests on: the server resolves
    // it at dispatch time, so an edited preset takes effect everywhere.
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "preset/mp_groq" }),
    );
  });

  it("shows a Groq group once GROQ_API_KEY is configured", async () => {
    await openPicker();
    // "Groq" appears twice once configured: the group heading and the row's
    // provider label.
    expect((await screen.findAllByText("Groq")).length).toBeGreaterThan(1);
    expect(
      await screen.findByRole("option", { name: "Llama 3.3 70B by Groq" }),
    ).toBeVisible();
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ModelSelector selected={SELECTED} onChange={onSelect} />);

    await user.tab();
    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    const preset = await screen.findByRole("option", {
      name: "Fast summariser by Groq",
    });
    preset.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: "preset/mp_groq" }),
      ),
    );
  });
});
