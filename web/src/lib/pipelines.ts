// danbot-byok — web/src/lib/pipelines.ts
//
// Client for the Kady `/pipelines` proxy, which forwards to the pipeline engine.
// Kady owns the chat + cost UI; the engine owns workflow execution and the visual builder.
// So this client just lists pipelines, triggers runs, and reports engine health — editing
// happens in the embedded Scientific DAG Workflow Designer.

import { apiFetch } from "./projects";

export interface PipelineSummary {
  name: string;
  description: string; // first line of the engine's often multi-line description
}

function jsonPost(body: unknown): RequestInit {
  // The backend's catch-all content-type parser only treats a body as JSON when the
  // header says so, so set it explicitly.
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "No error body returned.";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error", "detail", "message"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
          return record[key];
        }
      }
    }
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return text;
  }
}

async function requireOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const detail = await errorDetail(response);
  throw new Error(`${operation} failed (${response.status}): ${detail}`);
}

/** True when the pipeline engine answers. Non-2xx responses remain observable failures. */
export async function pipelineHealth(): Promise<boolean> {
  const res = await apiFetch("/pipelines/health");
  await requireOk(res, "Pipeline health check");
  const data = (await res.json()) as { healthy?: boolean };
  return Boolean(data.healthy);
}

/** List proxied workflows, flattened to {name, description}. */
export async function listPipelines(): Promise<PipelineSummary[]> {
  const res = await apiFetch("/pipelines");
  await requireOk(res, "Pipeline list");
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

/**
 * Trigger a pipeline run. The engine ties a run to a conversation + a kick-off message.
 *
 * `model` is an optional Kady model ref (e.g. "openrouter/anthropic/claude-opus-4.8")
 * sourced from the SAME merged catalogue the chat picker uses, so a pipeline run can
 * use Kady's model list. When provided it's forwarded in the run body; the Kady proxy
 * threads it through to the engine's run options so Pi resolves the chosen model.
 */
export async function runPipeline(
  name: string,
  conversationId: string,
  message: string,
  model?: string,
): Promise<unknown> {
  const res = await apiFetch(
    `/pipelines/${encodeURIComponent(name)}/run`,
    jsonPost({ conversationId, message, ...(model ? { model } : {}) }),
  );
  await requireOk(res, "Pipeline run");
  return res.json();
}
