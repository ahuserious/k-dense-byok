import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDurabilityAdapterState,
  getSkillCuratorSnapshot,
} from "./skill-curator";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("skill curator client response guards", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects a malformed-but-200 curator response before a component renders it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      definition: null,
      skills: "not-an-array",
      nodes: [],
    }));

    await expect(
      getSkillCuratorSnapshot("workflow-1", "project-1"),
    ).rejects.toThrow("Skill curator returned malformed data.");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Project-Id"))
      .toBe("project-1");
  });

  it("turns an absent F14 endpoint into data without probing a second store", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { message: "Route GET:/durability/settings not found" },
      404,
    ));

    await expect(getDurabilityAdapterState("project-1")).resolves.toEqual({
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: "Durability settings endpoint not available on this build.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
