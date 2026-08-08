# Provider HTTP test stubs

Gate-blocking tests use injected fetch functions, fake provider sessions, local
loopback servers, or ordered cassettes from this directory. Keep cassette data
synthetic and store it under `cassettes/<provider>/` beside the harness.

Live tests use an `*.live.test.ts` or `*-live.test.ts` filename and the
`describeLive` helper. `LIVE_TESTS=1` opts into discovery. Cassette recording is
a separate, deliberate action requiring both `LIVE_TESTS=1` and
`RECORD_PROVIDER_HTTP=1`; review every recorded file for sensitive prompts or
provider data before committing it.
