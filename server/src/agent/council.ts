/**
 * Native `council` tool: a multi-model "AI Council" deliberation, in TypeScript.
 *
 * This is the in-process, no-sidecar alternative to running an external Python
 * "council" service. When the agent hits a high-stakes or genuinely ambiguous
 * question, it can convene a council:
 *
 *   1. A **panel** of advisor models each answer the question independently, in
 *      parallel (diverse models => diverse failure modes => fewer blind spots).
 *   2. Optionally one **debate** round: each advisor sees the others' answers and
 *      may revise (catches the cases where one model spotted what the rest missed).
 *   3. A **chair** model reads all the advisor answers and synthesizes a single
 *      consensus, calling out where the panel agreed and how it resolved conflicts.
 *
 * Every call is a direct OpenRouter chat-completion with usage accounting on, so
 * the deliberation's spend is real and known — we sum it and record a `council`
 * row in the cost ledger (recordCouncilRun) so project budgets stay accurate.
 * Because the calls are ours (not Pi's), nothing about this leaks past the BYOK
 * OpenRouter key the rest of the app already uses.
 *
 * Sub-agent child `pi` processes do not get this tool: it is for the interactive
 * agent's hard decisions, and it spends real money per call.
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MODEL_ID } from "../config.ts";
import { recordCouncilRun } from "../cost/ledger.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// The default council when the caller names neither a panel nor a chair. Overridable
// per-call (the `panel`/`chair` params) or globally (DANBOT_COUNCIL_PANEL / _CHAIR).
// Kept diverse on purpose; if an id isn't available on the user's account they can
// override it. The chair defaults to the app's own default model.
const FALLBACK_PANEL = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
];

function envList(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

function defaultPanel(): string[] {
  return envList("DANBOT_COUNCIL_PANEL") ?? FALLBACK_PANEL;
}
function defaultChair(): string {
  return process.env.DANBOT_COUNCIL_CHAIR?.trim() || DEFAULT_MODEL_ID.trim();
}

// k-dense model refs can carry a reasoning-effort suffix ("...-high") and an
// "openrouter/" routing prefix that the Pi SDK understands but a raw OpenRouter
// chat-completions call rejects. The council calls OpenRouter directly, so normalize:
// drop the prefix and a trailing -high/-medium/-low/-minimal. Worst case a real
// "-high" variant (o3-mini-high) collapses to its valid base (o3-mini) — a safe
// degradation, not a 400.
function normalizeModelId(id: string): string {
  const withoutPrefix = id.startsWith("openrouter/") ? id.slice("openrouter/".length) : id;
  return withoutPrefix.replace(/-(high|medium|low|minimal)$/, "");
}

function openRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY;
  if (!key) {
    throw new Error(
      "AI Council needs an OpenRouter key. Set OPENROUTER_API_KEY before convening a council.",
    );
  }
  return key;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
interface ModelReply {
  text: string;
  costUsd: number;
  tokens: { input: number; output: number; total: number };
}

/**
 * One OpenRouter chat completion with usage accounting; returns text + billed cost.
 *
 * Exported so other in-process features (e.g. the adversarial verifier) can reuse the
 * exact same OpenRouter call path — id normalization (drops "openrouter/" + an effort
 * suffix) and usage parsing — instead of re-deriving it and drifting. It is still the
 * council's own primitive; nothing about this exports the council's orchestration.
 */
export async function chat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ModelReply> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterKey()}`,
      "Content-Type": "application/json",
      "X-Title": "danbot-byok AI Council",
    },
    body: JSON.stringify({ model: normalizeModelId(model), messages, usage: { include: true } }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter ${response.status} for "${model}": ${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const usage = data.usage ?? {};
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    costUsd: Number(usage.cost ?? 0) || 0,
    tokens: {
      input: Number(usage.prompt_tokens ?? 0) || 0,
      output: Number(usage.completion_tokens ?? 0) || 0,
      total: Number(usage.total_tokens ?? 0) || 0,
    },
  };
}

export interface CouncilOptions {
  panel?: string[]; // advisor model ids
  chair?: string; // synthesizer model id
  debate?: boolean; // run one revision round where advisors see each other
  signal?: AbortSignal;
}

export interface CouncilResult {
  answer: string; // the chair's synthesized consensus
  chair: string; // the chair model used
  advisors: { model: string; answer: string }[]; // each advisor's final answer
  costUsd: number; // summed billed cost across every call
  tokens: { input: number; output: number; total: number };
}

const ADVISOR_SYSTEM =
  "You are one advisor on a deliberating council of AI models. Give your single best, " +
  "honest answer to the question, with a few words of reasoning. Be concise. If you are " +
  "uncertain, say so rather than bluffing.";

const DEBATE_SYSTEM =
  "You are an advisor revising your answer after reading your peers' answers. Keep what you " +
  "still believe, change your mind where a peer convinced you, and note briefly what shifted.";

const CHAIR_SYSTEM =
  "You are the chair of a council of AI advisors. Read the advisors' answers and synthesize " +
  "ONE clear consensus answer for the user. Note where the panel agreed, and where it " +
  "disagreed explain how you resolved it. Do not just average — judge.";

/**
 * Convene the council and return the synthesized answer plus the trail (advisor
 * answers + summed cost). Pure orchestration over `chat()`; no ledger/IO side
 * effects so it is easy to test directly.
 */
export async function runCouncil(
  question: string,
  opts: CouncilOptions = {},
): Promise<CouncilResult> {
  const panel = opts.panel?.length ? opts.panel : defaultPanel();
  const chair = opts.chair?.trim() || defaultChair();

  let costUsd = 0;
  const tokens = { input: 0, output: 0, total: 0 };
  const tally = (reply: ModelReply) => {
    costUsd += reply.costUsd;
    tokens.input += reply.tokens.input;
    tokens.output += reply.tokens.output;
    tokens.total += reply.tokens.total;
  };

  // Round 1: every advisor answers independently, in parallel. A single advisor's
  // failure (a bad model id, a transient error) shouldn't sink the whole council, so
  // failures are captured as a noted non-answer rather than thrown.
  const round1 = await Promise.all(
    panel.map(async (model) => {
      try {
        const reply = await chat(
          model,
          [
            { role: "system", content: ADVISOR_SYSTEM },
            { role: "user", content: question },
          ],
          opts.signal,
        );
        tally(reply);
        return { model, answer: reply.text, ok: true as const };
      } catch (err) {
        return { model, answer: `(no answer — ${(err as Error).message})`, ok: false as const };
      }
    }),
  );

  let advisors = round1.map((r) => ({ model: r.model, answer: r.answer }));

  // Optional debate round: each advisor that answered sees the others and may revise.
  if (opts.debate) {
    const peersText = advisors
      .map((a, i) => `Advisor ${i + 1} (${a.model}):\n${a.answer}`)
      .join("\n\n");
    advisors = await Promise.all(
      round1.map(async (r) => {
        if (!r.ok) return { model: r.model, answer: r.answer };
        try {
          const reply = await chat(
            r.model,
            [
              { role: "system", content: DEBATE_SYSTEM },
              {
                role: "user",
                content: `Question:\n${question}\n\nThe panel's answers:\n${peersText}\n\nYour revised answer:`,
              },
            ],
            opts.signal,
          );
          tally(reply);
          return { model: r.model, answer: reply.text };
        } catch {
          return { model: r.model, answer: r.answer }; // keep round-1 answer on failure
        }
      }),
    );
  }

  // The chair synthesizes the final consensus from the (possibly revised) panel.
  const panelText = advisors
    .map((a, i) => `Advisor ${i + 1} (${a.model}):\n${a.answer}`)
    .join("\n\n");
  const chairReply = await chat(
    chair,
    [
      { role: "system", content: CHAIR_SYSTEM },
      {
        role: "user",
        content: `Question:\n${question}\n\nThe advisors' answers:\n${panelText}\n\nYour synthesized consensus answer:`,
      },
    ],
    opts.signal,
  );
  tally(chairReply);

  return { answer: chairReply.text, chair, advisors, costUsd, tokens };
}

export const CouncilParams = Type.Object({
  question: Type.String({
    description: "The question or decision for the council to deliberate.",
  }),
  panel: Type.Optional(
    Type.Array(Type.String(), {
      description: "Advisor model ids (OpenRouter). Defaults to the configured panel.",
    }),
  ),
  chair: Type.Optional(
    Type.String({ description: "Synthesizer model id. Defaults to the configured chair." }),
  ),
  debate: Type.Optional(
    Type.Boolean({
      description: "Run one revision round where advisors see each other's answers (costs more).",
    }),
  ),
});

export type CouncilParamsT = Static<typeof CouncilParams>;

/**
 * Build the `council` ToolDefinition for one project session. `getSessionId` is a
 * late-bound getter (the tool is constructed before the session exists), matching the
 * holder pattern used by the interview tool and the subagent ledger extension.
 */
export function makeCouncilTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof CouncilParams> {
  return {
    name: "council",
    label: "AI Council",
    description: [
      "Convene a council of multiple AI models to deliberate a hard question and return a single synthesized consensus answer.",
      "A panel of advisor models each answer independently; a chair model then synthesizes the consensus. Set `debate: true` to add one round where advisors revise after seeing each other.",
      "Use for high-stakes, ambiguous, or contested decisions where one model's answer isn't enough — not for routine questions (it makes several model calls and costs real money).",
      "Returns the chair's consensus answer; the per-advisor answers and the deliberation cost are in the tool details.",
    ].join("\n"),
    promptSnippet:
      "council: convene multiple AI models to deliberate a hard question and synthesize a consensus answer",
    promptGuidelines: [
      "Reach for `council` only on genuinely hard or high-stakes calls (architecture decisions, risk judgments, contested tradeoffs) — it is several times the cost of a single answer.",
      "Phrase the `question` so an advisor can answer it standalone; include the key context inline.",
    ],
    parameters: CouncilParams,
    // Makes several network calls; never run it concurrently with other tools.
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const result = await runCouncil(params.question, {
        panel: params.panel,
        chair: params.chair,
        debate: params.debate,
        signal,
      });
      // The council's spend lives outside Pi's session stats (we made the calls), so
      // record it as a `council` ledger row to keep project budgets accurate.
      recordCouncilRun(projectId, getSessionId(), `council:${result.advisors.length}+chair`, {
        cost: result.costUsd,
        tokens: result.tokens,
      });
      const trail = result.advisors
        .map((a, i) => `Advisor ${i + 1} (${a.model}): ${a.answer}`)
        .join("\n\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `${result.answer}\n\n---\nCouncil cost: $${result.costUsd.toFixed(4)} · chair: ${result.chair}\n\n${trail}`,
          },
        ],
        details: {
          answer: result.answer,
          chair: result.chair,
          advisors: result.advisors,
          costUsd: result.costUsd,
        },
      };
    },
  };
}
