import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresetEditor } from "@/components/model-presets/preset-editor";
import type { ModelPresetInput, ProviderGroupStatus } from "@/lib/model-presets";
import { fetchModalInstances } from "@/lib/model-presets";
import { searchHuggingFaceModels } from "@/lib/model-presets-huggingface";

// The Modal instance catalogue and the Hugging Face search are the two network
// dependencies of the Modal branch of this editor. Both are stubbed here so the
// component's own states — chooser disabled with a reason, stepper bounded by
// the selected instance — are what is under test.
vi.mock("@/lib/model-presets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-presets")>()),
  fetchModalInstances: vi.fn(),
}));
vi.mock("@/lib/model-presets-huggingface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-presets-huggingface")>()),
  searchHuggingFaceModels: vi.fn(),
}));

const fetchModalInstancesMock = vi.mocked(fetchModalInstances);
const searchHuggingFaceModelsMock = vi.mocked(searchHuggingFaceModels);

const MODAL_INSTANCES = [
  { id: "cpu-4", label: "CPU · 4 cores", kind: "cpu" as const, gpu: null, maxGpuCount: 1, pricePerHour: 0.2 },
  { id: "a10g", label: "NVIDIA A10", kind: "gpu" as const, gpu: "A10", maxGpuCount: 4, pricePerHour: 1.1 },
  { id: "h100", label: "NVIDIA H100", kind: "gpu" as const, gpu: "H100", maxGpuCount: 8, pricePerHour: 4.56 },
];

beforeEach(() => {
  fetchModalInstancesMock.mockReset();
  searchHuggingFaceModelsMock.mockReset();
  fetchModalInstancesMock.mockResolvedValue({
    modalConfigured: true,
    instances: MODAL_INSTANCES,
  });
  searchHuggingFaceModelsMock.mockResolvedValue({
    ok: true,
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        pipelineTag: "text-generation",
        libraryName: "transformers",
        gated: "manual",
        downloads: 1,
        likes: 1,
      },
      {
        id: "mistralai/Mistral-7B-Instruct-v0.3",
        pipelineTag: "text-generation",
        libraryName: "transformers",
        gated: false,
        downloads: 2,
        likes: 2,
      },
    ],
  });
});

function group(
  id: ProviderGroupStatus["id"],
  label: string,
  overrides: Partial<ProviderGroupStatus> = {},
): ProviderGroupStatus {
  return {
    id,
    label,
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
    dispatchableAsChatModel: true,
    directDispatch: { supported: true },
    configured: true,
    ...overrides,
  };
}

const GROUPS: ProviderGroupStatus[] = [
  group("groq", "Groq", {
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: false,
      seed: true,
    },
  }),
  group("cerebras", "Cerebras", {
    configured: false,
    notConfiguredReason:
      "Cerebras is not configured. Set CEREBRAS_API_KEY in your environment file and restart Kady.",
  }),
  group("modal", "Modal", {
    kind: "compute",
    dispatchableAsChatModel: false,
    directDispatch: {
      supported: false,
      reason:
        "Modal presets describe a compute job rather than a chat model, so there is no completion to send. Use Run on Modal instead.",
    },
    parameterSupport: {
      temperature: false,
      topP: false,
      maxTokens: false,
      reasoningEffort: false,
      seed: false,
    },
    configured: false,
    notConfiguredReason:
      "Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET under Settings ▸ API keys.",
  }),
];

describe("preset editor", () => {
  it("collects a name, provider, model and hyperparameters", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={onSave} onCancel={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("Preset name"), "Fast summariser");
    await user.type(screen.getByLabelText("Model id"), "llama-3.3-70b-versatile");
    await user.type(screen.getByLabelText("Temperature"), "0.2");
    await user.type(screen.getByLabelText("Max tokens"), "400");
    await user.type(
      screen.getByLabelText("System-prompt override"),
      "Answer in one sentence.",
    );
    await user.click(screen.getByRole("button", { name: "Create preset" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "Fast summariser",
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
      hyperparameters: {
        temperature: 0.2,
        topP: undefined,
        maxTokens: 400,
        reasoningEffort: undefined,
        seed: undefined,
      },
      systemPromptOverride: "Answer in one sentence.",
      // Explicitly null rather than omitted: an absent key means "leave it as
      // it is" on the PATCH route, which is what made a cleared field
      // un-clearable in round 1.
      modal: null,
    });
  });

  it("disables a parameter the provider does not accept, with a stated reason", () => {
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    // Groq's group reports reasoningEffort unsupported, so the control cannot
    // act — and is therefore rendered disabled with the reason, not live.
    const reasoning = screen.getByLabelText("Reasoning level");
    expect(reasoning).toBeDisabled();
    expect(screen.getByText("Groq does not accept a reasoning level.")).toBeVisible();
    // The state is not carried by opacity alone: the disabled attribute is set
    // and a text reason accompanies it.
    expect(screen.getByLabelText("Temperature")).not.toBeDisabled();
  });

  it("says an unconfigured provider is unconfigured and names the variable", async () => {
    const user = userEvent.setup();
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "cerebras");

    expect(screen.getByText(/CEREBRAS_API_KEY/)).toBeVisible();
  });

  it("chooses the Hugging Face model from a search and binds the GPU stepper to the instance", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={onSave} onCancel={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "modal");
    await user.type(screen.getByLabelText("Preset name"), "Llama on GPUs");

    // The model is CHOSEN from a Hugging Face search, not typed as free text —
    // F12's interface is explicit that a free-text fallback is the pattern this
    // wave exists to stop.
    await user.type(screen.getByLabelText("Hugging Face model"), "llama");
    await user.click(screen.getByRole("button", { name: "Search" }));
    const chooser = await screen.findByRole("combobox", { name: "Hugging Face model" });
    await user.selectOptions(chooser, "meta-llama/Llama-3.3-70B-Instruct");
    expect(screen.getByTestId("hf-selected-model")).toHaveTextContent(
      "meta-llama/Llama-3.3-70B-Instruct",
    );

    // Before an instance is chosen the job would run on Modal's CPU default,
    // which allows exactly one GPU — so the stepper is disabled at 1 with that
    // reason rather than live and rejected at save.
    const gpuCount = screen.getByLabelText("GPU count");
    expect(gpuCount).toBeDisabled();
    expect(gpuCount).toHaveValue(1);
    expect(screen.getByText(/Pick a Modal instance/)).toBeVisible();

    await waitFor(() =>
      expect(screen.getByLabelText("Modal instance")).toHaveDisplayValue(
        /Modal default/,
      ),
    );
    await user.selectOptions(screen.getByLabelText("Modal instance"), "a10g");
    expect(gpuCount).not.toBeDisabled();

    // a10g's ceiling is 4, taken from the catalogue the server serves — not a
    // constant in the component. Leaning on the stepper does not exceed it.
    for (let index = 0; index < 6; index += 1) {
      await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    }
    expect(gpuCount).toHaveValue(4);
    for (let index = 0; index < 8; index += 1) {
      await user.click(screen.getByRole("button", { name: "Decrease GPU count" }));
    }
    expect(gpuCount).toHaveValue(1);
    await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    expect(gpuCount).toHaveValue(3);

    // Every sampling control is disabled for Modal: a compute job takes none.
    expect(screen.getByLabelText("Temperature")).toBeDisabled();
    expect(screen.getByLabelText("Seed")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Create preset" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "modal",
        modelId: "meta-llama/Llama-3.3-70B-Instruct",
        modal: {
          huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
          gpuCount: 3,
          instanceId: "a10g",
        },
      }),
    );
  });

  it("clamps the GPU count down when a smaller instance is chosen", async () => {
    const user = userEvent.setup();
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "modal");
    await waitFor(() => expect(screen.getByLabelText("Modal instance")).toBeEnabled());

    await user.selectOptions(screen.getByLabelText("Modal instance"), "h100");
    for (let index = 0; index < 7; index += 1) {
      await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    }
    expect(screen.getByLabelText("GPU count")).toHaveValue(8);

    await user.selectOptions(screen.getByLabelText("Modal instance"), "a10g");
    expect(screen.getByLabelText("GPU count")).toHaveValue(4);

    // A CPU instance has no GPUs at all: the stepper is fixed at 1 and says so.
    await user.selectOptions(screen.getByLabelText("Modal instance"), "cpu-4");
    expect(screen.getByLabelText("GPU count")).toHaveValue(1);
    expect(screen.getByLabelText("GPU count")).toBeDisabled();
    expect(screen.getByText(/cpu-4 instance has no GPUs/)).toBeVisible();
  });

  it("disables the Hugging Face chooser and names HF_TOKEN when it is unconfigured", async () => {
    // The fail-closed case F12's interface calls the one to design for: a 503
    // NOT_CONFIGURED body. The control is disabled with the reason, and there
    // is deliberately no free-text fallback to store an unvalidated id.
    searchHuggingFaceModelsMock.mockResolvedValue({
      ok: false,
      kind: "unconfigured",
      envVar: "HF_TOKEN",
      detail: "Hugging Face is not configured. Set HF_TOKEN to search models.",
    });
    const user = userEvent.setup();
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "modal");

    const search = await screen.findByLabelText("Hugging Face model");
    await waitFor(() => expect(search).toBeDisabled());
    expect(
      screen.getByText("Set HF_TOKEN to search Hugging Face models"),
    ).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Hugging Face model" })).toBeNull();
  });

  it("disables the chooser with an honest reason when the search route is absent", async () => {
    // What happens in a build where lane F12 has not merged: the route 404s.
    // Reporting that as a Hugging Face outage would be a guess; it says so.
    searchHuggingFaceModelsMock.mockResolvedValue({
      ok: false,
      kind: "unavailable",
      detail: "Hugging Face model search is not available in this build yet.",
    });
    const user = userEvent.setup();
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "modal");

    await waitFor(() =>
      expect(screen.getByLabelText("Hugging Face model")).toBeDisabled(),
    );
    expect(
      screen.getByText("Hugging Face model search is not available in this build yet."),
    ).toBeVisible();
  });

  it("does not send a value for a parameter the provider refuses", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_input: ModelPresetInput) => {});
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={onSave} onCancel={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("Preset name"), "n");
    await user.type(screen.getByLabelText("Model id"), "m");
    await user.click(screen.getByRole("button", { name: "Create preset" }));

    const [input] = onSave.mock.calls[0];
    expect(input.hyperparameters?.reasoningEffort).toBeUndefined();
  });

  it("loads an existing preset's values for editing", () => {
    render(
      <PresetEditor
        preset={{
          id: "mp_1",
          name: "Existing",
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
          ref: "groq/llama-3.3-70b-versatile",
          hyperparameters: { temperature: 0.7, seed: 11 },
          systemPromptOverride: "Be terse.",
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        }}
        groups={GROUPS}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Preset name")).toHaveValue("Existing");
    expect(screen.getByLabelText("Model id")).toHaveValue("llama-3.3-70b-versatile");
    expect(screen.getByLabelText("Temperature")).toHaveValue(0.7);
    expect(screen.getByLabelText("Seed")).toHaveValue(11);
    expect(screen.getByLabelText("System-prompt override")).toHaveValue("Be terse.");
    expect(screen.getByRole("button", { name: "Save preset" })).toBeVisible();
  });

  it("puts every control in the tab order and focuses the first field", async () => {
    const user = userEvent.setup();
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    // Opening the editor moves focus into it rather than leaving the keyboard
    // user on the trigger with new content below them.
    expect(screen.getByLabelText("Preset name")).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText("Provider")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Model id")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Temperature")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Top p")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Max tokens")).toHaveFocus();
    // The disabled reasoning control is skipped, as a disabled control should be.
    await user.tab();
    expect(screen.getByLabelText("Seed")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("System-prompt override")).toHaveFocus();
  });

  it("sends an explicit null when the user empties the system-prompt override", async () => {
    // The round-2 medium, at the surface that caused it. Round 1 omitted the
    // key when the field was empty, so the PATCH merge restored the old text
    // and every later Test still sent the deleted override.
    const user = userEvent.setup();
    const onSave = vi.fn(async (_input: ModelPresetInput) => {});
    render(
      <PresetEditor
        preset={{
          id: "mp_1",
          name: "Fast summariser",
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
          ref: "groq/llama-3.3-70b-versatile",
          hyperparameters: { temperature: 0.7 },
          systemPromptOverride: "Be terse.",
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        }}
        groups={GROUPS}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("System-prompt override"));
    await user.clear(screen.getByLabelText("Temperature"));
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    const [input] = onSave.mock.calls[0];
    expect(input.systemPromptOverride).toBeNull();
    expect(input.hyperparameters).toBeNull();
  });

  it("sends modal: null when a Modal preset moves to a chat provider", async () => {
    // The other half of the same defect: the merge re-attached the stored
    // `modal` block and the server refused the save with an error naming
    // nothing the user could act on.
    const user = userEvent.setup();
    const onSave = vi.fn(async (_input: ModelPresetInput) => {});
    render(
      <PresetEditor
        preset={{
          id: "mp_2",
          name: "Weights",
          providerId: "modal",
          modelId: "meta-llama/Llama-3.3-70B-Instruct",
          ref: "modal/meta-llama/Llama-3.3-70B-Instruct",
          modal: {
            huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
            gpuCount: 4,
            instanceId: "h100",
          },
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        }}
        groups={GROUPS}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "groq");
    await user.type(screen.getByLabelText("Model id"), "llama-3.3-70b-versatile");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    const [input] = onSave.mock.calls[0];
    expect(input.providerId).toBe("groq");
    expect(input.modal).toBeNull();
  });

  it("surfaces a save failure instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error("Unknown groq model \"nope\".");
    });
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={onSave} onCancel={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("Preset name"), "n");
    await user.type(screen.getByLabelText("Model id"), "nope");
    await user.click(screen.getByRole("button", { name: "Create preset" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown groq model");
  });
});
