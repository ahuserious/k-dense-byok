import { describe, expect, it } from "vitest";

import {
  blockedSaveStatus,
  issueLine,
  issueLocation,
} from "@/components/builder/issue-text";
import type { BuilderIssue } from "@/lib/builder-bridge";

function issue(overrides: Partial<BuilderIssue> = {}): BuilderIssue {
  return {
    code: "workflow/invalid",
    severity: "error",
    path: "/nodes/1/name",
    message: "must NOT have fewer than 1 characters",
    ...overrides,
  };
}

describe("issueLocation", () => {
  it("prefers the node id, which is what an author can find on the canvas", () => {
    expect(issueLocation(issue({ nodeId: "analyze" }))).toBe("node analyze");
  });

  it("prefers the edge id over the JSON pointer", () => {
    expect(issueLocation(issue({ edgeId: "research-to-report" }))).toBe(
      "edge research-to-report",
    );
  });

  it("falls back to the JSON pointer when the validator names no node or edge", () => {
    // The typed validate route emits no nodeId/edgeId today, so this is the
    // path a real blocked save actually takes.
    expect(issueLocation(issue())).toBe("/nodes/1/name");
  });

  it("treats a document-root pointer as no location rather than printing '/'", () => {
    expect(issueLocation(issue({ path: "/" }))).toBeNull();
    expect(issueLocation(issue({ path: "" }))).toBeNull();
  });
});

describe("issueLine", () => {
  it("puts the location in front of the validator's own message", () => {
    expect(issueLine(issue({ nodeId: "analyze", message: "must have a name" }))).toBe(
      "node analyze: must have a name",
    );
  });

  it("is the bare message when there is nowhere to point", () => {
    expect(issueLine(issue({ path: "/", message: "must have at least one node" }))).toBe(
      "must have at least one node",
    );
  });
});

describe("blockedSaveStatus", () => {
  it("states the problem, not a count", () => {
    // The whole point of the change: "1 issue(s) block this save." told an
    // author how much was wrong and never what.
    const status = blockedSaveStatus([issue({ path: "/nodes", message: "must NOT have fewer than 1 items" })]);

    expect(status).toBe("Cannot save — /nodes: must NOT have fewer than 1 items");
    expect(status).not.toMatch(/\d+ issue/);
  });

  it("headlines the first problem and counts the rest, so the line stays one line", () => {
    expect(
      blockedSaveStatus([
        issue({ nodeId: "a", message: "first" }),
        issue({ nodeId: "b", message: "second" }),
        issue({ nodeId: "c", message: "third" }),
      ]),
    ).toBe("Cannot save — node a: first (+2 more)");
  });

  it("headlines the blocking error, never a warning that precedes it", () => {
    // The typed validator marks every blocking issue an error today, so this
    // only bites once a warning channel exists — which is exactly when a
    // warning headlining a refused save would be wrong.
    expect(
      blockedSaveStatus([
        issue({ severity: "warning", nodeId: "a", message: "consider a shorter name" }),
        issue({ severity: "error", nodeId: "b", message: "must have a name" }),
      ]),
    ).toBe("Cannot save — node b: must have a name (+1 more)");
  });

  it("still says something when the validator refuses without naming an issue", () => {
    expect(blockedSaveStatus([])).toBe("This workflow cannot be saved yet.");
  });
});
