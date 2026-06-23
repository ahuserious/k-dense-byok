// danbot-byok — web/src/components/dag-compose-popover.tsx
//
// The DAG Builder "Add to pipeline" popover (lives in the chat rail). It STACKS pipeline
// stages into the chat input rather than sending each one — pick several workflows /
// skills / databases / protections, review the stacked list in the chat, then send once.
// The rail's KADY agent (archon + scientific-pipeline-builder) turns the stack into the
// pipeline YAML in a single build turn.

"use client";

import { useMemo, useState } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Skill } from "@/components/skills-selector";
import { type Database } from "@/components/database-selector";
import { type Workflow } from "@/components/workflows-panel";
import workflowsData from "@/data/workflows.json";
import databasesData from "@/data/databases.json";

const ALL_WORKFLOWS = workflowsData as Workflow[];
const ALL_DATABASES = databasesData as Database[];
const MAX_PER_SECTION = 5;

// One-click pipeline-shaping suggestions.
const SUGGESTIONS: { label: string; line: string }[] = [
  { label: "Add verification loops & error checking", line: "Add 3× adversarial verification + error checking after each substantive stage (gate the next stage on PASS)." },
  { label: "Create a custom formatted output", line: "Add a final stage that produces a custom formatted output." },
  { label: "Post to arXiv when done", line: "Add a final stage that posts the results to arXiv when the pipeline completes." },
];

// Background-agent protections (stop protection / context-rot / caffeinate).
const PROTECTIONS: { label: string; line: string }[] = [
  { label: "Stop protection (rescue watchdog)", line: "Add stop protection: a background rescue watchdog that detects stalls/timeouts and re-grounds the agent instead of giving up." },
  { label: "Context-rot detection", line: "Add context-rot detection: watch for goal drift / near-duplicate outputs and refresh context when it degrades." },
  { label: "Caffeinate (keep awake)", line: "Keep the machine awake (caffeinate) for the duration of the run so long pipelines don't sleep." },
];

export function DagComposePopover({
  allSkills,
  onStack,
}: {
  allSkills: Skill[];
  /** Append a stage/protection line to the chat input (stacking, no send). */
  onStack: (line: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [stacked, setStacked] = useState(0);

  const query = q.toLowerCase().trim();
  const match = (s: string) => s.toLowerCase().includes(query);
  const workflows = useMemo(
    () => (query ? ALL_WORKFLOWS.filter((w) => match(w.name) || match(w.description)) : ALL_WORKFLOWS).slice(0, MAX_PER_SECTION),
    [query],
  );
  const skills = useMemo(
    () => (query ? allSkills.filter((s) => match(s.name) || match(s.description)) : allSkills).slice(0, MAX_PER_SECTION),
    [allSkills, query],
  );
  const databases = useMemo(
    () => (query ? ALL_DATABASES.filter((d) => match(d.name) || match(d.description)) : ALL_DATABASES).slice(0, MAX_PER_SECTION),
    [query],
  );

  // Append + keep the popover open so several items can be stacked in a row.
  const stack = (line: string) => {
    onStack(line);
    setStacked((n) => n + 1);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setStacked(0);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add to pipeline"
          title="Stack workflows, skills, databases & protections into the pipeline"
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
          Add to pipeline
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 font-mono">
        <div className="border-b p-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search to filter…"
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:border-primary"
            />
          </div>
        </div>
        <div className="max-h-[44vh] overflow-y-auto p-1.5 text-xs">
          <Section title="Suggestions">
            {SUGGESTIONS.map((s) => (
              <Item key={s.label} label={s.label} onClick={() => stack(s.line)} />
            ))}
          </Section>
          <Section title="Background protections">
            {PROTECTIONS.map((p) => (
              <Item key={p.label} label={p.label} onClick={() => stack(p.line)} />
            ))}
          </Section>
          <Section title="Workflows">
            {workflows.map((w) => (
              <Item key={w.id} label={w.name} hint={w.description}
                onClick={() => stack(`Add a stage that runs the "${w.name}" workflow (${w.description}).`)} />
            ))}
          </Section>
          <Section title="Skills">
            {skills.map((s) => (
              <Item key={s.id} label={s.name} hint={s.description}
                onClick={() => stack(`Add a node that uses the "${s.name}" skill.`)} />
            ))}
          </Section>
          <Section title="Databases">
            {databases.map((d) => (
              <Item key={d.id} label={d.name} hint={d.description}
                onClick={() => stack(`Add a data-acquisition node querying the "${d.name}" database (${d.url}).`)} />
            ))}
          </Section>
        </div>
        <div className="flex items-center justify-between border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span>{stacked > 0 ? `${stacked} stacked in chat` : "Stacks into the chat"}</span>
          <span>edit &amp; send to build the YAML</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Item({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/10"
    >
      <span className="font-medium text-foreground">{label}</span>
      {hint && <span className="line-clamp-1 text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  );
}
