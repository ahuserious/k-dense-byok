import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as skillCurator from "@/lib/skill-curator";
import * as useProjects from "@/lib/use-projects";
import { WorkflowSupervisorSettings } from "./workflow-supervisor-settings";

afterEach(() => vi.restoreAllMocks());

function mockProject() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProjectId: "project-1",
    activeProject: { id: "project-1", name: "Project 1" },
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

const settings: skillCurator.DurabilitySettingsV1 = {
  version: 1,
  enabled: false,
  watcherModel: { kind: "preset", presetId: "preset-watcher", effort: "high" },
  rescueModel: { kind: "preset", presetId: "preset-rescue", effort: "xhigh" },
  rescueEffort: "xhigh",
  minRescueContextWindow: 1_000_000,
  stallMs: 300_000,
  stopPolicy: { allowStop: true, maxStopsPerRun: 1 },
  signals: {
    compaction: { enabled: true, action: "escalate", threshold: 1 },
    "context-rot": { enabled: true, action: "escalate", threshold: 1 },
    hallucination: { enabled: false, action: "observe", threshold: 1 },
    "paused-no-progress": { enabled: false, action: "restart", threshold: 1 },
    "failed-script-run": { enabled: false, action: "observe", threshold: 1 },
    "failed-skill-fire": { enabled: false, action: "observe", threshold: 1 },
  },
};

describe("WorkflowSupervisorSettings", () => {
  it("is honestly disabled when F14's shared endpoint is absent", async () => {
    mockProject();
    vi.spyOn(skillCurator, "getSkillCuratorCapabilities").mockResolvedValue({
      promptElevation: {
        available: false,
        interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
        endpoint: null,
        reason: "F5 unavailable.",
      },
      runStateCritiques: {
        readsLiveRunState: true,
        persistedToRunState: false,
        reason: "RunState v1 is frozen.",
      },
      durability: {
        available: false,
        settingsEndpoint: "/durability/settings",
        signalsEndpoint: "/durability/signals",
        ownsStore: false,
      },
      modelPresets: { available: false, endpoint: "/model-presets" },
    });
    vi.spyOn(skillCurator, "getDurabilityAdapterState").mockResolvedValue({
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: "Durability settings endpoint not available on this build.",
    });
    vi.spyOn(skillCurator, "getModelPresetAdapterState").mockResolvedValue({
      available: false,
      presets: [],
      reason: "Model presets are not available on this build.",
    });

    render(<WorkflowSupervisorSettings />);

    const button = await screen.findByRole("button", {
      name: "Enable workflow supervisor",
    });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("Durability settings endpoint not available on this build."),
    ).toBeVisible();
    expect(button).toHaveAttribute(
      "aria-describedby",
      "durability-settings-disabled-reason",
    );
  });

  it("writes preset ids and settings only through F14's PUT adapter", async () => {
    mockProject();
    vi.spyOn(skillCurator, "getSkillCuratorCapabilities").mockResolvedValue({
      promptElevation: {
        available: false,
        interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
        endpoint: null,
        reason: "F5 unavailable.",
      },
      runStateCritiques: {
        readsLiveRunState: true,
        persistedToRunState: false,
        reason: "RunState v1 is frozen.",
      },
      durability: {
        available: true,
        settingsEndpoint: "/durability/settings",
        signalsEndpoint: "/durability/signals",
        ownsStore: false,
      },
      modelPresets: { available: true, endpoint: "/model-presets" },
    });
    const state = {
      available: true,
      settings,
      signals: [
        {
          id: "compaction" as const,
          label: "Compaction",
          observable: true,
          observability: "full" as const,
          observationSource: "durable run events",
          firesWhen: "a compaction check fails",
          supportedActions: ["observe", "escalate"] as skillCurator.DurabilityAction[],
          thresholdLabel: "Failed checks",
        },
      ],
      resolution: {},
      reason: null,
    };
    vi.spyOn(skillCurator, "getDurabilityAdapterState").mockResolvedValue(state);
    vi.spyOn(skillCurator, "getModelPresetAdapterState").mockResolvedValue({
      available: true,
      presets: [
        { id: "preset-watcher", name: "Watcher" },
        { id: "preset-rescue", name: "Rescue" },
      ],
      reason: null,
    });
    const save = vi.spyOn(skillCurator, "saveDurabilitySettings")
      .mockResolvedValue({ ...state, settings: { ...settings, enabled: true } });

    render(<WorkflowSupervisorSettings />);

    await userEvent.click(await screen.findByRole("switch", { name: "Watch workflow runs" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save shared supervisor settings" }),
    );

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          watcherModel: {
            kind: "preset",
            presetId: "preset-watcher",
            effort: "high",
          },
          rescueModel: {
            kind: "preset",
            presetId: "preset-rescue",
            effort: "xhigh",
          },
        }),
        "project-1",
      )
    );
    expect(
      await screen.findByText("Saved through the shared durability settings API."),
    ).toBeVisible();
  });
});
