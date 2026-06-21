// danbot-byok — web/src/lib/pipelines.ts
//
// Client for the Kady `/pipelines` proxy, which forwards to the Archon workflow engine.
// danbot owns the chat + cost UI; Archon owns workflow execution and the visual builder.
// So this client just lists pipelines, triggers runs, and reports engine health — editing
// happens in Archon's own builder (which the Pipelines panel links out to).

import { apiFetch } from "./projects";

export interface PipelineSummary {
  name: string;
  description: string; // first line of Archon's (often multi-line) description
}

function jsonPost(body: unknown): RequestInit {
  // The backend's catch-all content-type parser only treats a body as JSON when the
  // header says so, so set it explicitly.
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** True when the Archon engine answers — lets the panel degrade gracefully when it's down. */
export async function pipelineHealth(): Promise<boolean> {
  try {
    const res = await apiFetch("/pipelines/health");
    if (!res.ok) return false;
    const data = (await res.json()) as { healthy?: boolean };
    return Boolean(data.healthy);
  } catch {
    return false;
  }
}

/** List the workflows Archon knows about (proxied), flattened to {name, description}. */
export async function listPipelines(): Promise<PipelineSummary[]> {
  const res = await apiFetch("/pipelines");
  if (!res.ok) return [];
  const data = (await res.json()) as {
    workflows?: { workflow?: { name?: string; description?: string } }[];
  };
  return (data.workflows ?? [])
    .map((entry) => ({
      name: entry.workflow?.name ?? "",
      description: (entry.workflow?.description ?? "").split("\n")[0] ?? "",
    }))
    .filter((pipeline) => pipeline.name.length > 0);
}

/** Trigger a pipeline run. Archon ties a run to a conversation + a kick-off message. */
export async function runPipeline(
  name: string,
  conversationId: string,
  message: string,
): Promise<unknown> {
  const res = await apiFetch(
    `/pipelines/${encodeURIComponent(name)}/run`,
    jsonPost({ conversationId, message }),
  );
  return res.json();
}
