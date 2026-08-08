import { describe } from "vitest";

/** Secondary guard for live suites that also need an explicit runtime check. */
export const liveTestsEnabled = process.env.LIVE_TESTS === "1";

/**
 * Prefer an *.live.test.ts or *-live.test.ts filename so Vitest excludes the
 * whole file from gate-blocking discovery. This helper makes the convention
 * visible inside a live suite as well.
 */
export const describeLive = describe.skipIf(!liveTestsEnabled);
