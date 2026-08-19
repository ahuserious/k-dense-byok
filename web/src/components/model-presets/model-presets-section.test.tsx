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
    configured: false,
    notConfiguredReason:
      "Cerebras is not configured. Set CEREBRAS_API_KEY in your environment file and restart Kady.",
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
    configured: true,
  },
];

const BINDINGS = {
  direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
  "chat-session": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: "Chat uses this preset's provider and model, but not its sampling parameters.",
  },
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
      return json({ presets: [GROQ_PRESET, MODAL_PRESET], groups: GROUPS, bindings: BINDINGS });
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
    for (const label of ["Cerebras", "Groq", "Modal"]) {
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
    expect(within(notice).getByText("Carried")).toBeVisible();
    expect(within(notice).getAllByText("Not carried")).toHaveLength(3);
    expect(
      within(notice).getByText(/Workflow nodes take their sampling parameters/),
    ).toBeVisible();
  });

  it("disables Test for a Modal preset, which is a compute job not a completion", async () => {
    render(<ModelPresetsSection />);
    await screen.findByText("Llama on GPUs");
    expect(screen.getByRole("button", { name: "Test preset Llama on GPUs" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Test preset Fast summariser" }),
    ).toBeEnabled();
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
        return json({ presets: [GROQ_PRESET], groups: GROUPS, bindings: BINDINGS });
      }
      return json({});
    });
    render(<ModelPresetsSection />);
    await screen.findByText("Fast summariser");

    await user.click(screen.getByRole("button", { name: "Test preset Fast summariser" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("GROQ_API_KEY");
  });
});
