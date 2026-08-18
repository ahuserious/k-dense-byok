# Scientific DAG Studio ownership

Phase R uses one writer per path. The globs below are authoritative for the
inventoried surfaces in `docs/inventory/`; planned globs reserve files that do
not exist yet. `node scripts/ownership-check.mjs` verifies that every current
inventory path is owned exactly once.

| Lane | Scope | Owned globs |
| --- | --- | --- |
| C1 | Vendored builder dist freshness and launcher safety | `.github/workflows/tests.yml`; `docs/preview-env.md`; `package.json`; `.github/workflows/ownership-authorization.yml`; `scripts/{ownership-check,ownership-check.test,vendored-dist-*}.mjs`; `server/test/pipelines-disabled.test.ts`; `server/test/pipelines.test.ts` (unowned on the base; C1 owns it for the disabled crash-window recovery tests); reviewed handoffs from R1, S2, S4, S5, and S11 listed in the policy. |
| C3 | Hosted and live E2E evidence | `playwright.{cloud,live-alt}.config.ts`; `scripts/hosted-evidence-*.mjs`; reviewed handoffs from C1, R1, and S11 listed in the policy. |
| C5 | Preview credential and environment-root isolation | `config/token-ban.json`; `server/src/{env,environment-files,legacy-engine-data,path-containment,projects,sandbox-fs}.ts`; `server/src/api/credentials.ts`; `server/test/{credential-env-isolation,env-isolation,project-repository-containment}.test.ts`; reviewed handoffs from C1, R1, S4, and S11 listed in the policy. |
| R1 | Orchestrator-held shared root files (policy files are handled separately as policy-controlled paths) | `.gitignore`; handed off to lanes for scoped edits (see handoffs). |
| C4 | Definition CAS prerequisite (S4 design §C4) | `docs/inventory/c4-cas.json`; the previously un-inventoried tests `server/test/{workflow-store,dag-workflows-api,chat-turn-runs-adapter,raindrop-context,steer-abort,workflow-controller}.test.ts`, `web/src/lib/dag-workflows.test.ts`; product paths via reviewed handoffs from S5, S4, S1, S1b, S10, S11 (returned per the design's post-C4 return map). |
| V1 | Verification fixes from the human-sim campaigns a9b34a39 and 0aa5eafc (2026-08-17) | `docs/inventory/v1-verification.json`; the previously un-inventoried `web/src/components/{project-view,project-view.test,persistent-workspace-surfaces.test,workflows-panel.test,helper-agent-chat.test,workspace-navigation.test}.tsx, `web/src/components/ai-elements/speech-input{,.test}.tsx`; product paths via reviewed handoffs from S1, S1b, S10, S2, S8, S11 (returned when V1 lands). |
| W1 | Owner punch-list 2026-08-17, Kady shell side (no Components Studio entry/effects, DAG-builder assistant in the Builder rail, Raindrop analyst copy) | `docs/inventory/w1-builder-shell.json`; un-inventoried `web/src/components/{dag-builder-surface.test,raindrop-panel.test}.tsx`; product paths via reviewed handoffs from S1, S9, V1. |
| W2 | Owner punch-list 2026-08-17, vendored builder side (zoom/fitView, explicit expand, no effects, no legacy-brand text, harness pre-selection) | `docs/inventory/w2-vendored-builder.json`; un-inventoried vendored `WorkflowBuilder/BuilderToolbar/StatusBar/CanvasChatPopout/WorkflowList.tsx`, `experiments/console/components/AddProjectDialog.tsx` + `index.css`; product paths via reviewed handoffs from S3. |
| W3 | Authoring path (owner direction 2026-08-17): typed-document adapter — builder loads Kady typed workflows and library items, stitches workflows (flatten on save), harness reaches the runtime; plan s11/fusion/w3w4-fused-plan.md | `docs/inventory/w3-authoring-path.json`; new server/web/vendored-host files by glob (validate/import routes, compose, import-library, typed-graph-view, typed-canvas-adapter, builder-bridge, dag-helper-patch, dag-compose, web/src/components/builder/**, vendored src/host/**); product paths via reviewed handoffs from S1, S2, S5, S4, S1b, S10, S3, W2, S11. |
| W4 | Console live graphs (owner direction 2026-08-17): running DAG runs + every open project/chat as a live graph, promote-to-DAG | `docs/inventory/w4-console-live-graphs.json`; new files by glob (session-dag-projection*, dag-run-graph-projection*, console-live-sources*, console/live-*.tsx, docs/inventory/run-state-v1-*.md); product paths via reviewed handoffs from S1, S8, S11. |
| S8B | Helper-session server gaps behind the Builder chat (2026-08-18): context-free dag-builder sessions and an honest profile prompt | `docs/inventory/s8b-helper-sessions.json`, `server/src/agent/raindrop-context.ts` (previously uninventoried); product paths via reviewed handoffs from S7, S8 and C4. |
| NT1 | Rescue guidance inside the canonical Scientific DAG Studio seed skill (A10 use clause) | `docs/inventory/nt1-rescue-skill.json`, `server/seed/skills/scientific-dag-studio/SKILL.md`, `server/seed/skills/scientific-dag-studio/references/rescue-playbook.md`, `server/test/rescue-skill-content.test.ts`. `server/test/helper-sessions.test.ts` is uninventoried; NT1 must request an amendment rather than edit it. |
| S1 | Consolidation and typed-surface removal | `web/src/app/page.tsx`; `web/src/components/{workspace-navigation,persistent-workspace-surfaces,dag-builder-surface,dag-builder,dag-builder-canvas,dag-builder-inspector,dag-workflow-console}.{ts,tsx}`; `web/src/lib/{workspace-persistence,dag-workflow-builder,dag-workflows}.ts` |
| S1b | Scientific Pipelines cross-engine registry | `web/src/components/dag-workflows-panel.tsx`; `web/src/components/dag-workflows-panel.test.tsx`; `web/src/lib/scientific-pipeline-registry.ts`; `web/src/lib/scientific-pipeline-registry.test.ts`; `server/test/pipeline-engine-client.test.ts`; `docs/lanes/S1b-INTEGRATION.md` |
| S2 | Vendor integration and naming sweep | `start.mjs`; `server/src/agent/pipeline-engine/**`; `server/src/agent/skills.ts`; `web/src/components/{pipelines-panel,pipeline-builder-panel,engine-iframe-panel}.tsx`; `web/src/lib/{engine-config,embed-config,pipelines}.ts`; vendor attribution files (`LICENSE`, `NOTICE*`, `VENDORED-FROM.md`) |
| S3 | Node-card UX and DAG node persistence | `server/vendor/pipeline-engine/packages/web/src/components/workflows/{DagNodeComponent,DagNodeProgress,NodeInspector,NodePalette,NodeLibrary,QuickAddPicker,CommandPicker,StatusIcon}.{ts,tsx}` and their same-basename tests; `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.tsx`; `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.test.ts`; `server/vendor/pipeline-engine/packages/web/src/components/workflows/YamlCodeView.tsx`; `server/vendor/pipeline-engine/packages/web/src/components/canvasui/Liquid.tsx`; `server/vendor/pipeline-engine/packages/web/src/hooks/useBuilderValidation.ts`; `server/vendor/pipeline-engine/packages/web/src/lib/{api.ts,api.generated.d.ts,dag-layout.ts}`; `server/vendor/pipeline-engine/packages/workflows/src/schemas/{dag-node,index}.ts`; `server/vendor/pipeline-engine/packages/workflows/src/{loader,node-spec-enforcement,node-spec-execution.test}.ts`; `server/vendor/pipeline-engine/packages/server/src/routes/api.nodespec-settings.integration.test.ts` |
| S4 | Runner policy, bindings, billing, and ledger | `server/src/api/{dag-workflows,pipelines}.ts`; `server/src/agent/{workflow-model-resolution,workflow-delegation-session}.ts`; `server/src/cost/{billing,ledger}.ts`; `server/src/workflows/{budget,kady-node-executor,supervised-budget}.ts`; `server/src/workflows/supervisor/{credential-contract,credentials}.ts`; `web/src/components/database-selector.tsx` |
| S5 | Engine behavior and deliberation store | Typed runtime files in `server/src/workflows/` not reserved by S4, S6, or S7; `server/src/config.ts`; `server/src/api/raindrop.ts`; `server/src/agent/subagents.ts`; planned `server/src/{personality-store/**,agent/personality-store*.ts,api/personality-store*.ts}`; `server/vendor/pipeline-engine/packages/workflows/src/dag-executor.ts`; `server/vendor/pipeline-engine/packages/workflows/src/dag-executor.test.ts`; specifically the schema, state, registry, store, validation, execution, controller, service, evidence, Fusion, Lean4, import, and supervisor runtime/protocol files enumerated in `docs/inventory/ownership.json` |
| S6 | Prompt-optimization node | `server/src/workflows/prompt-opt*.ts`; `web/src/components/prompt-opt*.tsx`; `web/src/lib/prompt-opt*.ts` (reserved; no implementation exists at this inventory point) |
| S7 | Context/compaction watcher | `server/src/index.ts`; `server/src/api/context-engineering.ts`; `server/src/agent/{dag-fusion-bridge,session-registry}.ts`; `server/pi-packages/dag-fusion-drive/compaction-audit.ts`; `web/src/components/context-usage-indicator.{ts,tsx}`; planned `server/src/workflows/{context,compaction}-watcher*.ts`, `server/src/context/lateral-pass*`, and `web/src/components/{context,compaction}-watcher*.tsx` |
| S8 | Chat live graph and chat-turn adapter | `server/src/api/sessions.ts`; `server/src/agent/{runs-index,goal-loop,run-broker}.ts`; `web/src/components/{chat-tab,chat-rail}.tsx`; `web/src/components/console/kady-console.tsx`; `web/src/lib/{use-agent,console,console-types}.ts`; planned `server/src/agent/chat-turn-runs-adapter*.ts` and `web/src/components/chat-live-graph*.tsx` |
| S9 | Design tokens and Studio popup | `web/src/app/globals.css`; `web/src/components/theme-provider.tsx`; planned `web/src/components/scientific-dag-studio*.tsx` and `web/src/lib/studio-design-tokens*.ts` |
| S10 | Workflow library | `web/src/components/workflows-panel.tsx`; `web/src/data/workflows.json`; `web/src/data/dag-workflow-templates/**`; `web/src/lib/dag-workflow-templates.ts`; `server/test/dag-workflow-templates.test.ts`; planned `web/src/components/workflow-library*.tsx` and `web/src/lib/workflow-library*.ts` |
| S11 | Stably cloud outer loop | `e2e/**`, `playwright.config.*`, `.stably/**`, `.github/workflows/stably-cloud.yml`, `docs/e2e/**`, `scripts/preview-*.mjs`, and `deploy/preview/**` |

Tests follow the lane owning their production basename. Repository rail scripts,
guard tests, and `docs/lanes/R1.log` belong to R1 and are outside S1-S11 product
ownership, except for the explicitly listed C1 vendored-dist gate files above.

## Reviewed handoffs (2026-08-16 policy commit)

A handoff lets the recipient lane edit a path another lane owns, for the stated scope only. `node scripts/ownership-check.mjs --writer <lane> --base <policy-commit>` (lane C1's trusted-base checker) authorizes a lane's changed paths against this base.

| From | To | Path | Scope |
|---|---|---|---|
| R1 | C1 | `docs/OWNERSHIP.md` | C1 ownership row and branch-prefix authorization documentation |
| R1 | C1 | `docs/inventory/ownership.json` | C1 lane and reviewed handoff policy |
| R1 | C1 | `scripts/ownership-check.mjs` | trusted-base changed-path authorization and rename endpoint enforcement |
| S11 | C1 | `scripts/preview-environment.mjs` | vendored-dist environment and preview launcher isolation |
| S11 | C1 | `scripts/preview-environment.test.mjs` | vendored-dist environment and lock regression coverage |
| S11 | C1 | `scripts/preview-up.mjs` | prepareVendoredDist and prebuild-isolation ordering |
| S11 | C1 | `scripts/preview-launcher-observer.mjs` | workflow-engine readiness and fatal-exit observer anchors; workflow-supervisor role recording (pid + identity reported by the backend) |
| S11 | C1 | `scripts/preview-launcher-observer.test.mjs` | workflow-engine readiness and fatal-exit observer regression coverage; workflow-supervisor role recording |
| S7 | C1 | `server/src/index.ts` | kady-supervisor IPC message (supervisor pid reported to the launcher parent) — no other change |
| S5 | C1 | `server/src/workflows/supervisor/client.ts` | onOwnership callback invoked immediately when a supervisor process is acquired (spawned or inherited) — no other change |
| S5 | C4 | `server/src/workflows/store.ts` | definition CAS outcome core (create/update/upsert intent evaluated inside the mutation lock before hash equality) |
| S4 | C4 | `server/src/api/dag-workflows.ts` | PUT /dag-workflows CAS status/ETag matrix (201 only for created; 409 on stale-identical and absent+If-Match:"0") |
| S1 | C4 | `web/src/lib/dag-workflows.ts` | client sends the chosen precondition header and consumes the outcome shape |
| S1b | C4 | `web/src/components/dag-workflows-panel.tsx` | panel consumes the CAS outcome shape |
| S1b | C4 | `web/src/components/dag-workflows-panel.test.tsx` | panel CAS outcome regression |
| S10 | C4 | `server/test/dag-workflow-templates.test.ts` | template setup through the compatibility facade |
| S11 | C4 | `e2e/fixtures.ts` | browser mock sends the chosen header and returns the new CAS shape |
| S1 | V1 | `web/src/components/persistent-workspace-surfaces.tsx` | min-width containment of the visible workspace surface wrapper so panes cannot widen past the viewport |
| S1b | V1 | `web/src/components/dag-workflows-panel.tsx` | details panel width containment (min-w-0/max-w-full, scrollable definition) and keyboard focus management on Details & run / Close details |
| S1b | V1 | `web/src/components/dag-workflows-panel.test.tsx` | width-containment and focus-management regressions |
| S10 | V1 | `web/src/components/workflows-panel.tsx` | category chip strip and panel width containment |
| S2 | V1 | `web/src/lib/embed-config.ts` | RAINDROP_URL has no localhost default: undefined when NEXT_PUBLIC_RAINDROP_URL is unset |
| S1 | V1 | `web/src/components/raindrop-workshop-panel.tsx` | Workshop tab renders a not-configured state instead of an iframe when RAINDROP_URL is unset |
| S1 | V1 | `web/src/components/raindrop-surface.tsx` | Workshop sub-tab gating when RAINDROP_URL is unset |
| S8 | V1 | `web/src/components/chat-tab.tsx` | accessible reason (title/aria-describedby + visible hint) on the disabled Submit control when no provider is connected |
| S11 | V1 | `e2e/scientific-pipelines.spec.ts` | regression: opening details keeps Details & run / Close details / alert inside the viewport at 1440x900 and 1280x720 |
| S11 | V1 | `e2e/workspace.spec.ts` | regression: workspace surfaces do not exceed the viewport width; picker focus ring visible |
| S1 | V1 | `web/src/app/page.tsx` | move keyboard focus into the workspace (first primary navigation control) when a project is opened from the picker so focus is not dropped to <body> |
| S1 | V1 | `web/src/components/workspace-navigation.tsx` | expose an imperative/first-control focus target for the workspace entry hand-off |
| S1 | V1 | `web/src/components/helper-agent-chat.tsx` | accessible reason (aria-disabled + aria-describedby visible hint, single tooltip) on the blocked analyst composer/Send instead of a bare native disabled state (F5 pattern) |
| S1 | W1 | `web/src/app/page.tsx` | remove the Components Studio header entry and host the DAG-builder assistant in the Builder rail (no other shell changes) |
| S9 | W1 | `web/src/components/scientific-dag-studio.tsx` | retire the user-facing Components Studio entry (component stays importable for tests/docs; no visual effects in the workspace) |
| S9 | W1 | `web/src/components/scientific-dag-studio.test.tsx` | regressions for the retired entry |
| S1 | W1 | `web/src/components/dag-builder-surface.tsx` | Builder rail: dedicated DAG-builder assistant (separate helper session, not the main Kady chat), slim Raindrop-style chrome |
| S1 | W1 | `web/src/components/helper-agent-chat.tsx` | dag-builder profile copy/behaviour for building visual/YAML DAG workflows; Raindrop analyst copy stays a log analyst |
| S1 | W1 | `web/src/components/raindrop-panel.tsx` | analyst copy: log analyst, not DAG authoring |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/DagNodeComponent.tsx` | node details expand/collapse by explicit control only (no hover expansion); readable node cards at fit zoom |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/DagNodeComponent.test.ts` | expand/collapse regressions |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/NodeInspector.tsx` | remove the legacy-brand MCP config placeholder path and every legacy-brand label |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/NodeInspector.test.ts` | placeholder regressions |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/NodePalette.tsx` | quick nodes choose the CLI harness before drag |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/QuickAddPicker.tsx` | quick-add: harness pre-selection; no legacy-brand placeholders |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.tsx` | balanced fitView/zoom on load and after add; remove background glow/effects; working zoom controls |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.test.ts` | viewport regressions |
| S3 | W2 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/NodeLibrary.tsx` | node library: harness pre-selection for quick nodes; slim chrome |
| S1 | W4 | `web/src/components/console/console-panel.tsx` | mount the live-graph console (rail + main graph + event drawer) as the DAG Runs surface; keep the Agents & Loops sub-tab |
| S8 | W4 | `web/src/components/console/kady-console.tsx` | route live-graph selections and deep links (?run=, ?session=) |
| S1 | W4 | `web/src/components/dag-workflow-console.tsx` | reuse of the run list/event semantics inside the drawer; Workflow Rescue entry point from the run graph |
| S8 | W4 | `web/src/components/chat-live-graph.tsx` | export reuse for session projections; additive exports only (RunStateV1 event union taxonomy) |
| S8 | W4 | `server/src/api/sessions.ts` | additive: list active sessions across projects for the console (scope=all&active=1) if missing; no behaviour change to existing routes |
| S11 | W4 | `e2e/item-count-reporter.ts` | inventory pins for the new console-live.spec.ts items |
| S11 | W3 | `e2e/builder-typed.spec.ts` | new Playwright items for the typed builder path (load/import/stitch/harness) |
| S11 | W4 | `e2e/console-live.spec.ts` | new Playwright items for the live-graph console |
| S1 | W4 | `web/src/app/page.tsx` | thread the Console view-visibility predicate (isActive && view === 'console') into ConsolePanel so the live console polls only while visible — one prop, no other change |
| S11 | W2 | `e2e/builder.spec.ts` | rewrite the seven node-card assertions to the explicit expand/collapse contract and the 'CLI harness: …' badge title; no items added or removed |
| S11 | W1 | `e2e/item-count-reporter.ts` | inventory pins after retiring studio.spec.ts and enabling nothing else |
| S9 | W1 | `web/src/components/scientific-dag-studio-launcher.tsx` | retire the launcher (unmounted from the workspace header) |
| S11 | W1 | `docs/e2e/README.md` | inventory table after retiring studio.spec.ts |
| S11 | W1 | `e2e/console-raindrop.spec.ts` | drop the retired Components Studio overlap assertion (the pill no longer exists) |
| S8 | S8B | `server/src/api/sessions.ts` | context-free dag-builder helper sessions: parseHelperSource/getOrCreateProfileSession must accept a dag-builder session with no workflow pointer so a user can start from nothing |
| S7 | S8B | `server/src/agent/session-registry.ts` | dag-builder profile prompt must stop instructing the model to return changes 'for the visual Builder to validate and apply' until lane W3's bridge lands |
| S7 | C5 | `server/src/index.ts` | `registerRoutes` onRequest hook: a project-repository containment refusal must re-throw, not silently redirect the request — writes included — into the default project (N-30 follow-up) |
| C4 | S8B | `server/test/raindrop-context.test.ts` | regressions for the no-workflow dag-builder context |
| S11 | W1 | `e2e/studio.spec.ts` | retire the Components Studio spec together with the header entry (owner: 'there should be no components studio'); DELETED in W1 r2 |
| S8 | W1 | `web/src/components/chat-rail.tsx` | delete: unreferenced after the Builder rail hosts the DAG-builder assistant; DELETED in W1 r2 |
| S1 | W3 | `web/src/components/dag-builder-surface.tsx` | host-authoritative typed document, builder bridge, source picker above the iframe, helper context/patch hooks (W1 owns the rail placement) |
| S2 | W3 | `web/src/components/engine-iframe-panel.tsx` | iframe host: bridge origin/targetOrigin, ready timeout banner, ?host=kady |
| S5 | W3 | `server/src/workflows/schema.ts` | additive optional fields only: top-level ui {positions,viewport}, per-node meta.compositeOf, document/node provenance — excluded from validation semantics and graphSha256 |
| S5 | W3 | `server/src/workflows/validate.ts` | reuse for POST /dag-workflows/validate; no semantic change |
| S4 | W3 | `server/src/api/dag-workflows.ts` | mount validate/import routes; run-document snapshot + graphSha256 + workflowId on GET /dag-workflow-runs/:id |
| S4 | W3 | `server/src/workflows/kady-node-executor.ts` | harness switch: dispatch on nodeSpec.harness with per-harness adapters, harness_unavailable, no silent Pi fallback |
| S4 | W3 | `server/src/agent/workflow-delegation-session.ts` | dispatchWorkflowHarness adapters (bounded) |
| S1 | W3 | `web/src/lib/dag-workflows.ts` | client for validate/import + CAS save helpers |
| S1b | W3 | `web/src/components/dag-workflows-panel.tsx` | open-in-builder action → typed load |
| S10 | W3 | `web/src/lib/workflow-library-template-builder.ts` | export reuse of createScientificWorkflowTemplateNodes for library → typed one/few-node DAG import |
| S10 | W3 | `web/src/lib/dag-workflow-templates.ts` | export reuse of createDagWorkflowTemplateGraph / findDagWorkflowTemplate |
| S10 | W3 | `web/src/components/workflows-panel.tsx` | 'Open in builder' action on library cards → import |
| W2 | W3 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/BuilderToolbar.tsx` | host mode: route Validate/Save/Run through the bridge and render the host-fed source list (call-site edit only) |
| S3 | W3 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/QuickAddPicker.tsx` | mount HarnessPicker; stamp spec.harness on the dragged node (call-site edit only) |
| S3 | W3 | `server/vendor/pipeline-engine/packages/web/src/lib/api.ts` | host-mode: skip engine list when host-fed |
| S3 | W3 | `server/vendor/pipeline-engine/packages/web/src/hooks/useBuilderValidation.ts` | host mode: harness is not an inline error when the document is typed (typed route validates) |
| W2 | W3 | `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowBuilder.tsx` | host mode wiring after W2 lands |
| S11 | W3 | `e2e/item-count-reporter.ts` | inventory pins for the new builder-typed.spec.ts items |
| V1 | W1 | `web/src/components/helper-agent-chat.test.tsx` | dag-builder profile regressions |
| S2 | C1 | `start.mjs` | vendored-dist build, engine-port ownership, readiness, and disabled-state sections; forced-shutdown ownership of the backend's detached workflow supervisor (second explicit signal) and process-group retirement |
| S2 | C1 | `server/src/agent/pipeline-engine/client.ts` | launcher-disabled fail-before-fetch guard |
| S5 | C1 | `server/src/config.ts` | explicit pipeline-engine disabled configuration sentinel |
| S4 | C1 | `server/src/api/pipelines.ts` | disabled admission lookup and reconciliation no-fetch guard only |
| R1 | C3 | `docs/OWNERSHIP.md` | C3 ownership row |
| R1 | C3 | `docs/inventory/ownership.json` | C3 lane and reviewed handoff policy |
| C1 | C3 | `.github/workflows/tests.yml` | hosted evidence CI integration |
| C1 | C3 | `package.json` | hosted evidence scripts |
| S11 | C3 | `docs/e2e/README.md` | hosted and live E2E instructions |
| S11 | C3 | `e2e/config-contracts.node.mjs` | hosted and live E2E configuration contract |
| S11 | C3 | `e2e/global-setup.cloud.ts` | cloud E2E setup |
| S11 | C3 | `e2e/global-setup.ts` | local E2E setup |
| S11 | C3 | `e2e/item-count-reporter.ts` | E2E evidence counts |
| S11 | C3 | `e2e/live-backend.spec.ts` | live backend E2E proof |
| S11 | C3 | `e2e/live-fixtures.ts` | live E2E fixtures |
| S11 | C3 | `e2e/service-origins.ts` | E2E service origin resolution |
| S11 | C3 | `e2e/template-source.ts` | E2E template provenance |
| S11 | C3 | `playwright.config.ts` | E2E configuration split |
| R1 | C5 | `docs/OWNERSHIP.md` | C5 ownership row |
| R1 | C5 | `docs/inventory/ownership.json` | C5 lane and reviewed handoff policy |
| R1 | C5 | `.gitignore` | checkout-local preview web projection ignore rule |
| C1 | C5 | `docs/preview-env.md` | server environment-root isolation documentation |
| S11 | C5 | `scripts/preview-environment.mjs` | server environment-root preview wiring |
| S11 | C5 | `scripts/preview-environment.test.mjs` | server environment-root preview regression tests |
| S11 | C5 | `scripts/preview-up.mjs` | server environment-root preview wiring |
| S11 | C5 | `scripts/preview-down.mjs` | owned checkout-local preview web projection cleanup |
| S11 | C5 | `scripts/preview-state.mjs` | exclusive preview lifecycle lock |
| S11 | C5 | `scripts/preview-state.test.mjs` | preview lifecycle lock recovery regression |
| C1 | C5 | `scripts/preview-launcher-observer.mjs` | generation-bound service records, launcher start gate and process identity in the preview observer |
| C1 | C5 | `scripts/preview-launcher-observer.test.mjs` | observer generation/identity regression |
| S11 | C5 | `scripts/preview-processes.mjs` | identity-verified preview process ownership (no cwd-only signaling) |
| S11 | C5 | `scripts/preview-processes.test.mjs` | preview process ownership regression |
| S11 | C5 | `scripts/preview-readiness.mjs` | named preview source-drift health failure detail |
| S11 | C5 | `scripts/preview-readiness.test.mjs` | named preview source-drift health regression |
| S4 | C5 | `server/src/workflows/supervisor/credentials.ts` | credential persistence environment-root isolation |
| S11 | C3 | `.github/workflows/stably-cloud.yml` | hosted evidence manifest step and artifact upload |
| C1 | C5 | `scripts/vendored-dist-build.mjs` | single guarded call of the preview env-candidate refusal helper immediately before the Bun spawn |
