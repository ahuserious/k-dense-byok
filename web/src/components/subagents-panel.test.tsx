import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentsLib from "@/lib/agents";
import * as useProjects from "@/lib/use-projects";
import { SubagentsPanel } from "@/components/subagents-panel";

vi.mock("@/components/skills", () => ({
  SkillCuratorPanel: () => <div>skill curator test stub</div>,
  AutoresearchMonitorPanel: () => <div>autoresearch monitor test stub</div>,
  WorkflowSupervisorSettings: () => <div>workflow supervisor test stub</div>,
}));

afterEach(() => vi.restoreAllMocks());

describe("SubagentsPanel toggle", () => {
  it("disables a specialist via the switch", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([
      { name: "oracle", description: "deep reasoning", source: "builtin", systemPrompt: "x", enabled: true },
    ]);
    const setSpy = vi.spyOn(agentsLib, "setAgentEnabled").mockResolvedValue();

    render(<SubagentsPanel />);
    await screen.findByText("oracle");
    await userEvent.click(screen.getByRole("switch", { name: /toggle oracle/i }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("oracle", false));
  });

  it("prefills a usable read-only scientific specialist and saves through the Agents API", async () => {
    vi.spyOn(useProjects, "useProjects").mockReturnValue({
      activeProject: { id: "p1", name: "P1" },
      activeProjectId: "p1",
    } as unknown as ReturnType<typeof useProjects.useProjects>);
    vi.spyOn(agentsLib, "getAgents").mockResolvedValue([]);
    const save = vi.spyOn(agentsLib, "saveAgent").mockResolvedValue({
      name: "causal-methodologist",
      description: "Review a scientific question using explicit evidence and uncertainty.",
      source: "project",
      systemPrompt: "saved",
    });

    render(<SubagentsPanel />);
    await screen.findByText(/No project agents yet/);
    await userEvent.click(
      screen.getByRole("button", { name: "Create scientific agent" }),
    );

    const name = screen.getByPlaceholderText("e.g. code-reviewer");
    await userEvent.type(name, "causal-methodologist");
    expect(screen.getByDisplayValue("read, grep, find, ls")).toBeVisible();
    expect(screen.getByRole("button", { name: "high" })).toBeVisible();
    expect(
      screen.getByDisplayValue(/You are a scientific specialist for this project/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add agent" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "causal-methodologist",
        expect.objectContaining({
          thinking: "high",
          tools: "read, grep, find, ls",
          inheritProjectContext: true,
          inheritSkills: true,
          systemPrompt: expect.stringMatching(/cite exact artifacts/i),
        }),
      )
    );
  });
});
