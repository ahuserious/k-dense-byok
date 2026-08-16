// Cloud-run configuration for the S11 outer loop.
//
// Stably's cloud browser launches Chromium on THEIR runner (see
// @stablyai/playwright-test's cloud-runner-launch-options), so the app under test must be reachable
// from the public internet -- 127.0.0.1 is not. The owner authorised an ngrok tunnel for this, and a
// local proxy multiplexes the web app and the vendored engine onto that single hostname because
// ngrok's free tier reserves one domain and two tunnels sharing it round-robin.
//
// Two things this file adds on top of the committed config:
//   1. baseURL comes from KADY_E2E_BASE_URL (the tunnel origin).
//   2. ngrok's free tier serves a browser interstitial to any browser user-agent -- every path, not
//      just the root -- so without this header the runner loads ngrok's warning page instead of the
//      app. extraHTTPHeaders applies to top-level navigation, iframes and XHR alike.
//
// The Kady backend (port 18000) is deliberately NOT exposed: the suite intercepts all of its traffic
// at the browser boundary, so the remote runner never requests it, and it is where credentials live.
import baseConfig from "./playwright.config";

const tunnelOrigin = process.env.KADY_E2E_BASE_URL;
if (!tunnelOrigin) {
  throw new Error(
    "KADY_E2E_BASE_URL must be the public tunnel origin for a cloud run; refusing to fall back to " +
      "127.0.0.1, which would silently test nothing from a remote runner.",
  );
}

export default {
  ...baseConfig,
  // Cloud latency is the reason these differ from the local config, and ONLY these differ.
  // Every asset crosses the internet twice (Stably runner -> ngrok edge -> this machine), so the
  // local budgets (45s test / 10s expect) expire during fixture setup. Raising a transport timeout
  // does not weaken any assertion -- no expectation is relaxed, the suite merely gets time to load.
  // Observed locally-direct ~2s/test, through the tunnel ~37s/test.
  timeout: 180_000,
  expect: { timeout: 45_000 },
  workers: 3,

  use: {
    ...baseConfig.use,
    baseURL: tunnelOrigin,
    extraHTTPHeaders: {
      ...(baseConfig.use?.extraHTTPHeaders ?? {}),
      "ngrok-skip-browser-warning": "1",
      // Binds captured transport traffic to ONE Stably run: the same nonce goes into the run's
      // suiteName (which Stably records) and into every request header (which the proxy records),
      // so provenance is tied to a specific run rather than merely contemporaneous with one.
      ...(process.env.KADY_E2E_RUN_NONCE ? { "x-s11-run-nonce": process.env.KADY_E2E_RUN_NONCE } : {}),
    },
  },
};
