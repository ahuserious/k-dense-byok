# Scientific DAG Studio ownership

Phase R uses one writer per path. The globs below are authoritative for the
inventoried surfaces in `docs/inventory/`; planned globs reserve files that do
not exist yet. `node scripts/ownership-check.mjs` verifies that every current
inventory path is owned exactly once.

| Lane | Scope | Owned globs |
| --- | --- | --- |
| S1 | Consolidation and typed-surface removal | `web/src/app/page.tsx`; `web/src/components/{workspace-navigation,persistent-workspace-surfaces,dag-builder-surface,dag-builder,dag-builder-canvas,dag-builder-inspector,dag-workflows-panel,dag-workflow-console}.{ts,tsx}`; `web/src/lib/{workspace-persistence,dag-workflow-builder,dag-workflows}.ts` |
| S2 | Vendor integration and naming sweep | `start.mjs`; `server/src/agent/pipeline-engine/**`; `server/src/agent/skills.ts`; `web/src/components/{pipelines-panel,pipeline-builder-panel,engine-iframe-panel}.tsx`; `web/src/lib/{engine-config,embed-config,pipelines}.ts`; vendor attribution files (`LICENSE`, `NOTICE*`, `VENDORED-FROM.md`) |
| S3 | Node-card UX | `server/vendor/pipeline-engine/packages/web/src/components/workflows/{DagNodeComponent,DagNodeProgress,NodeInspector,NodePalette,NodeLibrary,QuickAddPicker,CommandPicker,StatusIcon}.{ts,tsx}` and their same-basename tests |
| S4 | Runner policy, bindings, billing, and ledger | `server/src/api/{dag-workflows,pipelines}.ts`; `server/src/agent/{workflow-model-resolution,workflow-delegation-session}.ts`; `server/src/cost/{billing,ledger}.ts`; `server/src/workflows/{budget,kady-node-executor,supervised-budget}.ts`; `server/src/workflows/supervisor/{credential-contract,credentials}.ts`; `web/src/components/database-selector.tsx` |
| S5 | Engine behavior and deliberation store | Typed runtime files in `server/src/workflows/` not reserved by S4, S6, or S7; `server/src/config.ts`; `server/src/agent/subagents.ts`; planned `server/src/{personality-store/**,agent/personality-store*.ts,api/personality-store*.ts}`; `server/vendor/pipeline-engine/packages/workflows/src/dag-executor*.ts`; specifically the schema, state, registry, store, validation, execution, controller, service, evidence, Fusion, Lean4, import, and supervisor runtime/protocol files enumerated in `docs/inventory/ownership.json` |
| S6 | Prompt-optimization node | `server/src/workflows/prompt-opt*.ts`; `web/src/components/prompt-opt*.tsx`; `web/src/lib/prompt-opt*.ts` (reserved; no implementation exists at this inventory point) |
| S7 | Context/compaction watcher | `server/src/agent/dag-fusion-bridge.ts`; `web/src/components/context-usage-indicator.{ts,tsx}`; planned `server/src/workflows/{context,compaction}-watcher*.ts`, `server/src/context/lateral-pass*`, and `web/src/components/{context,compaction}-watcher*.tsx` |
| S8 | Chat live graph and chat-turn adapter | `server/src/api/sessions.ts`; `server/src/agent/{runs-index,goal-loop,run-broker}.ts`; `web/src/components/{chat-tab,chat-rail}.tsx`; `web/src/components/console/kady-console.tsx`; `web/src/lib/{use-agent,console,console-types}.ts`; planned `server/src/agent/chat-turn-runs-adapter*.ts` and `web/src/components/chat-live-graph*.tsx` |
| S9 | Design tokens and Studio popup | `web/src/app/globals.css`; `web/src/components/theme-provider.tsx`; planned `web/src/components/scientific-dag-studio*.tsx` and `web/src/lib/studio-design-tokens*.ts` |
| S10 | Workflow library | `web/src/components/workflows-panel.tsx`; `web/src/data/workflows.json`; `web/src/lib/dag-workflow-templates.ts`; planned `web/src/components/workflow-library*.tsx` and `web/src/lib/workflow-library*.ts` |
| S11 | Stably cloud outer loop | Reserved `e2e/**`, `playwright.config.*`, `.stably/**`, and `docs/e2e/**` |

Tests follow the lane owning their production basename. Repository rail scripts,
guard tests, and `docs/lanes/R1.log` belong to R1 and are outside S1-S11 product
ownership.
