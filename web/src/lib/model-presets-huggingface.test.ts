import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HF_NOT_CONFIGURED_REASON,
  searchHuggingFaceModels,
} from "@/lib/model-presets-huggingface";

/**
 * The Hugging Face chooser's client, written against lane F12's FINAL wire
 * contract rather than against their module (which lives on their branch).
 *
 * The assertions that matter are the fail-closed ones: a 503 NOT_CONFIGURED and
 * a 404 both resolve to a state the editor renders as a DISABLED control with a
 * visible reason. There is deliberately no free-text fallback — F12's interface
 * names that as the accepted-then-discarded pattern this wave exists to stop.
 */

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hugging Face model search", () => {
  it("asks the endpoint F12 specifies, with the search and limit", async () => {
    fetchMock.mockResolvedValue(json({ models: [] }));

    await searchHuggingFaceModels("llama 3", 5);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/integrations/huggingface/models");
    expect(String(url)).toContain("search=llama%203");
    expect(String(url)).toContain("limit=5");
  });

  it("makes NO request at all for an empty query", async () => {
    const result = await searchHuggingFaceModels("   ");
    expect(result).toEqual({ ok: true, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the unconfigured state on 503, carrying the variable NAME", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          code: "NOT_CONFIGURED",
          envVar: "HF_TOKEN",
          detail: "Hugging Face is not configured. Set HF_TOKEN to search models.",
        },
        503,
      ),
    );

    const result = await searchHuggingFaceModels("llama");

    expect(result).toMatchObject({ ok: false, kind: "unconfigured", envVar: "HF_TOKEN" });
    expect(HF_NOT_CONFIGURED_REASON).toBe("Set HF_TOKEN to search Hugging Face models");
  });

  it("reports an absent route honestly rather than as a Hugging Face outage", async () => {
    // The state in this clone until lane F12 merges.
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));

    const result = await searchHuggingFaceModels("llama");

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    expect((result as { detail: string }).detail).toMatch(/not available in this build/);
  });

  it("degrades a malformed-but-200 body to an error state instead of throwing", async () => {
    // #62 one layer down: nothing here may throw into a render phase.
    fetchMock.mockResolvedValue(json({ models: "nope" }));

    const result = await searchHuggingFaceModels("llama");

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("drops a row with no id rather than rendering a blank option", async () => {
    fetchMock.mockResolvedValue(
      json({
        models: [
          { id: "org/name", pipelineTag: "text-generation", gated: false },
          { pipelineTag: "text-generation" },
          { id: "", gated: "manual" },
        ],
      }),
    );

    const result = await searchHuggingFaceModels("llama");

    expect(result).toEqual({
      ok: true,
      models: [
        {
          id: "org/name",
          pipelineTag: "text-generation",
          libraryName: null,
          gated: false,
          downloads: null,
          likes: null,
        },
      ],
    });
  });

  it("returns a state rather than throwing when the server is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await searchHuggingFaceModels("llama");

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  });
});
