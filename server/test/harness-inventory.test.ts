/**
 * `docs/inventory/f2-harness.json` is a snapshot of the registry table, not a
 * second hand-kept copy of it. This is what makes that true: the file is
 * regenerated from `WORKFLOW_HARNESS_REGISTRY` here and compared byte for byte,
 * so a registry edit that does not refresh the inventory fails the suite.
 *
 * On failure, write `expected` (printed below) to the inventory file.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_HARNESS_REGISTRY } from "../src/workflows/harness-registry.ts";

/**
 * The one fact the inventory carries that the registry does not: where each
 * literal stands against `docs/contracts/NODESPEC-V1.md`. Adding a harness means
 * adding a row here too, which is the point — the contract has to be updated for
 * it, and this is the reminder.
 */
const CONTRACT_STATUS: Record<string, string> = {
  pi: "bound",
  "claude-code": "bound",
  codex: "authorised-no-adapter",
  opencode: "authorised-no-adapter",
  copilot: "authorised-no-adapter",
  deepseek: "authorised-no-adapter",
  "grok-cli": "authorised-no-adapter",
  "oh-my-pi": "authorised-no-adapter",
};

const INVENTORY = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "inventory",
  "f2-harness.json",
);

function expectedInventory(): string {
  const snapshot = {
    version: 1,
    source: "server/src/workflows/harness-registry.ts",
    note:
      "Derived from the registry table, not hand-typed. server/test/harness-inventory.test.ts fails if this file and the registry disagree.",
    contract: "docs/contracts/NODESPEC-V1.md#harness-registry",
    harnesses: WORKFLOW_HARNESS_REGISTRY.map((definition) => ({
      id: definition.id,
      label: definition.label,
      executables: [...definition.executables],
      adapter: definition.adapter ?? null,
      adapterPresent: definition.adapter !== undefined,
      exposesBinaryPath: definition.exposesBinaryPath,
      contractStatus: CONTRACT_STATUS[definition.id],
      summary: definition.summary,
    })),
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

describe("harness inventory snapshot", () => {
  it("matches the registry exactly", () => {
    expect(fs.readFileSync(INVENTORY, "utf-8")).toBe(expectedInventory());
  });

  it("gives every registry harness a contract status", () => {
    for (const definition of WORKFLOW_HARNESS_REGISTRY) {
      expect(
        CONTRACT_STATUS[definition.id],
        `Harness ${definition.id} has no contract status; add it and describe the literal in docs/contracts/NODESPEC-V1.md.`,
      ).toBeTruthy();
    }
    expect(Object.keys(CONTRACT_STATUS).sort())
      .toEqual(WORKFLOW_HARNESS_REGISTRY.map((definition) => definition.id).sort());
  });
});
