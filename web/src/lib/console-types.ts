// danbot-byok — web/src/lib/console-types.ts
//
// Types for the Kady "Agent Console", ported from agent-control-plane's
// frontend/src/types.ts. The console observes long-running goal loops (Pi loops)
// and the runs they spawn, served same-origin from the Kady backend under /console/*.
//
// Two deltas from the upstream ACP types:
//   1. RunRole is widened to Kady's full role union. ACP only ran
//      orchestrator/worker loops; Kady also records chat/council/workflow rows
//      (a single agent turn, a council of agents, a workflow node) so the run
//      history can surface every kind of execution, not just loop iterations.
//   2. Run gains a few nullable fields that those non-loop rows populate
//      (conversation_id / workflow_id) while staying optional so loop rows,
//      which never set them, still satisfy the type.

export type LoopStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type LoopMode = "orchestrated" | "ralph";

// Kady records more than just loop orchestrator/worker rows. 'agent' is a single
// agent turn, 'subagent' a Pi-spawned child, 'council' a multi-agent deliberation,
// and 'workflow' an Archon workflow node. 'orchestrator'/'worker' remain for the
// ACP-style loop views.
export type RunRole =
  | "agent"
  | "subagent"
  | "council"
  | "workflow"
  | "orchestrator"
  | "worker";

export interface Loop {
  id: string;
  goal: string;
  status: LoopStatus;
  mode: LoopMode;
  max_iterations: number;
  iterations: number;
  model: string | null;
  workspace: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  // loop_id is null for chat/workflow rows that aren't part of a goal loop.
  loop_id: string | null;
  iteration: number;
  task: string;
  role: RunRole;
  parent_run_id: string | null;
  reasoning: string | null;
  status: "running" | "completed" | "failed";
  output: string | null;
  model: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  num_turns: number | null;
  session_id: string | null;
  // Set on chat/council rows so the row can link back to its conversation.
  conversation_id?: string | null;
  // Set on workflow rows so the row can link back to its Archon workflow run.
  workflow_id?: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface LoopDetail extends Loop {
  runs: Run[];
}
