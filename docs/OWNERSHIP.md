# Scientific DAG Studio ownership

Phase R uses one writer per path. The globs below are authoritative for the
inventoried surfaces in `docs/inventory/`; planned globs reserve files that do
not exist yet. `node scripts/ownership-check.mjs` verifies that every current
inventory path is owned exactly once.

| Lane | Scope | Owned globs |
| --- | --- | --- |
| C1 | Vendored builder dist freshness and launcher safety | `.github/workflows/tests.yml`; `docs/preview-env.md`; `package.json`; `.github/workflows/ownership-authorization.yml`; `scripts/{ownership-check,ownership-check.test,vendored-dist-*}.mjs`; `server/test/pipelines-disabled.test.ts`; `server/test/pipelines.test.ts` (unowned on the base; C1 owns it for the disabled crash-window recovery tests); reviewed handoffs from R1, S2, S4, S5, and S11 listed in the policy. |
| C3 | Hosted and live E2E evidence | `playwright.{cloud,live-alt}.config.ts`; `scripts/hosted-evidence-*.mjs`; reviewed handoffs from C1, R1, and S11 listed in the policy. |
| C5 | Preview credential and environment-root isolation | `config/token-ban.json`; `server/src/{env,environment-files,legacy-engine-data,path-containment,projects,sandbox-fs}.ts`; `server/src/api/credentials.ts`; `server/test/{credential-env-isolation,env-isolation}.test.ts`; reviewed handoffs from C1, R1, S4, and S11 listed in the policy. |
| R1 | Orchestrator-held shared root files (policy files are handled separately as policy-controlled paths) | `.gitignore`; handed off to lanes for scoped edits (see handoffs). |
| S1 | Consolidation and typed-surface removal | `web/src/app/page.tsx`; `web/src/components/{workspace-navigation,persistent-workspace-surfaces,dag-builder-surface,dag-builder,dag-builder-canvas,dag-builder-inspector,dag-workflow-console}.{ts,tsx}`; `web/src/lib/{workspace-persistence,dag-workflow-builder,dag-workflows}.ts` |
| S1b | Scientific Pipelines cross-engine registry | `web/src/components/dag-workflows-panel.tsx`; `web/src/components/dag-workflows-panel.test.tsx`; `web/src/lib/scientific-pipeline-registry.ts`; `web/src/lib/scientific-pipeline-registry.test.ts`; `server/test/pipeline-engine-client.test.ts`; `docs/lanes/S1b-INTEGRATION.md` |
| S2 | Vendor integration and naming sweep | `start.mjs`; `server/src/agent/pipeline-engine/**`; `server/src/agent/skills.ts`; `web/src/components/{pipelines-panel,pipeline-builder-panel,engine-iframe-panel}.tsx`; `web/src/lib/{engine-config,embed-config,pipelines}.ts`; vendor attribution files (`LICENSE`, `NOTICE*`, `VENDORED-FROM.md`) |
| S3 | Node-card UX and DAG node persistence | `server/vendor/pipeline-engine/packages/web/src/components/workflows/{DagNodeComponent,DagNodeProgress,NodeInspector,NodePalette,NodeLibrary,QuickAddPicker,CommandPicker,StatusIcon}.{ts,tsx}` and their same-basename tests; `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.tsx`; `server/vendor/pipeline-engine/packages/web/src/components/workflows/WorkflowCanvas.test.ts`; `server/vendor/pipeline-engine/packages/web/src/components/workflows/YamlCodeView.tsx`; `server/vendor/pipeline-engine/packages/web/src/components/canvasui/Liquid.tsx`; `server/vendor/pipeline-engine/packages/web/src/hooks/useBuilderValidation.ts`; `server/vendor/pipeline-engine/packages/web/src/lib/{api.ts,api.generated.d.ts,dag-layout.ts}`; `server/vendor/pipeline-engine/packages/workflows/src/schemas/{dag-node,index}.ts`; `server/vendor/pipeline-engine/packages/workflows/src/{loader,node-spec-enforcement,node-spec-execution.test}.ts`; `server/vendor/pipeline-engine/packages/server/src/routes/api.nodespec-settings.integration.test.ts` |
| S4 | Runner policy, bindings, billing, and ledger | `server/src/api/{dag-workflows,pipelines}.ts`; `server/src/agent/{workflow-model-resolution,workflow-delegation-session}.ts`; `server/src/cost/{billing,ledger}.ts`; `server/src/workflows/{budget,kady-node-executor,supervised-budget}.ts`; `server/src/workflows/supervisor/{credential-contract,credentials}.ts`; `web/src/components/database-selector.tsx` |
| S5 | Engine behavior and deliberation store | Typed runtime files in `server/src/workflows/` not reserved by S4, S6, or S7; `server/src/config.ts`; `server/src/agent/subagents.ts`; planned `server/src/{personality-store/**,agent/personality-store*.ts,api/personality-store*.ts}`; `server/vendor/pipeline-engine/packages/workflows/src/dag-executor.ts`; `server/vendor/pipeline-engine/packages/workflows/src/dag-executor.test.ts`; specifically the schema, state, registry, store, validation, execution, controller, service, evidence, Fusion, Lean4, import, and supervisor runtime/protocol files enumerated in `docs/inventory/ownership.json` |
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
| S11 | C1 | `scripts/preview-launcher-observer.mjs` | workflow-engine readiness and fatal-exit observer anchors |
| S11 | C1 | `scripts/preview-launcher-observer.test.mjs` | workflow-engine readiness and fatal-exit observer regression coverage |
| S7 | C1 | `server/src/index.ts` | kady-supervisor IPC message (supervisor pid reported to the launcher parent) — no other change |
| S2 | C1 | `start.mjs` | vendored-dist build, engine-port ownership, readiness, and disabled-state sections |
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
| S11 | C5 | `scripts/preview-readiness.mjs` | named preview source-drift health failure detail |
| S11 | C5 | `scripts/preview-readiness.test.mjs` | named preview source-drift health regression |
| S4 | C5 | `server/src/workflows/supervisor/credentials.ts` | credential persistence environment-root isolation |
| S11 | C3 | `.github/workflows/stably-cloud.yml` | hosted evidence manifest step and artifact upload |
| C1 | C5 | `scripts/vendored-dist-build.mjs` | single guarded call of the preview env-candidate refusal helper immediately before the Bun spawn |
