// danbot-byok — web/src/lib/embed-config.ts
//
// Single source of truth for the URLs of the local engines Kady embeds via iframe.
// Previously NEXT_PUBLIC_ARCHON_URL was re-declared in four places (the two iframe
// panels, the pipelines list, and archon-config.ts), which drifts. Everything now
// imports from here.
//
//   - ARCHON_URL  : Archon's web UI (the visual builder canvas + the /console UI).
//   - RAINDROP_URL: Raindrop Workshop's local UI (the OSS agent-trace debugger).
//
// Both are overridable via NEXT_PUBLIC_* env so the embeds work regardless of the
// port the sidecars were pinned to.

export const ARCHON_URL =
  process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

export const RAINDROP_URL =
  process.env.NEXT_PUBLIC_RAINDROP_URL ?? "http://localhost:5899";
