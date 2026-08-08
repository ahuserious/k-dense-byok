/**
 * Gate-blocking tests start without provider credentials. Existing tests then
 * opt into injected fake credentials only alongside their fetch/session stub.
 * Live files are excluded from discovery unless LIVE_TESTS=1.
 */
if (process.env.LIVE_TESTS !== "1") {
  for (const credential of [
    "ANTHROPIC_API_KEY",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "NVIDIA_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OR_API_KEY",
    "XAI_API_KEY",
  ]) {
    delete process.env[credential];
  }
}
