import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PresetEditor } from "@/components/model-presets/preset-editor";
import type { ModelPresetInput, ProviderGroupStatus } from "@/lib/model-presets";

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

  it("offers the Hugging Face model and a working GPU stepper for Modal", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(
      <PresetEditor preset={null} groups={GROUPS} onSave={onSave} onCancel={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Provider"), "modal");
    await user.type(screen.getByLabelText("Preset name"), "Llama on GPUs");
    await user.type(
      screen.getByLabelText("Hugging Face model"),
      "meta-llama/Llama-3.3-70B-Instruct",
    );

    const gpuCount = screen.getByLabelText("GPU count");
    expect(gpuCount).toHaveValue(1);
    await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    await user.click(screen.getByRole("button", { name: "Increase GPU count" }));
    expect(gpuCount).toHaveValue(3);
    await user.click(screen.getByRole("button", { name: "Decrease GPU count" }));
    expect(gpuCount).toHaveValue(2);
    // Never below one, however hard the user leans on it.
    for (let index = 0; index < 5; index += 1) {
      await user.click(screen.getByRole("button", { name: "Decrease GPU count" }));
    }
    expect(gpuCount).toHaveValue(1);

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
          gpuCount: 1,
        },
      }),
    );
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
