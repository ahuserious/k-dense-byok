import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/projects", () => ({ apiFetch }));

import {
  isRaindropReference,
  listRaindropChatSessions,
  loadRaindropContext,
} from "./raindrop";

beforeEach(() => vi.clearAllMocks());

describe("Raindrop client contract", () => {
  it("accepts only typed ids and normalizes the ordinary-session list", async () => {
    expect(isRaindropReference({ kind: "session", id: "session-1" })).toBe(true);
    expect(isRaindropReference({ kind: "run", id: `wrun_${"a".repeat(32)}` })).toBe(true);
    expect(isRaindropReference({ kind: "session", id: "../escape" })).toBe(false);
    expect(isRaindropReference({ kind: "session", id: "session-1", path: "/tmp/log" })).toBe(false);

    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify([
      {
        id: "session-new",
        name: null,
        firstMessage: "  Analyze   this dataset  ",
        created: 1,
        modified: 3,
        messageCount: 2,
      },
      {
        id: "session-empty",
        name: "Empty",
        created: 1,
        modified: 2,
        messageCount: 0,
      },
      { id: "../escape", created: 1, modified: 4, messageCount: 2 },
    ]), { status: 200 }));

    await expect(listRaindropChatSessions("project-a")).resolves.toEqual([{
      id: "session-new",
      title: "Analyze this dataset",
      created: 1,
      modified: 3,
      messageCount: 2,
    }]);
    expect(apiFetch).toHaveBeenCalledWith("/sessions", {}, "project-a");
  });

  it("posts only the selected reference and rejects a mismatched server projection", async () => {
    const source = { kind: "session" as const, id: "session-1" };
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      source,
      context: "bounded context",
      truncated: false,
      observedEntries: 2,
      totalEntries: 2,
    }), { status: 200 }));

    await expect(loadRaindropContext("project-a", source)).resolves.toMatchObject({
      source,
      context: "bounded context",
    });
    const request = apiFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual(source);
    expect(request.body).not.toContain("path");

    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      source: { kind: "session", id: "different-session" },
      context: "wrong context",
      truncated: false,
      observedEntries: 1,
      totalEntries: 1,
    }), { status: 200 }));
    await expect(loadRaindropContext("project-a", source)).rejects.toThrow(
      "invalid payload",
    );
  });
});
