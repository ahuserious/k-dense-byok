import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as dagWorkflows from "@/lib/dag-workflows";
import * as skillCurator from "@/lib/skill-curator";
import * as useProjects from "@/lib/use-projects";
import { SkillCuratorPanel } from "./skill-curator-panel";

afterEach(() => vi.restoreAllMocks());

function mockProject() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProjectId: "project-1",
    activeProject: { id: "project-1", name: "Project 1" },
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

describe("SkillCuratorPanel", () => {
  it("writes selected loaded skills into the saved node through the curator API", async () => {
    mockProject();
    vi.spyOn(dagWorkflows, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "workflow-1",
        name: "Workflow 1",
        revision: 3,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "a".repeat(64),
        schemaVersion: "1.0",
        description: null,
        nodeCount: 1,
        edgeCount: 0,
      },
    ]);
    vi.spyOn(skillCurator, "getSkillCuratorCapabilities").mockResolvedValue({
      promptElevation: {
        available: false,
        interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
        endpoint: null,
        reason: "F5 shared elevation is not available.",
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
      modelPresets: {
        available: false,
        endpoint: "/model-presets",
      },
    });
    const getSnapshot = vi.spyOn(skillCurator, "getSkillCuratorSnapshot")
      .mockResolvedValue({
        definition: {
          id: "workflow-1",
          revision: 3,
          graphSha256: "a".repeat(64),
        },
        skills: [
          {
            ref: "autoresearch-graph-architect",
            description: "Design a validated graph.",
            scope: "project",
            featured: true,
          },
          {
            ref: "autoresearch-squared",
            description: "Monitor a live run.",
            scope: "project",
            featured: true,
          },
        ],
        personalities: {
          available: false,
          storeRef: null,
          personalities: [],
          reason: "Pinned personality library unavailable.",
        },
        nodes: [
          {
            id: "node-1",
            name: "Research",
            kind: "agent",
            skillsMode: "manual",
            skillRefs: [],
            mimeographsMode: "auto",
            personalityRefs: [],
          },
        ],
      });
    const apply = vi.spyOn(skillCurator, "applySkillCuration").mockResolvedValue({
      definition: { revision: 4, graphSha256: "b".repeat(64) },
    });

    render(<SkillCuratorPanel />);

    await screen.findByText("autoresearch-graph-architect");
    await userEvent.click(
      screen.getByRole("switch", { name: "Attach autoresearch-graph-architect" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save node curation" }));

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(
        "workflow-1",
        {
          expectedRevision: 3,
          nodeIds: ["node-1"],
          skillRefs: ["autoresearch-graph-architect"],
          skillsMode: "manual",
          writeMode: "replace",
        },
        "project-1",
      )
    );
    expect(getSnapshot).toHaveBeenCalledWith("workflow-1", "project-1");
    expect(
      await screen.findByText(/Saved revision 4.*real NodeSpec references/i),
    ).toBeVisible();
  });

  it("renders the absent F5 adapter disabled with its reason", async () => {
    mockProject();
    vi.spyOn(dagWorkflows, "listDagWorkflowDefinitions").mockResolvedValue([]);
    vi.spyOn(skillCurator, "getSkillCuratorCapabilities").mockResolvedValue({
      promptElevation: {
        available: false,
        interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
        endpoint: null,
        reason: "F5 shared elevation is not available.",
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
      modelPresets: {
        available: false,
        endpoint: "/model-presets",
      },
    });

    render(<SkillCuratorPanel />);

    const button = await screen.findByRole("button", { name: "Elevate prompt to DAG" });
    expect(button).toBeDisabled();
    expect(screen.getByText("F5 shared elevation is not available.")).toBeVisible();
    expect(button).toHaveAttribute("aria-describedby", "prompt-elevation-disabled-reason");
  });
});
