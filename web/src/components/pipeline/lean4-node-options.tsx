"use client";

import {
  addDefaultNode,
  exactFixedModel,
  exactKadyCurrentModel,
} from "@/lib/dag-workflow-builder";
import type {
  Lean4WorkflowNode,
  WorkflowGraphDocument,
  WorkflowModelRequest,
} from "@/lib/dag-workflows";
import { workflowHandoverConditions } from "@/lib/stitch-workflows";

interface ModelOption {
  id: string;
  label: string;
  provider: string;
}

function requestRef(request: WorkflowModelRequest | undefined): string {
  if (!request || request.requested.source !== "fixed") return "";
  return `${request.requested.provider}/${request.requested.model}`;
}

function requestFromRef(ref: string): WorkflowModelRequest {
  if (!ref) return exactKadyCurrentModel();
  const [provider, ...modelParts] = ref.split("/");
  const model = modelParts.join("/");
  const authKind =
    provider === "ollama" || provider === "openai-compatible"
      ? "local"
      : provider === "openrouter" || provider === "nvidia"
        ? "api-key"
        : "oauth";
  return exactFixedModel(provider!, model, authKind);
}

function appendLeanNode(document: WorkflowGraphDocument): {
  document: WorkflowGraphDocument;
  nodeId: string;
} {
  const added = addDefaultNode(document, "lean4");
  const terminals = document.nodes.filter((node) => node.terminal);
  const nodes = added.graph.nodes.map((node) =>
    terminals.some((terminal) => terminal.id === node.id)
      ? { ...node, terminal: false }
      : node,
  );
  const edgeIds = new Set(added.graph.edges.map((edge) => edge.id));
  const edges = [...added.graph.edges];
  for (const terminal of terminals) {
    for (const condition of workflowHandoverConditions(document, terminal)) {
      const stem = `lean4-${terminal.id}-${condition}`;
      let id = stem;
      let suffix = 2;
      while (edgeIds.has(id)) {
        id = `${stem}-${String(suffix)}`;
        suffix += 1;
      }
      edgeIds.add(id);
      edges.push({ id, from: terminal.id, to: added.nodeId, condition });
    }
  }
  return { document: { ...added.graph, nodes, edges }, nodeId: added.nodeId };
}

export function Lean4NodeOptions({
  document,
  models,
  onChange,
}: {
  document: WorkflowGraphDocument | null;
  models: ModelOption[];
  onChange: (document: WorkflowGraphDocument, status: string) => void;
}) {
  const leanNodes = document?.nodes.filter(
    (node): node is Lean4WorkflowNode => node.kind === "lean4",
  ) ?? [];
  const solverFallback = document?.defaultModel ?? exactKadyCurrentModel();

  const replace = (replacement: Lean4WorkflowNode, status: string) => {
    if (!document) return;
    onChange({
      ...document,
      nodes: document.nodes.map((node) => (
        node.id === replacement.id ? replacement : node
      )),
    }, status);
  };

  return (
    <section aria-labelledby="lean4-node-options-title" className="rounded-md border px-2.5 py-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="lean4-node-options-title"
            className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            Lean 4
          </h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Adds the existing typed Lean node as the next phase; no second proof runtime.
          </p>
        </div>
        <button
          type="button"
          disabled={!document}
          onClick={() => {
            if (!document) return;
            const added = appendLeanNode(document);
            onChange(
              added.document,
              `Added Lean 4 node ${added.nodeId} after the current terminal phase. Save to keep it.`,
            );
          }}
          className="rounded-md border px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
        >
          Add Lean 4 node
        </button>
      </div>
      {!document && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Load a workflow before adding a Lean 4 node.
        </p>
      )}
      {document && leanNodes.length === 0 && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          This workflow has no Lean 4 node yet.
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {leanNodes.map((node) => (
          <fieldset key={node.id} className="rounded-md border px-2 py-1.5">
            <legend className="px-1 font-mono text-[10px] font-medium">{node.name}</legend>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="text-[10px] text-muted-foreground">
                Mode
                <select
                  value={node.mode}
                  onChange={(event) => {
                    const mode = event.target.value as Lean4WorkflowNode["mode"];
                    if (mode === "verify") {
                      const { solverModel: _solverModel, ...withoutSolver } = node;
                      replace(
                        { ...withoutSolver, mode: "verify" },
                        `${node.name} now verifies reviewed Lean source without a model slot.`,
                      );
                    } else {
                      replace(
                        {
                          ...node,
                          mode: "solve",
                          solverModel: node.solverModel ?? solverFallback,
                        },
                        `${node.name} now uses one solver model call before verification.`,
                      );
                    }
                  }}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                >
                  <option value="verify">Verify reviewed source</option>
                  <option value="solve">Solve proposition</option>
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-1 text-[10px]">
                <input
                  type="checkbox"
                  checked={node.mathlib}
                  onChange={(event) =>
                    replace(
                      { ...node, mathlib: event.target.checked },
                      `${node.name} Mathlib ${event.target.checked ? "enabled" : "disabled"}.`,
                    )
                  }
                  className="size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                />
                Require pinned Mathlib
              </label>
            </div>
            <label className="mt-2 block text-[10px] text-muted-foreground">
              {node.mode === "verify" ? "Complete reviewed Lean source" : "Exact proposition"}
              <textarea
                value={node.theorem}
                onChange={(event) =>
                  replace(
                    { ...node, theorem: event.target.value },
                    `${node.name} theorem changed. Save to keep it.`,
                  )
                }
                rows={4}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 font-mono text-[10px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              />
            </label>
            <label className="mt-2 block text-[10px] text-muted-foreground">
              Informal goal
              <textarea
                value={node.goal}
                onChange={(event) =>
                  replace(
                    { ...node, goal: event.target.value },
                    `${node.name} goal changed. Save to keep it.`,
                  )
                }
                rows={2}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-[10px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              />
            </label>
            <label className="mt-2 block text-[10px] text-muted-foreground">
              Solver model
              <select
                value={requestRef(node.solverModel)}
                disabled={node.mode === "verify"}
                aria-describedby={node.mode === "verify" ? `lean4-solver-reason-${node.id}` : undefined}
                onChange={(event) =>
                  replace(
                    {
                      ...node,
                      solverModel: event.target.value
                        ? requestFromRef(event.target.value)
                        : solverFallback,
                    },
                    `${node.name} solver model changed. Save to keep it.`,
                  )
                }
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
              >
                <option value="">Workflow default</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.provider} · {model.label}
                  </option>
                ))}
              </select>
            </label>
            {node.mode === "verify" && (
              <p
                id={`lean4-solver-reason-${node.id}`}
                className="mt-1 text-[10px] text-muted-foreground"
              >
                Lean verify mode is deterministic and has no model slot.
              </p>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground">
              Fixed skill: {node.skill}. Verified proofs use F4’s single proof-artifact renderer once
              that renderer lands in integration.
            </p>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
