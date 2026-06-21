// danbot-byok — council.live.test.ts
//
// Live proof of the native TS AI Council (checklist 74/75): convene a panel + chair
// against real OpenRouter models and confirm the council returns a correct synthesized
// answer with a captured (>= 0) cost. Gated on OPENROUTER_API_KEY so the suite still
// passes offline / in CI without a key. Uses the app's configured default model for
// every seat (guaranteed valid with the user's key) and a trivial prompt to keep spend tiny.

import { describe, it, expect } from "vitest";
import { runCouncil } from "../src/agent/council.ts";
import { DEFAULT_MODEL_ID } from "../src/config.ts";

const hasKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY);
const itLive = hasKey ? it : it.skip;

describe("AI Council (live OpenRouter)", () => {
  itLive(
    "convenes a panel + chair and synthesizes a correct consensus",
    async () => {
      const model = DEFAULT_MODEL_ID.trim();
      const result = await runCouncil("In one word, what is the capital of France?", {
        panel: [model, model],
        chair: model,
      });

      expect(result.advisors).toHaveLength(2);
      expect(result.chair).toBe(model);
      expect(result.answer.length).toBeGreaterThan(0);
      // The whole point: the synthesized answer is actually right.
      expect(result.answer.toLowerCase()).toContain("paris");
      // Cost was captured (>= 0; > 0 for any non-free model).
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    },
    60_000,
  );
});
