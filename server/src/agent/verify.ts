/**
 * Runtime 3x adversarial verification.
 *
 * After a phase produces an output, we don't trust it on the strength of the model
 * that wrote it. Instead we convene N (default 3) INDEPENDENT adversarial reviewers,
 * each in a FRESH context — a separate chat() call with its own clean message array.
 * Each reviewer:
 *   - re-reads the ORIGINAL goal and the phase output from scratch,
 *   - is told it did NOT produce the output (so it has no ego stake in defending it),
 *   - must hunt for every flaw, unsupported claim, and gap,
 *   - ends with exactly "PASS" or "FAIL: <reasons>".
 *
 * A run PASSES only if all N reviewers PASS. We SHORT-CIRCUIT on the first FAIL — once
 * one reviewer rejects the output, the remaining passes can't change the verdict and
 * would only cost money, so we stop.
 *
 * Each pass's spend is real (a billed OpenRouter completion), so we ledger it as a
 * `verify` row (recordRun role:'verify', costStatus:'billed') and sum into costUsd, the
 * same way the council ledgers its deliberation. The verifier row keeps project budgets
 * accurate for verification spend.
 *
 * `chat` is DEPENDENCY-INJECTABLE: it defaults to the council's OpenRouter chat (the one
 * place that does id normalization + usage parsing), but tests pass a fake so the module
 * is exercised with zero live model calls.
 */
import { chat as councilChat } from "./council.ts";
import { recordRun } from "../cost/ledger.ts";

/** The default verifier model: a strong reasoner is worth the spend for a gate. */
const DEFAULT_VERIFIER_MODEL = "openrouter/anthropic/claude-opus-4.8";
const DEFAULT_PASSES = 3;

export type Verdict = "PASS" | "FAIL";

/**
 * The injectable chat surface. Object-arg shape (not the council's positional one) so a
 * caller/test reads at the call site, and flat token fields so a fake is trivial to build.
 */
export type ChatFn = (req: {
  model: string;
  messages: { role: string; content: string }[];
  signal?: AbortSignal;
}) => Promise<{ text: string; costUsd: number; tokensIn: number; tokensOut: number }>;

/**
 * Default ChatFn: adapt the council's `chat(model, messages, signal)` (positional args,
 * `tokens: {input, output, total}`) to the object-arg / flat-token ChatFn shape. This is
 * the ONLY place the two shapes are bridged, so the OpenRouter call path stays single-source.
 */
const defaultChat: ChatFn = async (req) => {
  const reply = await councilChat(
    req.model,
    // The council types message roles as a literal union; the verifier only ever sends
    // "system"/"user", which are valid members, so the cast is safe.
    req.messages as { role: "system" | "user" | "assistant"; content: string }[],
    req.signal,
  );
  return {
    text: reply.text,
    costUsd: reply.costUsd,
    tokensIn: reply.tokens.input,
    tokensOut: reply.tokens.output,
  };
};

const REVIEWER_SYSTEM =
  "You are an adversarial reviewer. You did NOT produce the output below — your job is to " +
  "tear it apart, not defend it. Re-read the original goal and the output from scratch and " +
  "find EVERY flaw: unsupported claims, factual errors, gaps, missed requirements, and ways " +
  "the output fails to actually achieve the goal. Be skeptical and specific. " +
  "End your reply with EXACTLY one line: 'PASS' if the output fully and correctly achieves " +
  "the goal with no material flaw, or 'FAIL: <reasons>' otherwise. The verdict must be the " +
  "last line.";

function reviewerUserMessage(goal: string, output: string): string {
  return (
    `ORIGINAL GOAL:\n${goal}\n\n` +
    `OUTPUT TO REVIEW (you did NOT write this):\n${output}\n\n` +
    "Review it adversarially, then give your verdict on the final line " +
    "('PASS' or 'FAIL: <reasons>')."
  );
}

/**
 * Parse a reviewer's verdict from the TAIL of its reply.
 *
 * The reviewer is told to end with the verdict line, so we scan from the bottom for the
 * first non-empty line and read it. A line that is "PASS" (case-insensitive, ignoring
 * surrounding punctuation/whitespace) is a PASS; anything else — including "FAIL: ..." or a
 * malformed/missing verdict — is treated as a FAIL. Failing closed is the safe default for a
 * gate: an unparseable verdict must not be allowed to pass silently.
 */
export function parseVerdict(text: string): { verdict: Verdict; critique: string } {
  const lines = text.split("\n");
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastLine = lines[i].trim();
      break;
    }
  }
  // Strip leading markdown/punctuation a model may prepend (e.g. "**PASS**", "- PASS").
  const cleaned = lastLine.replace(/^[\s*_#>`-]+/, "").replace(/[\s*_`]+$/, "");
  if (/^pass\b/i.test(cleaned) && !/^pass.*fail/i.test(cleaned)) {
    return { verdict: "PASS", critique: text.trim() };
  }
  return { verdict: "FAIL", critique: text.trim() };
}

export interface VerificationResult {
  passed: boolean;
  passes: Array<{ verdict: Verdict; critique: string }>;
  costUsd: number;
}

/**
 * Run up to N fresh-context adversarial reviews of `output` against `goal`. Short-circuits
 * on the first FAIL. Ledgers each pass as a `verify` row and returns the summed spend.
 */
export async function runAdversarialVerification(args: {
  goal: string;
  output: string;
  projectId: string;
  sessionId: string;
  passes?: number;
  model?: string;
  chat?: ChatFn;
  signal?: AbortSignal;
}): Promise<VerificationResult> {
  const totalPasses = args.passes ?? DEFAULT_PASSES;
  const model = args.model ?? DEFAULT_VERIFIER_MODEL;
  const chat = args.chat ?? defaultChat;

  const passes: Array<{ verdict: Verdict; critique: string }> = [];
  let costUsd = 0;

  for (let passIndex = 0; passIndex < totalPasses; passIndex++) {
    // FRESH context every pass: a brand-new message array, no carry-over from prior passes.
    const reply = await chat({
      model,
      messages: [
        { role: "system", content: REVIEWER_SYSTEM },
        { role: "user", content: reviewerUserMessage(args.goal, args.output) },
      ],
      signal: args.signal,
    });

    costUsd += reply.costUsd;
    // Ledger this pass's spend as a billed `verify` row so project budgets stay accurate.
    recordRun({
      sessionId: args.sessionId,
      projectId: args.projectId,
      model,
      role: "verify",
      costStatus: "billed",
      before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
      after: {
        costUsd: reply.costUsd,
        input: reply.tokensIn,
        output: reply.tokensOut,
        cacheRead: 0,
        total: reply.tokensIn + reply.tokensOut,
      },
    });

    const { verdict, critique } = parseVerdict(reply.text);
    passes.push({ verdict, critique });

    // Short-circuit: one FAIL settles the verdict; remaining passes can't change it.
    if (verdict === "FAIL") {
      return { passed: false, passes, costUsd };
    }
  }

  return { passed: true, passes, costUsd };
}
