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

## Project-bound workflow routing

The current S4-owned `GET /pipelines` handler ignores the active project's
working directory/codebase identity, and the current engine list response is
only `{ workflow, source }`. S1b therefore labels vendored rows as `Project
scope unverified` and blocks duplicate names rather than guessing a route.

The cross-lane integration task must complete both parts together:

1. Resolve the active project's sandbox cwd and engine `codebaseId` in the
   `/pipelines` proxy, then pass that scope through workflow list, get, edit,
   and run calls. The corresponding engine endpoints must filter and resolve
   within that supplied codebase scope.
2. Extend the engine list contract to return a stable filename or workflow id
   for every record. Persist that identifier in the registry source and use it,
   rather than `workflow.name`, for get/edit/run routing.

Do not remove the S1b scope advisory or duplicate-name routing block until an
integration test proves that the proxy forwards project scope and the engine
round-trips the stable identifier through list and get/edit/run.
