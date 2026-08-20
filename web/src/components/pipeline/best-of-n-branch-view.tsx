"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  SEQUENTIAL_CANDIDATES_NOTICE,
  projectBestOfNRuns,
  type BestOfNBranchState,
  type BestOfNProjection,
} from "@/lib/best-of-n-branches";
import {
  pageDagWorkflowRunEvents,
  readDagWorkflowRun,
  type WorkflowRunEvent,
} from "@/lib/dag-workflows";

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const BRANCH_STATE_LABEL: Record<BestOfNBranchState, string> = {
  "not-started": "not started",
  "in-flight": "running",
  resolved: "resolved",
};

const BRANCH_STATE_BORDER: Record<BestOfNBranchState, string> = {
  "not-started": "border-border",
  "in-flight": "border-foreground",
  resolved: "border-primary",
};

interface SequenceNodeData extends Record<string, unknown> {
  kind: "start" | "candidate" | "evaluator";
  title: string;
  subtitle: string;
  state: BestOfNBranchState;
  candidateIndex?: number;
  winner?: boolean;
  score?: number;
}

type SequenceNode = Node<SequenceNodeData, "sequenceStep">;

function SequenceStepNode({ data }: NodeProps<SequenceNode>) {
  return (
    <div
      data-testid={
        data.kind === "candidate"
          ? `best-of-n-branch-${String(data.candidateIndex)}`
          : undefined
      }
      data-branch-state={data.kind === "candidate" ? data.state : undefined}
      className={`min-w-36 rounded-md border-2 bg-background px-2.5 py-2 text-foreground shadow-sm ${BRANCH_STATE_BORDER[data.state]}`}
    >
      {data.kind !== "start" && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="border-background bg-foreground"
        />
      )}
      <p className="font-mono text-[11px] font-medium">{data.title}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{data.subtitle}</p>
      {typeof data.score === "number" && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">score {data.score}</p>
      )}
      {data.winner && (
        <p className="mt-1 rounded border px-1 text-[10px] font-medium">★ winner</p>
      )}
      {data.kind !== "evaluator" && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="border-background bg-foreground"
        />
      )}
    </div>
  );
}

const NODE_TYPES: NodeTypes = { sequenceStep: SequenceStepNode };

function sequenceGraph(projection: BestOfNProjection): {
  nodes: SequenceNode[];
  edges: Edge[];
} {
  const spacing = 190;
  const nodes: SequenceNode[] = [
    {
      id: `${projection.nodeId}-start`,
      type: "sequenceStep",
      position: { x: 0, y: 20 },
      draggable: false,
      selectable: true,
      ariaLabel: `${projection.nodeName} starts a sequential best-of-n evaluation`,
      data: {
        kind: "start",
        title: projection.nodeName,
        subtitle: "sequential start",
        state: "resolved",
      },
    },
    ...projection.branches.map((branch, index): SequenceNode => ({
      id: `${projection.nodeId}-${branch.slotId}`,
      type: "sequenceStep",
      position: { x: spacing * (index + 1), y: 20 },
      draggable: false,
      selectable: true,
      ariaLabel: `Candidate ${String(branch.index)}, ${BRANCH_STATE_LABEL[branch.state]}${branch.winner ? ", winner" : ""}`,
      data: {
        kind: "candidate",
        title: `Candidate ${String(branch.index)}`,
        subtitle: `${branch.slotId} · ${BRANCH_STATE_LABEL[branch.state]}`,
        state: branch.state,
        candidateIndex: branch.index,
        winner: branch.winner,
        score: branch.score,
      },
    })),
    {
      id: `${projection.nodeId}-evaluator`,
      type: "sequenceStep",
      position: { x: spacing * (projection.branches.length + 1), y: 20 },
      draggable: false,
      selectable: true,
      ariaLabel: `Evaluator, ${BRANCH_STATE_LABEL[projection.evaluator.state]}`,
      data: {
        kind: "evaluator",
        title: "Evaluator",
        subtitle: `${projection.evaluator.slotId} · ${BRANCH_STATE_LABEL[projection.evaluator.state]}`,
        state: projection.evaluator.state,
      },
    },
  ];

  const edges = nodes.slice(1).map((node, index): Edge => {
    const source = nodes[index]!;
    return {
      id: `${source.id}-then-${node.id}`,
      source: source.id,
      target: node.id,
      label: "then",
      type: "smoothstep",
      focusable: true,
      selectable: false,
      ariaLabel: `${source.data.title} finishes before ${node.data.title} starts`,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2 },
      labelStyle: { fontSize: 10 },
    };
  });
  return { nodes, edges };
}

function isTerminalStatus(value: unknown): boolean {
  return typeof value === "string" && TERMINAL_RUN_STATUSES.has(value);
}

export function BestOfNBranchView({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const [projections, setProjections] = useState<BestOfNProjection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const stopped = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const record = await readDagWorkflowRun(projectId, runId);
      let events: WorkflowRunEvent[] = [];
      try {
        const page = await pageDagWorkflowRunEvents(projectId, runId, { limit: 500 });
        events = page.events;
      } catch {
        events = [];
      }
      const next = projectBestOfNRuns(record, events);
      setProjections(next);
      setError(null);
      return next.length > 0 && !isTerminalStatus(record.state?.status);
    } catch {
      setError("Could not read candidate state from this run.");
      return false;
    } finally {
      setLoaded(true);
    }
  }, [projectId, runId]);

  useEffect(() => {
    stopped.current = false;
    setLoaded(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const continuePolling = await refresh();
      if (continuePolling && !stopped.current) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();

    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  if (!loaded) {
    return (
      <p className="px-4 py-2 text-[11px] text-muted-foreground">Reading candidate state…</p>
    );
  }

  if (error !== null) {
    return (
      <p role="alert" className="px-4 py-2 text-[11px] text-destructive">
        {error} Reopen the run from Console to try again.
      </p>
    );
  }

  if (projections.length === 0) return null;

  return (
    <section
      aria-label="Best-of-n candidate branches"
      data-testid="best-of-n-branches"
      className="border-t px-4 py-2"
    >
      {projections.map((projection) => {
        const graph = sequenceGraph(projection);
        return (
          <div key={projection.nodeId} className="mb-3 last:mb-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h4 className="font-mono text-[11px] font-medium">{projection.nodeName}</h4>
              <span className="text-[11px] text-muted-foreground">
                {projection.candidateCount} candidates · React Flow sequence
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {SEQUENTIAL_CANDIDATES_NOTICE} The arrows mean “then”, not concurrent fan-out.
            </p>
            <div
              className="mt-1.5 h-44 overflow-hidden rounded-md border bg-muted/20"
              data-testid={`best-of-n-react-flow-${projection.nodeId}`}
            >
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1 }}
                minZoom={0.4}
                maxZoom={1.5}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                zoomOnDoubleClick={false}
                aria-label={`${projection.nodeName} sequential candidate graph`}
              />
            </div>
            {projection.winnerIndex === undefined ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                No candidate has been chosen yet.
              </p>
            ) : (
              projection.rationale && (
                <p className="mt-1 text-[10px] text-muted-foreground">{projection.rationale}</p>
              )
            )}
          </div>
        );
      })}
    </section>
  );
}
