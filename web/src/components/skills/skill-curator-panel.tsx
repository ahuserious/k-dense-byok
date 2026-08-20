"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useProjects } from "@/lib/use-projects";
import { listDagWorkflowDefinitions } from "@/lib/dag-workflows";
import {
  applySkillCuration,
  getSkillCuratorCapabilities,
  getSkillCuratorSnapshot,
  type CuratorSkillMode,
  type SkillCuratorCapabilities,
  type SkillCuratorSnapshot,
} from "@/lib/skill-curator";
import { F11_FOCUS_SCOPE } from "./focus-scope";

export interface SkillCuratorPanelProps {
  projectId?: string;
  compact?: boolean;
}

export function SkillCuratorPanel({
  projectId: explicitProjectId,
  compact = false,
}: SkillCuratorPanelProps) {
  const { activeProjectId } = useProjects();
  const projectId = explicitProjectId ?? activeProjectId;
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [snapshot, setSnapshot] = useState<SkillCuratorSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<SkillCuratorCapabilities | null>(null);
  const [nodeId, setNodeId] = useState("");
  const [skillRefs, setSkillRefs] = useState<Set<string>>(new Set());
  const [personalityRefs, setPersonalityRefs] = useState<Set<string>>(new Set());
  const [skillsMode, setSkillsMode] = useState<CuratorSkillMode>("manual");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSnapshot = useCallback(
    async (nextWorkflowId: string) => {
      if (!nextWorkflowId) {
        setSnapshot(null);
        setNodeId("");
        return;
      }
      const next = await getSkillCuratorSnapshot(nextWorkflowId, projectId);
      setSnapshot(next);
      const firstNode = next.nodes[0];
      setNodeId((current) =>
        next.nodes.some((node) => node.id === current) ? current : firstNode?.id ?? ""
      );
    },
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      listDagWorkflowDefinitions(projectId),
      getSkillCuratorCapabilities(projectId),
    ])
      .then(async ([definitions, nextCapabilities]) => {
        if (cancelled) return;
        const nextWorkflows = definitions.map(({ id, name }) => ({ id, name }));
        setWorkflows(nextWorkflows);
        setCapabilities(nextCapabilities);
        const selected = nextWorkflows[0]?.id ?? "";
        setWorkflowId(selected);
        if (selected) await loadSnapshot(selected);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load the skill curator.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSnapshot, projectId]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((node) => node.id === nodeId) ?? null,
    [nodeId, snapshot],
  );

  useEffect(() => {
    if (!selectedNode) {
      setSkillRefs(new Set());
      setPersonalityRefs(new Set());
      return;
    }
    setSkillRefs(new Set(selectedNode.skillRefs));
    setPersonalityRefs(new Set(selectedNode.personalityRefs));
    setSkillsMode(selectedNode.skillsMode);
  }, [selectedNode]);

  const toggleSkill = useCallback((ref: string, checked: boolean) => {
    setSkillRefs((current) => {
      const next = new Set(current);
      if (checked) next.add(ref);
      else next.delete(ref);
      return next;
    });
  }, []);

  const togglePersonality = useCallback((ref: string, checked: boolean) => {
    setPersonalityRefs((current) => {
      const next = new Set(current);
      if (checked) next.add(ref);
      else next.delete(ref);
      return next;
    });
  }, []);

  const apply = useCallback(async () => {
    if (!snapshot || !workflowId || !nodeId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applySkillCuration(
        workflowId,
        {
          expectedRevision: snapshot.definition.revision,
          nodeIds: [nodeId],
          skillRefs: [...skillRefs],
          skillsMode,
          writeMode: "replace",
          ...(snapshot.personalities.available
            ? {
              mimeographs: {
                mode: personalityRefs.size > 0 ? ("manual" as const) : ("auto" as const),
                personalityRefs: [...personalityRefs],
              },
            }
            : {}),
        },
        projectId,
      );
      await loadSnapshot(workflowId);
      setNotice(
        `Saved revision ${result.definition.revision}. The selected skills are now real NodeSpec references and load on the next run.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skill curation.");
    } finally {
      setSaving(false);
    }
  }, [
    loadSnapshot,
    nodeId,
    personalityRefs,
    projectId,
    skillRefs,
    skillsMode,
    snapshot,
    workflowId,
  ]);

  return (
    <section
      aria-labelledby="skill-curator-title"
      className={`${compact ? "space-y-3" : "space-y-4 rounded-lg border p-3"} ${F11_FOCUS_SCOPE}`}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="skill-curator-title" className="text-sm font-medium">
            Workflow skill curator
          </h3>
          <Badge variant="outline" className="text-[10px]">
            existing installer + NodeSpec
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Attach enabled Pi skills and reusable scientist personalities to a saved workflow
          node. The curator reuses the workflow store and enforces the 64-skill / 32-personality
          caps.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/50 p-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border bg-muted p-2 text-xs text-foreground">
          {notice}
        </p>
      )}

      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading saved workflows and loaded skills…
        </p>
      ) : workflows.length === 0 ? (
        <p className="rounded-md border p-2 text-xs text-muted-foreground">
          No saved typed workflows exist in this project. Save a workflow before curating its
          nodes.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium">
              Saved workflow
              <select
                aria-label="Saved workflow"
                className="h-9 w-full rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={workflowId}
                onChange={(event) => {
                  const next = event.target.value;
                  setWorkflowId(next);
                  setError(null);
                  setNotice(null);
                  void loadSnapshot(next).catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Could not load workflow.")
                  );
                }}
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name} ({workflow.id})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium">
              Workflow node
              <select
                aria-label="Workflow node"
                className="h-9 w-full rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={nodeId}
                onChange={(event) => setNodeId(event.target.value)}
              >
                {(snapshot?.nodes ?? []).map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} · {node.kind}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">Node skill selection mode</legend>
            <div className="flex flex-wrap gap-2">
              {(["manual", "auto-manual", "auto"] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  variant={skillsMode === mode ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-[11px]"
                  aria-pressed={skillsMode === mode}
                  onClick={() => setSkillsMode(mode)}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2" role="group" aria-label="Loaded skills">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium">Loaded skills</h4>
              <span className="text-[11px] text-muted-foreground">
                {skillRefs.size}/64 selected
              </span>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
              {(snapshot?.skills ?? []).map((skill) => {
                const selected = skillRefs.has(skill.ref);
                const attached = selectedNode?.skillRefs.includes(skill.ref) ?? false;
                return (
                  <label
                    key={skill.ref}
                    className="flex items-start gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted"
                  >
                    <Switch
                      aria-label={`Attach ${skill.ref}`}
                      checked={selected}
                      disabled={!selected && skillRefs.size >= 64}
                      onCheckedChange={(checked) => toggleSkill(skill.ref, checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono font-medium">{skill.ref}</span>
                        <Badge variant="secondary" className="text-[9px]">
                          {skill.scope}
                        </Badge>
                        {skill.featured && (
                          <Badge variant="outline" className="text-[9px]">
                            F11
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {attached ? "attached to saved revision" : "not attached"}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {skill.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-2" role="group" aria-label="Reusable scientist personalities">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium">Council heads (mimeographs)</h4>
              <span className="text-[11px] text-muted-foreground">
                {personalityRefs.size}/32 selected
              </span>
            </div>
            {snapshot?.personalities.available ? (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1">
                {snapshot.personalities.personalities.map((personality) => (
                  <label
                    key={personality.ref}
                    className="flex items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted"
                  >
                    <Switch
                      aria-label={`Attach personality ${personality.ref}`}
                      checked={personalityRefs.has(personality.ref)}
                      disabled={
                        !personalityRefs.has(personality.ref) && personalityRefs.size >= 32
                      }
                      onCheckedChange={(checked) =>
                        togglePersonality(personality.ref, checked)
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{personality.title}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {personality.ref}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="rounded-md border p-2 text-xs text-muted-foreground">
                {snapshot?.personalities.reason ??
                  "The reusable personality library is unavailable."}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!snapshot || !nodeId || saving || skillRefs.size > 64}
              onClick={() => void apply()}
            >
              {saving ? "Saving curation…" : "Save node curation"}
            </Button>
            {snapshot && (
              <span className="text-[11px] text-muted-foreground">
                Current saved revision {snapshot.definition.revision}
              </span>
            )}
          </div>
        </>
      )}

      {capabilities?.promptElevation && !capabilities.promptElevation.available && (
        <div className="space-y-1 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-medium">Prompt elevation entry point</h4>
            <Badge variant="outline" className="text-[9px]">
              unavailable
            </Badge>
          </div>
          <p id="prompt-elevation-disabled-reason" className="text-[11px] text-muted-foreground">
            {capabilities.promptElevation.reason}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            aria-describedby="prompt-elevation-disabled-reason"
          >
            Elevate prompt to DAG
          </Button>
        </div>
      )}
    </section>
  );
}
