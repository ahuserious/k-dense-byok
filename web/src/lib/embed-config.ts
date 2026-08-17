// danbot-byok — web/src/lib/embed-config.ts
//
// Single source of truth for the URLs of the local engines Kady embeds via iframe.
// Previously NEXT_PUBLIC_PIPELINE_ENGINE_URL was re-declared in four places (the two iframe
// panels, the pipelines list, and engine-config.ts), which drifts. Everything now
// imports from here.
//
//   - PIPELINE_ENGINE_URL  : Pipeline engine's web UI (the visual builder canvas + the /console UI).
//   - RAINDROP_URL: Raindrop Workshop's local UI (the OSS agent-trace debugger).
//
// Both are overridable via NEXT_PUBLIC_* env so the embeds work regardless of the
// port the sidecars were pinned to.

const legacyPipelineEngineUrl = process.env.NEXT_PUBLIC_ARCHON_URL;
if (!process.env.NEXT_PUBLIC_PIPELINE_ENGINE_URL && legacyPipelineEngineUrl) {
  console.warn(
    "[deprecated] NEXT_PUBLIC_ARCHON_URL is deprecated; use NEXT_PUBLIC_PIPELINE_ENGINE_URL instead.",
  );
}

export const PIPELINE_ENGINE_URL =
  process.env.NEXT_PUBLIC_PIPELINE_ENGINE_URL ??
  legacyPipelineEngineUrl ??
  "http://localhost:3091";

// No default. The Workshop is an OPTIONAL external sibling checkout, so a
// `http://localhost:5899` fallback made every build embed whatever happens to
// listen on that port on the machine running the browser — in a hermetic
// preview that is a foreign dev server, with its own external egress and
// another person's sessions rendered inside the app. Unset means "not
// configured", and the Workshop surfaces say so instead of framing anything.
export const RAINDROP_URL: string | undefined =
  process.env.NEXT_PUBLIC_RAINDROP_URL || undefined;
