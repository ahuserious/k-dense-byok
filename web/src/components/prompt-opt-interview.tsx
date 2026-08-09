"use client";

import { InterviewCard, parseInterviewPayload } from "@/components/interview-form";
import type { ActivityItem } from "@/lib/use-agent";

export const PROMPT_OPTIMIZATION_INTERVIEW_PREFIX = "Prompt optimization · ";

export function isPromptOptimizationInterview(item: ActivityItem): boolean {
  if (item.toolName !== "interview") return false;
  const payload = parseInterviewPayload(item.args);
  return payload?.description?.startsWith(PROMPT_OPTIMIZATION_INTERVIEW_PREFIX) ?? false;
}

/**
 * S6 binding to the existing inline structured interview form. The backend
 * uses the originating chat session id, so submission resumes the same paused
 * optimization execution instead of creating a second provider turn.
 */
export function PromptOptimizationInterviewCard({
  item,
  sessionId,
  projectId,
}: {
  item: ActivityItem;
  sessionId: string | null;
  projectId?: string;
}) {
  if (!isPromptOptimizationInterview(item)) return null;
  return (
    <section data-prompt-optimization-interview="true">
      <InterviewCard item={item} sessionId={sessionId} projectId={projectId} />
    </section>
  );
}
