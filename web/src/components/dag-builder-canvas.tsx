"use client";

import { BrainCircuitIcon, GitBranchIcon, RouterIcon } from "lucide-react";
import { useMemo, useRef } from "react";

import {
  modelRequestSummary,
  nodeKindLabel,
  workflowNodePosition,
} from "@/lib/dag-workflow-builder";
import type {
  FusionWorkflowNode,
  WorkflowGraphDocument,
  WorkflowGraphNode,
  WorkflowNodePosition,
} from "@/lib/dag-workflows";
import { cn } from "@/lib/utils";

const NODE_WIDTH = 264;
const NODE_HEIGHT = 210;
const CANVAS_PADDING = 80;

function FusionParticipant({
  label,
  role,
  model,
}: {
  label: string;
  role: string;
  model: string;
}) {
  return (
    <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 rounded border bg-background/70 px-1.5 py-1 text-[9px] leading-tight">
      <span className="font-semibold uppercase tracking-wide text-primary">{label}</span>
      <span className="truncate font-medium">{role}</span>
      <span className="col-span-2 truncate text-muted-foreground" title={model}>{model}</span>
    </span>
  );
}

export function FusionNodeVisual({ node }: { node: FusionWorkflowNode }) {
  const fusion = node.fusion;
  return (
    <span
      className={cn(
        "mt-2 block rounded-md border p-1.5",
        fusion.mode === "openrouter-router"
          ? "border-violet-500/30 bg-violet-500/5"
          : "border-cyan-500/30 bg-cyan-500/5",
      )}
      data-fusion-mode={node.fusion.mode}
    >
      <span className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide">
        {fusion.mode === "openrouter-router" ? <RouterIcon className="size-2.5" /> : <BrainCircuitIcon className="size-2.5" />}
        {fusion.mode === "openrouter-router" ? "OpenRouter hosted router" : "Kady-owned panel"}
      </span>
      <span className="grid gap-1">
        {fusion.mode === "openrouter-router" ? (
          <FusionParticipant
            label="Router"
            role="Hosted fusion"
            model={modelRequestSummary(fusion.router)}
          />
        ) : null}
        {fusion.members.map((member) => (
          <FusionParticipant
            key={member.id}
            label="Member"
            role={member.role}
            model={modelRequestSummary(member.model)}
          />
        ))}
        {fusion.mode === "openrouter-router" ? (
          <FusionParticipant
            label="Judge"
            role="Final judge"
            model={modelRequestSummary(fusion.judge)}
          />
        ) : (
          <FusionParticipant
            label="Synthesize"
            role="Panel synthesizer"
            model={modelRequestSummary(fusion.synthesizer)}
          />
        )}
      </span>
    </span>
  );
}

function nodeStatus(graph: WorkflowGraphDocument, node: WorkflowGraphNode): string {
  if (node.id === graph.entryNodeId) return "Entry";
  if (node.terminal) return "Terminal";
  return "Nonterminal";
}

function GraphNodeCard({
  graph,
  node,
  index,
  offset,
  selected,
  onSelect,
  onMove,
}: {
  graph: WorkflowGraphDocument;
  node: WorkflowGraphNode;
  index: number;
  offset: WorkflowNodePosition;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  onMove: (nodeId: string, position: WorkflowNodePosition) => void;
}) {
  const drag = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    origin: WorkflowNodePosition;
  } | null>(null);
  const position = workflowNodePosition(node, index);

  return (
    <button
      type="button"
      aria-label={`${node.name}, ${nodeKindLabel(node.kind)} node`}
      aria-pressed={selected}
      data-node-id={node.id}
      onClick={() => onSelect(node.id)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onSelect(node.id);
        drag.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          origin: position,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - active.clientX;
        const deltaY = event.clientY - active.clientY;
        if (Math.abs(deltaX) < 2 && Math.abs(deltaY) < 2) return;
        onMove(node.id, {
          x: Math.round(active.origin.x + deltaX),
          y: Math.round(active.origin.y + deltaY),
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const deltas: Partial<Record<typeof event.key, WorkflowNodePosition>> = {
          ArrowLeft: { x: -10, y: 0 },
          ArrowRight: { x: 10, y: 0 },
          ArrowUp: { x: 0, y: -10 },
          ArrowDown: { x: 0, y: 10 },
        };
        const delta = deltas[event.key];
        if (!delta) return;
        event.preventDefault();
        onMove(node.id, { x: position.x + delta.x, y: position.y + delta.y });
      }}
      className={cn(
        "absolute z-10 min-h-[210px] overflow-hidden rounded-lg border bg-background p-3 text-left shadow-sm transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary shadow-md ring-1 ring-primary/30"
          : "border-border hover:border-primary/40 hover:shadow-md",
      )}
      style={{
        left: position.x + offset.x,
        top: position.y + offset.y,
        width: NODE_WIDTH,
        touchAction: "none",
      }}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold">{node.name}</span>
          <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">{node.id}</span>
        </span>
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
          {nodeStatus(graph, node)}
        </span>
      </span>
      <span className="mt-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <GitBranchIcon className="size-3" />
        {nodeKindLabel(node.kind)}
      </span>
      {node.description ? (
        <span className="mt-1 block line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
          {node.description}
        </span>
      ) : null}
      {node.kind === "fusion" ? <FusionNodeVisual node={node} /> : null}
      {node.kind !== "fusion" && "model" in node && node.model ? (
        <span className="mt-3 block rounded border bg-muted/20 px-2 py-1.5 text-[9px] leading-relaxed text-muted-foreground">
          {modelRequestSummary(node.model)}
        </span>
      ) : null}
    </button>
  );
}

export function DagBuilderCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
  onMoveNode,
}: {
  graph: WorkflowGraphDocument;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onMoveNode: (nodeId: string, position: WorkflowNodePosition) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const layout = useMemo(() => {
    const positions = graph.nodes.map(workflowNodePosition);
    const minimumX = Math.min(...positions.map((position) => position.x), 0);
    const minimumY = Math.min(...positions.map((position) => position.y), 0);
    const offset = {
      x: CANVAS_PADDING - minimumX,
      y: CANVAS_PADDING - minimumY,
    };
    const maximumX = Math.max(...positions.map((position) => position.x + offset.x), 0);
    const maximumY = Math.max(...positions.map((position) => position.y + offset.y), 0);
    return {
      offset,
      width: Math.max(1_100, maximumX + NODE_WIDTH + CANVAS_PADDING),
      height: Math.max(720, maximumY + NODE_HEIGHT + CANVAS_PADDING),
    };
  }, [graph.nodes]);
  const nodePositionById = useMemo(() => new Map(
    graph.nodes.map((node, index) => [node.id, workflowNodePosition(node, index)]),
  ), [graph.nodes]);

  return (
    <div
      ref={viewportRef}
      className="h-full min-h-0 overflow-auto bg-muted/10"
      aria-label="DAG graph canvas viewport"
    >
      <div
        className="relative cursor-grab active:cursor-grabbing"
        data-testid="dag-builder-canvas"
        style={{
          width: layout.width,
          height: layout.height,
          backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.22) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          touchAction: "none",
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0) return;
          const viewport = viewportRef.current;
          if (!viewport) return;
          pan.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = pan.current;
          const viewport = viewportRef.current;
          if (!active || active.pointerId !== event.pointerId || !viewport) return;
          viewport.scrollLeft = active.scrollLeft - (event.clientX - active.clientX);
          viewport.scrollTop = active.scrollTop - (event.clientY - active.clientY);
        }}
        onPointerUp={(event) => {
          if (pan.current?.pointerId === event.pointerId) pan.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
      >
        <svg
          aria-label="Workflow edges"
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = nodePositionById.get(edge.from);
            const to = nodePositionById.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + layout.offset.x + NODE_WIDTH;
            const y1 = from.y + layout.offset.y + NODE_HEIGHT / 2;
            const x2 = to.x + layout.offset.x;
            const y2 = to.y + layout.offset.y + NODE_HEIGHT / 2;
            const curve = Math.max(60, Math.abs(x2 - x1) / 2);
            const path = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
            return (
              <g key={edge.id} data-edge-id={edge.id}>
                <path
                  d={path}
                  fill="none"
                  className="stroke-muted-foreground/70"
                  strokeWidth="2"
                  markerEnd="url(#dag-arrow)"
                />
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 7}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {edge.condition ?? "always"}
                </text>
              </g>
            );
          })}
        </svg>

        {graph.nodes.map((node, index) => (
          <GraphNodeCard
            key={node.id}
            graph={graph}
            node={node}
            index={index}
            offset={layout.offset}
            selected={selectedNodeId === node.id}
            onSelect={onSelectNode}
            onMove={onMoveNode}
          />
        ))}
      </div>
    </div>
  );
}
