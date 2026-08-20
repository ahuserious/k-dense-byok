import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPresetsSection } from "@/components/model-presets/model-presets-section";

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GROUPS = [
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "api-key",
    projectsFrom: "none",
    runtimeProviderIds: ["cerebras"],
    credentialVariableNames: ["CEREBRAS_API_KEY"],
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: false,
      seed: true,
    },
    dispatchableAsChatModel: true,
    directDispatch: { supported: true },
    configured: false,
    notConfiguredReason:
      "Cerebras is not configured. Set CEREBRAS_API_KEY in your environment file and restart Kady.",
  },
  {
    // The group the round-1 defect was about: connected, a chat model, and a
    // call Kady cannot build. `directDispatch.supported` is false and carries
    // the reason the UI shows.
    id: "anthropic",
    label: "Anthropic",
    kind: "oauth-subscription",
    projectsFrom: "subscription-providers",
    runtimeProviderIds: ["anthropic"],
    credentialVariableNames: [],
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: true,
      seed: false,
    },
    dispatchableAsChatModel: true,
    directDispatch: {
      supported: false,
      reason:
        "Kady sends a preset's parameters as an OpenAI-shaped chat completion authenticated with an API key. Anthropic is connected with a subscription login instead, so Kady cannot send that call and this preset's hyperparameters and system-prompt override are not carried on it.",
    },
    configured: true,
  },
  {
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
    directDispatch: { supported: true },
    configured: true,
  },
  {
    id: "modal",
    label: "Modal",
    kind: "compute",
    projectsFrom: "none",
    runtimeProviderIds: [],
    credentialVariableNames: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    parameterSupport: {
      temperature: false,
      topP: false,
      maxTokens: false,
      reasoningEffort: false,
      seed: false,
    },
    dispatchableAsChatModel: false,
    directDispatch: {
      supported: false,
      reason:
        "Modal presets describe a compute job rather than a chat model, so there is no completion to send. Use Run on Modal instead.",
    },
    configured: true,
  },
];

const SHARED_DROPPED = {
  "workflow-node": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Workflow nodes take their sampling parameters from the node's own settings.",
  },
  "hosted-fusion-supervised": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Hosted Fusion nodes take their sampling parameters from the node's own settings.",
  },
};

/**
 * `direct` is per GROUP, because it is not one fact: Kady builds the preset
 * call for an API-key OpenAI-completions group and cannot build it for an OAuth,
 * Local or Modal one. Round 1 served a single global "bound" here.
 */
const BINDINGS_BY_GROUP = {
  cerebras: {
    direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
    "chat-session": { hyperparameters: "bound", systemPromptOverride: "bound" },
    ...SHARED_DROPPED,
  },
  groq: {
    direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
    "chat-session": { hyperparameters: "bound", systemPromptOverride: "bound" },
    ...SHARED_DROPPED,
  },
  anthropic: {
    direct: {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason:
        "Kady sends a preset's parameters as an OpenAI-shaped chat completion authenticated with an API key. Anthropic is connected with a subscription login instead, so Kady cannot send that call and this preset's hyperparameters and system-prompt override are not carried on it.",
    },
    "chat-session": {
      hyperparameters: "dropped",
      systemPromptOverride: "bound",
      reason:
        "Anthropic chat uses Pi's subscription transport, whose sampling payload is provider-specific.",
    },
    ...SHARED_DROPPED,
  },
  modal: {
    direct: {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason:
        "Modal presets describe a compute job rather than a chat model, so there is no completion to send. Use Run on Modal instead.",
    },
    "chat-session": {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason: "Modal presets describe a compute job rather than a chat model.",
    },
    ...SHARED_DROPPED,
  },
};

const GROQ_PRESET = {
  id: "mp_groq",
  name: "Fast summariser",
  providerId: "groq",
  modelId: "llama-3.3-70b-versatile",
  ref: "groq/llama-3.3-70b-versatile",
  hyperparameters: { temperature: 0.2, maxTokens: 400 },
  systemPromptOverride: "Be terse.",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const ANTHROPIC_PRESET = {
  id: "mp_anthropic",
  name: "Careful Opus",
  providerId: "anthropic",
  modelId: "claude-opus-4-8",
  ref: "anthropic/claude-opus-4-8",
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
  modal: { huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct", gpuCount: 4 },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/model-presets")) {
      return json({
        presets: [GROQ_PRESET, ANTHROPIC_PRESET, MODAL_PRESET],
        groups: GROUPS,
        bindingsByGroup: BINDINGS_BY_GROUP,
      });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Model presets section", () => {
  it("groups presets by provider and shows every group's configured state", async () => {
    render(<ModelPresetsSection />);

    expect(
      await screen.findByRole("heading", { name: "Model presets" }),
    ).toBeVisible();
    expect(await screen.findByText("Fast summariser")).toBeVisible();
    expect(screen.getByText("Llama on GPUs")).toBeVisible();

    // Every group appears, configured or not — never hidden.
    for (const label of ["Cerebras", "Groq", "Anthropic", "Modal"]) {
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    }
    // An unconfigured group states why and names the variable to set.
    expect(screen.getByText(/CEREBRAS_API_KEY/)).toBeVisible();
    // State is not colour-only: the badge carries the words.
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
  });

  it("summarises what a preset will send", async () => {
    render(<ModelPresetsSection />);
    expect(
      await screen.findByText(
        /groq\/llama-3\.3-70b-versatile · temp 0\.2 · 400 max tokens · system prompt override/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/4 GPUs/)).toBeVisible();
  });

  it("states per surface whether the parameters are carried", async () => {
    render(<ModelPresetsSection />);
    const notice = (await screen.findByText("Where these parameters apply")).closest(
      "div",
    ) as HTMLElement;
    // `direct` is summarised by the groups that DO carry it, not asserted once
    // for all eight — Anthropic and Modal do not, and each says so on its own
    // row above.
    expect(within(notice).getAllByText(/Carried on Cerebras, Groq/)).toHaveLength(2);
    expect(within(notice).getAllByText("Not carried")).toHaveLength(2);
    expect(
      within(notice).getByText(/system prompt only on Anthropic/),
    ).toBeVisible();
    expect(
      within(notice).getByText(/Workflow nodes take their sampling parameters/),
    ).toBeVisible();
  });

  it("states per GROUP whether the Test call carries the parameters", async () => {
    // The round-1 defect at its surface: an Anthropic preset's owner was told
    // "Carried" about a call Kady cannot build.
    render(<ModelPresetsSection />);
    await screen.findByText("Fast summariser");

    expect(screen.getAllByText(/Test preset carries these parameters\./)).toHaveLength(2);
    expect(screen.getAllByText(/Test preset unavailable\./)).toHaveLength(2);
    expect(
      screen.getByText(/Anthropic is connected with a subscription login instead/),
    ).toBeVisible();
  });

  it("disables Test for a group Kady cannot build the call for, with a visible reason", async () => {
    render(<ModelPresetsSection />);
    await screen.findByText("Careful Opus");

    // Connected, a chat model, and still not testable — round 1 rendered this
    // control live on `configured && dispatchableAsChatModel`.
    const anthropicTest = screen.getByRole("button", { name: "Test preset Careful Opus" });
    expect(anthropicTest).toBeDisabled();
    // The reason is on screen and announced, not hidden in a title attribute.
    expect(anthropicTest).toHaveAttribute("aria-describedby", "group-reason-anthropic");
    expect(document.getElementById("group-reason-anthropic")).toHaveTextContent(
      /subscription login instead/,
    );

    expect(
      screen.getByRole("button", { name: "Test preset Fast summariser" }),
    ).toBeEnabled();
  });

  it("offers Run on Modal for a Modal preset instead of a Test it cannot send", async () => {
    render(<ModelPresetsSection />);
    await screen.findByText("Llama on GPUs");
    // A Modal preset is a compute job. It gets the action it can actually
    // perform, not a disabled copy of a chat action.
    expect(screen.queryByRole("button", { name: "Test preset Llama on GPUs" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Run preset Llama on GPUs on Modal" }),
    ).toBeEnabled();
  });

  it("runs a Modal preset and reports the model and GPU count that were submitted", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/modal-job") && (init as RequestInit | undefined)?.method === "POST") {
        return json({
          presetId: "mp_modal",
          jobId: "job_7",
          state: "queued",
          request: { instance: "h100", gpuCount: 4, command: "python -c ..." },
          huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
        });
      }
      if (url.endsWith("/model-presets")) {
        return json({
          presets: [GROQ_PRESET, ANTHROPIC_PRESET, MODAL_PRESET],
          groups: GROUPS,
          bindingsByGroup: BINDINGS_BY_GROUP,
        });
      }
      return json({});
    });
    render(<ModelPresetsSection />);
    await screen.findByText("Llama on GPUs");

    await user.click(
      screen.getByRole("button", { name: "Run preset Llama on GPUs on Modal" }),
    );

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("job_7");
    expect(status).toHaveTextContent("meta-llama/Llama-3.3-70B-Instruct");
    expect(status).toHaveTextContent("4 GPUs");
  });

  it("creates a preset through the editor and reloads the list", async () => {
    const user = userEvent.setup();
    render(<ModelPresetsSection />);
    await screen.findByText("Fast summariser");

    await user.click(screen.getByRole("button", { name: /Model preset/ }));
    const form = screen.getByRole("form", { name: "New model preset" });
    await user.type(within(form).getByLabelText("Preset name"), "Second");
    await user.selectOptions(within(form).getByLabelText("Provider"), "groq");
    await user.type(within(form).getByLabelText("Model id"), "llama-3.1-8b-instant");
    await user.click(within(form).getByRole("button", { name: "Create preset" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/model-presets") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
      name: "Second",
      providerId: "groq",
      modelId: "llama-3.1-8b-instant",
    });
  });

  it("degrades to an error state on a malformed-but-200 list response", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith("/model-presets") ? json({ presets: "nope" }) : json({}),
    );
    render(<ModelPresetsSection />);

    // #62: a malformed success body must not throw during render.
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not read/i);
  });

  it("reports a failed provider call rather than pretending it worked", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/test") && (init as RequestInit | undefined)?.method === "POST") {
        return json(
          {
            detail:
              "Groq is not configured. Set GROQ_API_KEY in your environment file and restart Kady.",
          },
          409,
        );
      }
      if (url.endsWith("/model-presets")) {
        return json({ presets: [GROQ_PRESET], groups: GROUPS, bindingsByGroup: BINDINGS_BY_GROUP });
      }
      return json({});
    });
    render(<ModelPresetsSection />);
    await screen.findByText("Fast summariser");

    await user.click(screen.getByRole("button", { name: "Test preset Fast summariser" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("GROQ_API_KEY");
  });
});
