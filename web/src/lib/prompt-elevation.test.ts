import { describe, expect, it } from "vitest";

import {
  assessElevationReadiness,
  ELEVATION_API_UNAVAILABLE_REASON,
  ELEVATION_QUESTION,
  NO_SESSION_REASON,
} from "./prompt-elevation";

describe("ELEVATION_QUESTION", () => {
  it("is the master brief's row-17 sentence, verbatim", () => {
    expect(ELEVATION_QUESTION).toBe("Elevate workflow to a durable scientific DAG pipeline?");
  });
});

describe("assessElevationReadiness", () => {
  it("fails closed on a populated conversation until F5 publishes the shared API", () => {
    expect(assessElevationReadiness("session-a")).toEqual({
      kind: "unavailable",
      blocker: "F5-elevate-to-dag",
      reason: ELEVATION_API_UNAVAILABLE_REASON,
    });
  });

  it("names both blockers before a conversation exists", () => {
    const readiness = assessElevationReadiness(null);
    expect(readiness.kind).toBe("unavailable");
    expect(readiness.reason).toContain(NO_SESSION_REASON);
    expect(readiness.reason).toContain(ELEVATION_API_UNAVAILABLE_REASON);
  });

  it("does not invent an endpoint or leak a filesystem path", () => {
    const text = JSON.stringify(assessElevationReadiness("session-a"));
    expect(text).not.toMatch(/\/(?:api|Users|home|tmp)\//);
    expect(text).not.toContain("session-dag-projection-promote");
  });
});
