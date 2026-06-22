// danbot-byok — web/src/components/agent-console/run-history-table.tsx
//
// Ported from agent-control-plane's RunHistoryTable.tsx. The flat history of every
// recorded run. React-19 port: "use client", @/ aliased types (no .ts extension),
// and the raw .history/.badge/.pill CSS rebuilt with Tailwind + the ui/ Badge.
// The role badge is extended to cover all of Kady's run roles, not just ACP's
// orchestrator/worker pair.

"use client";

import type { ComponentProps } from "react";
import type { Run, RunRole } from "@/lib/console-types";
import { Badge } from "@/components/ui/badge";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

// Map every Kady run role to a Badge variant so the history column stays legible
// across loop rows (orchestrator/worker) and the chat/council/workflow rows Kady
// also records. Unknown roles fall back via the ?? in roleVariant().
const ROLE_VARIANT: Record<RunRole, BadgeVariant> = {
  orchestrator: "default",
  worker: "secondary",
  agent: "outline",
  subagent: "outline",
  council: "secondary",
  workflow: "ghost",
};

function roleVariant(role: RunRole): BadgeVariant {
  return ROLE_VARIANT[role] ?? "outline";
}

function statusVariant(status: Run["status"]): BadgeVariant {
  if (status === "failed") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0)
    return <p className="text-xs text-muted-foreground">No runs recorded yet.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 font-medium">Round</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Tokens</th>
            <th className="px-3 py-2 font-medium">Turns</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b last:border-0 align-top">
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {fmt(r.started_at)}
              </td>
              <td className="px-3 py-2">#{r.iteration}</td>
              <td className="px-3 py-2">
                <Badge variant={roleVariant(r.role)}>{r.role}</Badge>
              </td>
              <td className="px-3 py-2">
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
              </td>
              <td className="px-3 py-2">
                {r.role === "orchestrator" && r.reasoning
                  ? r.reasoning.slice(0, 160)
                  : (r.output ?? "")
                      .replace(/LOOP_STATUS:.*/i, "")
                      .trim()
                      .slice(0, 160) || "-"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {r.input_tokens ?? "-"} / {r.output_tokens ?? "-"}
              </td>
              <td className="px-3 py-2">{r.num_turns ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
