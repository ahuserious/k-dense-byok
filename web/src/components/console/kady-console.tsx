// danbot-byok — web/src/components/console/kady-console.tsx
//
// The Console tab's native view. It renders KADY's OWN run + loop feed (GET /console/runs,
// /console/loops via lib/console.ts) — so agents you fire from the chat / rail / pipelines
// actually show up here. (The previous Console embedded Archon's /console, which only shows
// Archon workflow runs, never Kady's — which is why a fired agent was invisible.)
//
// Raindrop-styled agent surface: black + monospace, white-overlay rows.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { listLoops, listRuns } from "@/lib/console";
import type { Loop, Run } from "@/lib/console-types";

const POLL_MS = 3000;

const ROLE_STYLE: Record<string, string> = {
  agent: "text-sky-300 bg-sky-400/10",
  subagent: "text-indigo-300 bg-indigo-400/10",
  council: "text-violet-300 bg-violet-400/10",
  workflow: "text-teal-300 bg-teal-400/10",
  orchestrator: "text-amber-300 bg-amber-400/10",
  worker: "text-zinc-300 bg-white/10",
};
const STATUS_STYLE: Record<string, string> = {
  running: "text-amber-300",
  completed: "text-emerald-400",
  failed: "text-red-400",
};

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function usd(n: number | null): string {
  return n == null ? "—" : `$${n.toFixed(4)}`;
}

export function KadyConsole() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([listRuns(), listLoops()]);
      if (!mounted.current) return;
      setRuns(r);
      setLoops(l);
      setError(null);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black font-mono text-[#d5dadd]">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="text-xs font-semibold text-white">Console</span>
        <span className="text-[11px] text-zinc-500">
          {runs.length} run{runs.length === 1 ? "" : "s"}
          {loops.length > 0 ? ` · ${loops.length} loop${loops.length === 1 ? "" : "s"}` : ""}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
        >
          <RefreshCwIcon className="size-3" />
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-2 text-[11px] text-red-400">
            Couldn&apos;t reach the console: {error}
          </p>
        )}

        {loops.length > 0 && (
          <div className="border-b border-white/10 p-2">
            <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Goal loops
            </div>
            {loops.map((lp) => (
              <div key={lp.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px]", STATUS_STYLE[lp.status] ?? "text-zinc-400")}>
                  {lp.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{lp.goal}</span>
                <span className="text-[10px] text-zinc-500">
                  {lp.iterations}/{lp.max_iterations}
                </span>
              </div>
            ))}
          </div>
        )}

        {loading && runs.length === 0 ? (
          <p className="flex items-center gap-2 px-3 py-3 text-[11px] text-zinc-500">
            <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading runs…
          </p>
        ) : runs.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-zinc-500">
            No agent runs yet. Fire an agent from a chat, the DAG Builder rail, or a pipeline
            and it&apos;ll appear here.
          </p>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-black">
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-1 font-normal">Role</th>
                <th className="px-2 py-1 font-normal">Task</th>
                <th className="px-2 py-1 font-normal">Status</th>
                <th className="px-2 py-1 font-normal">Model</th>
                <th className="px-2 py-1 text-right font-normal">Cost</th>
                <th className="px-2 py-1 text-right font-normal">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-white/5 align-top hover:bg-white/[0.03]">
                  <td className="px-2 py-1.5">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px]", ROLE_STYLE[r.role] ?? "text-zinc-300 bg-white/10")}>
                      {r.role}
                    </span>
                  </td>
                  <td className="max-w-0 px-2 py-1.5">
                    <div className="truncate text-zinc-200" title={r.task}>{r.task || "—"}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={cn(STATUS_STYLE[r.status] ?? "text-zinc-400")}>
                      {r.status === "running" && <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-amber-400 align-middle" />}
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-zinc-400">{r.model ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{usd(r.cost_usd)}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{ago(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
