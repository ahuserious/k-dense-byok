// danbot-byok — web/src/components/dag-compose-popover.tsx
//
// The DAG Builder "+" / compose popover (lives in the chat rail). It is the
// "stitch workflows into a pipeline" entry point: pick a k-dense workflow, a skill,
// or a database to add as a pipeline stage, or apply a one-click pipeline suggestion.
// Each choice sends a natural-language compose instruction to the rail's KADY agent
// (which has the archon + scientific-pipeline-builder skills) to actually edit the
// current pipeline — robust + testable, vs. hand-surgery on Archon's canvas.

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

// One-click pipeline-building suggestions (the asks: verification, custom output, arxiv).
const SUGGESTIONS: { label: string; message: string }[] = [
  {
    label: "Add verification loops & error checking",
    message:
      "Add 3× adversarial verification loops and error checking after each substantive stage of the current pipeline (each verifier re-reads the stage goal + output and emits PASS/FAIL; the next stage gates on PASS).",
  },
  {
    label: "Create a custom formatted output",
    message:
      "Add a final node to the current pipeline that produces a custom formatted output (let me specify the format).",
  },
  {
    label: "Post to arXiv when done",
    message:
      "Add a final node to the current pipeline that posts the finished results to arXiv when the pipeline completes.",
  },
];

export function DagComposePopover({
  allSkills,
  onCompose,
}: {
  allSkills: Skill[];
  /** Send a compose instruction to the rail's KADY agent. */
  onCompose: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const query = q.toLowerCase().trim();
  const workflows = useMemo(
    () =>
      (query
        ? ALL_WORKFLOWS.filter(
            (w) =>
              w.name.toLowerCase().includes(query) ||
              w.description.toLowerCase().includes(query),
          )
        : ALL_WORKFLOWS
      ).slice(0, 8),
    [query],
  );
  const skills = useMemo(
    () =>
      (query
        ? allSkills.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              s.description.toLowerCase().includes(query),
          )
        : allSkills
      ).slice(0, 8),
    [allSkills, query],
  );
  const databases = useMemo(
    () =>
      (query
        ? ALL_DATABASES.filter(
            (d) =>
              d.name.toLowerCase().includes(query) ||
              d.description.toLowerCase().includes(query),
          )
        : ALL_DATABASES
      ).slice(0, 8),
    [query],
  );

  const compose = (message: string) => {
    onCompose(message);
    setOpen(false);
    setQ("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add to pipeline"
          title="Add a workflow, skill, or database to the pipeline"
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
              placeholder="Search pipelines, skills, databases…"
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:border-primary"
            />
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1.5 text-xs">
          <ComposeSection title="Suggestions">
            {SUGGESTIONS.map((s) => (
              <ComposeItem key={s.label} label={s.label} onClick={() => compose(s.message)} />
            ))}
          </ComposeSection>

          <ComposeSection title="Workflows">
            {workflows.map((w) => (
              <ComposeItem
                key={w.id}
                label={w.name}
                hint={w.description}
                onClick={() =>
                  compose(
                    `Use the scientific-pipeline-builder and archon skills to add the "${w.name}" workflow as a stage to the current pipeline. Workflow purpose: ${w.description}`,
                  )
                }
              />
            ))}
          </ComposeSection>

          <ComposeSection title="Skills">
            {skills.map((s) => (
              <ComposeItem
                key={s.id}
                label={s.name}
                hint={s.description}
                onClick={() =>
                  compose(
                    `Add a node to the current pipeline that uses the "${s.name}" skill.`,
                  )
                }
              />
            ))}
          </ComposeSection>

          <ComposeSection title="Databases">
            {databases.map((d) => (
              <ComposeItem
                key={d.id}
                label={d.name}
                hint={d.description}
                onClick={() =>
                  compose(
                    `Add a data-acquisition node to the current pipeline that queries the "${d.name}" database (${d.url}).`,
                  )
                }
              />
            ))}
          </ComposeSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ComposeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function ComposeItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
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
