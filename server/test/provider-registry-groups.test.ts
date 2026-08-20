import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_GROUPS,
  PROVIDER_GROUP_IDS,
  credentialVariablesPresent,
  directDispatchSupport,
  providerGroup,
  providerGroupForRef,
  providerGroupModelRef,
  resolveProviderGroups,
} from "../src/agent/providers/registry.ts";
import { SUBSCRIPTION_PROVIDER_IDS } from "../src/agent/provider-auth.ts";

/**
 * The provider-group registry is the reconciliation of Kady's two disagreeing
 * provider lists. These tests pin the reconciliation itself — that all eight
 * owner-named groups exist, that each records which list it projects from, and
 * that "configured" is decided from a variable NAME rather than from a probe.
 */
describe("provider-group registry", () => {
  it("declares exactly the eight owner-named groups, in order", () => {
    expect([...PROVIDER_GROUP_IDS]).toEqual([
      "cerebras",
      "openai",
      "openrouter",
      "anthropic",
      "groq",
      "xai",
      "local",
      "modal",
    ]);
    expect(PROVIDER_GROUPS.map((group) => group.id)).toEqual([
      ...PROVIDER_GROUP_IDS,
    ]);
  });

  it("records the delta between the two lists rather than hiding it", () => {
    // Neither existing list can carry the eight groups: this asserts the fact
    // the audit reported, so a future edit that quietly "fixes" one list by
    // stuffing the other's ids into it fails here.
    const subscriptionIds = new Set<string>(SUBSCRIPTION_PROVIDER_IDS);
    const projectedFromSubscriptions = PROVIDER_GROUPS.filter(
      (group) => group.projectsFrom === "subscription-providers",
    ).map((group) => group.subscriptionProviderId);
    expect(projectedFromSubscriptions).toEqual(["openai-codex", "anthropic", "xai"]);
    for (const providerId of projectedFromSubscriptions) {
      expect(subscriptionIds.has(String(providerId))).toBe(true);
    }
    // github-copilot is a subscription provider with no preset group, and that
    // is a decision: it must stay out of the eight.
    expect(
      PROVIDER_GROUPS.some((group) => group.subscriptionProviderId === "github-copilot"),
    ).toBe(false);

    expect(
      PROVIDER_GROUPS.filter((group) => group.projectsFrom === "runtime-registry").map(
        (group) => group.id,
      ),
    ).toEqual(["openrouter", "local"]);
    expect(
      PROVIDER_GROUPS.filter((group) => group.projectsFrom === "none").map(
        (group) => group.id,
      ),
    ).toEqual(["cerebras", "groq", "modal"]);
  });

  it("names the environment variables Groq and Cerebras need", () => {
    expect(providerGroup("groq")?.credentialVariableNames).toEqual(["GROQ_API_KEY"]);
    expect(providerGroup("cerebras")?.credentialVariableNames).toEqual([
      "CEREBRAS_API_KEY",
    ]);
    expect(providerGroup("modal")?.credentialVariableNames).toEqual([
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
    ]);
    expect(providerGroup("modal")?.credentialMode).toBe("all");
  });

  it("treats an empty or whitespace-only variable as unset", () => {
    const groq = providerGroup("groq")!;
    expect(credentialVariablesPresent(groq, {})).toBe(false);
    expect(credentialVariablesPresent(groq, { GROQ_API_KEY: "" })).toBe(false);
    expect(credentialVariablesPresent(groq, { GROQ_API_KEY: "   " })).toBe(false);
    expect(credentialVariablesPresent(groq, { GROQ_API_KEY: "x" })).toBe(true);
  });

  it("requires BOTH Modal variables and ANY OpenRouter variable", () => {
    const modal = providerGroup("modal")!;
    expect(credentialVariablesPresent(modal, { MODAL_TOKEN_ID: "a" })).toBe(false);
    expect(
      credentialVariablesPresent(modal, { MODAL_TOKEN_ID: "a", MODAL_TOKEN_SECRET: "b" }),
    ).toBe(true);
    const openrouter = providerGroup("openrouter")!;
    expect(credentialVariablesPresent(openrouter, { OR_API_KEY: "a" })).toBe(true);
  });

  it("reports every group, with a reason naming the next action when unconfigured", async () => {
    const hasSubscriptionLogin = vi.fn(async () => false);
    const groups = await resolveProviderGroups({ hasSubscriptionLogin, env: {} });
    expect(groups.map((group) => group.id)).toEqual([...PROVIDER_GROUP_IDS]);
    for (const group of groups) {
      expect(group.configured).toBe(false);
      expect(group.notConfiguredReason).toBeTruthy();
      // #71: user-facing error text must never leak a filesystem path.
      expect(group.notConfiguredReason).not.toMatch(/\/(Users|home|tmp|var)\//);
    }
    expect(groups.find((group) => group.id === "groq")?.notConfiguredReason).toContain(
      "GROQ_API_KEY",
    );
    expect(
      groups.find((group) => group.id === "cerebras")?.notConfiguredReason,
    ).toContain("CEREBRAS_API_KEY");
  });

  it("marks an api-key group configured from the variable and never probes it", async () => {
    const hasSubscriptionLogin = vi.fn(async () => false);
    const groups = await resolveProviderGroups({
      hasSubscriptionLogin,
      env: { GROQ_API_KEY: "not-a-real-key" },
    });
    const groq = groups.find((group) => group.id === "groq");
    expect(groq?.configured).toBe(true);
    expect(groq?.notConfiguredReason).toBeUndefined();
    // The OAuth checker is only consulted for the three subscription groups.
    expect(hasSubscriptionLogin).toHaveBeenCalledTimes(3);
    // Nothing in the response echoes a credential value.
    expect(JSON.stringify(groups)).not.toContain("not-a-real-key");
  });

  it("uses Kady's local OAuth state for the subscription groups", async () => {
    const hasSubscriptionLogin = vi.fn(
      async (providerId: string) => providerId === "anthropic",
    );
    const groups = await resolveProviderGroups({ hasSubscriptionLogin, env: {} });
    expect(groups.find((group) => group.id === "anthropic")?.configured).toBe(true);
    expect(groups.find((group) => group.id === "openai")?.configured).toBe(false);
    expect(groups.find((group) => group.id === "xai")?.configured).toBe(false);
  });

  it("builds canonical refs, keeping the local server inside the model id", () => {
    expect(providerGroupModelRef("groq", "llama-3.3-70b-versatile")).toBe(
      "groq/llama-3.3-70b-versatile",
    );
    expect(providerGroupModelRef("openai", "gpt-5.6-sol")).toBe("openai-codex/gpt-5.6-sol");
    expect(providerGroupModelRef("local", "ollama/llama3")).toBe("ollama/llama3");
    expect(providerGroupModelRef("local", "openai-compatible/qwen/qwen3-8b")).toBe(
      "openai-compatible/qwen/qwen3-8b",
    );
  });

  it("maps a ref back to its group, and both local runtimes to `local`", () => {
    expect(providerGroupForRef("groq/llama-3.3-70b-versatile")).toBe("groq");
    expect(providerGroupForRef("cerebras/llama3.1-8b")).toBe("cerebras");
    expect(providerGroupForRef("ollama/llama3")).toBe("local");
    expect(providerGroupForRef("openai-compatible/x")).toBe("local");
    expect(providerGroupForRef("openai-codex/gpt-5.6-sol")).toBe("openai");
    // github-copilot has no preset group; it must not be reinterpreted as one.
    expect(providerGroupForRef("github-copilot/claude-sonnet-5")).toBeUndefined();
  });

  it("says which parameters each provider accepts, so a control can disable", () => {
    // Modal is a compute job, not a chat call: every sampling control is
    // unsupported and the editor renders all five disabled with a reason.
    expect(providerGroup("modal")?.parameterSupport).toEqual({
      temperature: false,
      topP: false,
      maxTokens: false,
      reasoningEffort: false,
      seed: false,
    });
    expect(providerGroup("modal")?.dispatchableAsChatModel).toBe(false);
    expect(providerGroup("groq")?.parameterSupport.reasoningEffort).toBe(false);
    expect(providerGroup("groq")?.parameterSupport.seed).toBe(true);
    expect(providerGroup("anthropic")?.parameterSupport.seed).toBe(false);
    expect(providerGroup("anthropic")?.parameterSupport.reasoningEffort).toBe(true);
  });

  /**
   * The predicate that gates the ▶ Test control, the `direct` binding row and
   * `dispatchPresetCompletion`. Pinned per group so a later change to
   * `kind` or to the group list cannot quietly re-enable a control over a call
   * Kady cannot build — the round-1 defect this closes.
   */
  it("says exactly which groups Kady can build a preset call for", () => {
    const supported = PROVIDER_GROUPS.filter(
      (group) => directDispatchSupport(group).supported,
    ).map((group) => group.id);
    expect(supported).toEqual(["cerebras", "openrouter", "groq"]);

    for (const groupId of ["openai", "anthropic", "xai", "local", "modal"] as const) {
      const support = directDispatchSupport(providerGroup(groupId)!);
      expect(support.supported).toBe(false);
      // A refusal with no stated reason is a disabled control with no
      // explanation, which §6.7 forbids.
      expect(support.reason).toBeTruthy();
      expect(support.reason).not.toMatch(/\/(Users|home|tmp|var)\//);
    }
  });

  it("refuses an api-key group whose model speaks another API", () => {
    const groq = providerGroup("groq")!;
    expect(directDispatchSupport(groq, { api: "openai-completions" }).supported).toBe(true);
    expect(directDispatchSupport(groq, { api: "anthropic-messages" }).supported).toBe(false);
  });

  it("never reports a group as configured-and-dispatchable that has no credential name", () => {
    // The structural version of the same rule: a group Kady would send a
    // bearer token for must name the variable that token comes from.
    for (const group of PROVIDER_GROUPS) {
      if (!directDispatchSupport(group).supported) continue;
      expect(group.kind).toBe("api-key");
      expect(group.credentialVariableNames.length).toBeGreaterThan(0);
    }
  });
});
