// danbot-byok — web/src/components/agent-console/start-loop-form.tsx
//
// Ported from agent-control-plane's StartLoopForm.tsx. Starts a new goal loop.
// React-19 port: "use client", imports the same-origin console client (no
// import.meta.env), and the raw .start-form/.mode/.iter CSS is rebuilt with
// Tailwind + the ui/ Input and Button primitives.

"use client";

import { useState } from "react";
import { startLoop } from "@/lib/console";
import type { LoopMode } from "@/lib/console-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function StartLoopForm({ onStarted }: { onStarted: () => void }) {
  const [goal, setGoal] = useState("");
  const [maxIterations, setMaxIterations] = useState(5);
  const [mode, setMode] = useState<LoopMode>("orchestrated");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await startLoop(goal.trim(), maxIterations, mode);
      setGoal("");
      onStarted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3"
    >
      <Input
        placeholder="Goal for the loop, e.g. Build a CLI todo app with tests"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="min-w-[16rem] flex-1"
      />
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        mode
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as LoopMode)}
          className="h-9 rounded-md border bg-background px-2 text-xs text-foreground"
        >
          <option value="orchestrated">orchestrated (agents prompting agents)</option>
          <option value="ralph">ralph (single-agent loop)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        max rounds
        <Input
          type="number"
          min={1}
          max={100}
          value={maxIterations}
          onChange={(e) => setMaxIterations(Number(e.target.value))}
          className="w-24"
        />
      </label>
      <Button type="submit" disabled={busy || !goal.trim()}>
        {busy ? "Starting…" : "Start loop"}
      </Button>
    </form>
  );
}
