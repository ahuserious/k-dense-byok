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
  it("leads with the node id, which is what an author can find on the canvas", () => {
    // "/nodes/1" is an index the canvas never renders. The route resolves it to
    // the id, and the id is what goes first.
    expect(issueLocation(issue({ nodeId: "analyze" }))).toBe("node analyze (/name)");
  });

  it("leads with the edge id", () => {
    expect(
      issueLocation(issue({ path: "/edges/0/to", edgeId: "research-to-report" })),
    ).toBe("edge research-to-report (/to)");
  });

  it("keeps the field the id cannot say, so naming the node costs nothing", () => {
    // The shape an author reaches by mis-picking in a dropdown. Replacing the
    // pointer outright would trade "which field" for "which node"; this keeps
    // both.
    expect(
      issueLocation(
        issue({ path: "/nodes/1/workspace/isolation", nodeId: "review-council" }),
      ),
    ).toBe("node review-council (/workspace/isolation)");
  });

  it("is the bare id when the issue points at the whole node", () => {
    expect(issueLocation(issue({ path: "/nodes/1", nodeId: "review-council" }))).toBe(
      "node review-council",
    );
  });

  it("keeps an unrecognised pointer whole beside the id rather than dropping it", () => {
    // Defensive: every id this tree produces comes with a matching
    // "/nodes/<i>" prefix, but a pointer that does not match must not lose its
    // field to the strip.
    expect(issueLocation(issue({ path: "/artifacts/0/writerNodeId", nodeId: "analyze" })))
      .toBe("node analyze (/artifacts/0/writerNodeId)");
  });

  it("falls back to the JSON pointer when the issue names no node or edge", () => {
    // "/entryNodeId" and "/nodes" point at no single entity, so the route sends
    // no id and the pointer is the whole location.
    expect(issueLocation(issue())).toBe("/nodes/1/name");
    expect(issueLocation(issue({ path: "/entryNodeId" }))).toBe("/entryNodeId");
  });

  it("treats a document-root pointer as no location rather than printing '/'", () => {
    expect(issueLocation(issue({ path: "/" }))).toBeNull();
    expect(issueLocation(issue({ path: "" }))).toBeNull();
  });
});

describe("issueLine", () => {
  it("puts the location in front of the validator's own message", () => {
    expect(
      issueLine(issue({ path: "/nodes/0", nodeId: "analyze", message: "must have a name" })),
    ).toBe("node analyze: must have a name");
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
        issue({ path: "/nodes/0", nodeId: "a", message: "first" }),
        issue({ path: "/nodes/1", nodeId: "b", message: "second" }),
        issue({ path: "/nodes/2", nodeId: "c", message: "third" }),
      ]),
    ).toBe("Cannot save — node a: first (+2 more)");
  });

  it("headlines the blocking error, never a warning that precedes it", () => {
    // The typed validator marks every blocking issue an error today, so this
    // only bites once a warning channel exists — which is exactly when a
    // warning headlining a refused save would be wrong.
    expect(
      blockedSaveStatus([
        issue({
          severity: "warning",
          path: "/nodes/0",
          nodeId: "a",
          message: "consider a shorter name",
        }),
        issue({ severity: "error", path: "/nodes/1", nodeId: "b", message: "must have a name" }),
      ]),
    ).toBe("Cannot save — node b: must have a name (+1 more)");
  });

  it("still says something when the validator refuses without naming an issue", () => {
    expect(blockedSaveStatus([])).toBe("This workflow cannot be saved yet.");
  });
});
