"use client";

import { useEffect, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";

export interface Skill {
  id: string;
  name: string;
  description: string;
  // Optional: the backend's /skills response only includes id/name/description.
  author?: string;
  license?: string;
  compatibility?: string;
}

export function useSkills(projectId?: string): { skills: Skill[]; loading: boolean } {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [result, setResult] = useState<{ projectId: string; skills: Skill[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/skills`, {}, scopedProjectId)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (cancelled) return;
        setResult({ projectId: scopedProjectId, skills: Array.isArray(data) ? data : [] });
      })
      .catch(() => {
        if (!cancelled) setResult({ projectId: scopedProjectId, skills: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [scopedProjectId]);

  if (result?.projectId !== scopedProjectId) return { skills: [], loading: true };
  return { skills: result.skills, loading: false };
}
