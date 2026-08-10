# S1b cross-lane integration handoff

## Pipeline list disconnect propagation

S1b gives `pipelineEngine.listWorkflows(signal?)` a client-owned timeout and an
optional caller `AbortSignal`. The S4-owned `GET /pipelines` handler remains
unchanged in this lane.

After merging S1b, S4 should create a request-scoped `AbortController`, abort it
when `req.raw` emits `close`, and remove that listener when the proxy call
settles. The required call-site change is:

```ts
return await pipelineEngine.listWorkflows(requestAbortController.signal);
```

`requestAbortController` must be wired to the inbound request's `close` event;
Node's `IncomingMessage` does not itself expose an `AbortSignal`. This makes a
browser disconnect cancel the already-bounded outbound sidecar fetch without
changing response or error mapping semantics.
