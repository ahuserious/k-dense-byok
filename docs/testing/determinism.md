# Deterministic and live server tests

The gate-blocking server command is `cd server && npm test`. It discovers the
normal `test/**/*.test.ts` suite while excluding `*.live.test.ts` and
`*-live.test.ts`. During that run, the shared setup clears provider credentials,
so a missing provider stub cannot silently turn into a paid call with ambient
developer credentials.

Existing deterministic tests use one of these seams:

- inject a fake `fetch` function for one request;
- run a plain HTTP server on loopback for route/proxy behavior;
- inject a fake Pi/provider session for agent behavior;
- replay an ordered provider cassette with
  `server/test/stubs/provider-http.ts` when a multi-request protocol benefits
  from a checked request/response transcript.

Cassettes belong under `server/test/stubs/cassettes/<provider>/`. Their prompts
and responses must be synthetic. The harness never records authorization
headers, redacts sensitive query values, and retains only a small response
header allowlist, but request and response bodies are necessarily preserved for
exact replay and still require human review.

Live model tests are nightly and non-blocking. Name their files
`*.live.test.ts` or `*-live.test.ts`, use `describeLive` from
`server/test/stubs/live.ts`, and run them with:

```bash
cd server
LIVE_TESTS=1 npm test
```

Provider-specific credentials and opt-ins remain additional requirements. For
example, the existing Modal smoke also requires `MODAL_LIVE_TEST=1` and Modal
credentials. Recording a cassette is deliberately stricter than merely running
a live test:

```bash
cd server
LIVE_TESTS=1 RECORD_PROVIDER_HTTP=1 npm test -- path/to/example.live.test.ts
```

Replay is always the default. Committed cassettes are immutable test inputs;
refresh one only in a live, reviewed change and never from a gate command.
