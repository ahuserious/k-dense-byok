// danbot-byok — web/src/lib/prompt-elevation.ts
//
// Row 17 is one entry point into lane F5's shared elevate-to-DAG engine/API.
// Rows 17 (Chat), 26 (node), and 43 (skill) must call that ONE capability.
//
// The interrupted round-1 implementation incorrectly treated the older
// Console "promote session" helper as the shared elevator. That helper emits a
// lossy sequence of agent nodes and is not F5's elevate-to-DAG contract. Calling
// it here would create a second, behaviorally different elevator.
//
// No F5 elevation interface is published in this checkout. This module is
// therefore deliberately tiny and fail-closed. When F5 publishes its interface,
// the follow-up patch stays narrow: add the typed client here, change this
// readiness result only after the endpoint is present, and let the existing
// panel call that client. Do not import the Console promotion helper.

/** The question the panel asks, verbatim from master-brief row 17. */
export const ELEVATION_QUESTION =
  "Elevate workflow to a durable scientific DAG pipeline?";

export const NO_SESSION_REASON =
  "Send a message first — there is no conversation to elevate yet.";

/**
 * §6.7's honest disabled reason. It names the missing capability, not a
 * speculative URL, because F5 has not published a wire contract yet.
 */
export const ELEVATION_API_UNAVAILABLE_REASON =
  "This build does not include the shared elevate-to-DAG service yet. Elevation is disabled so Chat, DAG nodes, and skills cannot create different pipeline drafts.";

export interface ElevationReadiness {
  kind: "unavailable";
  blocker: "F5-elevate-to-dag";
  reason: string;
}

export function assessElevationReadiness(sessionId: string | null): ElevationReadiness {
  return {
    kind: "unavailable",
    blocker: "F5-elevate-to-dag",
    reason: sessionId
      ? ELEVATION_API_UNAVAILABLE_REASON
      : `${NO_SESSION_REASON} ${ELEVATION_API_UNAVAILABLE_REASON}`,
  };
}
