export interface WorkflowBuilderCodebase {
  id: string;
  default_cwd?: string | null;
}

export interface WorkflowBuilderBinding {
  codebaseId: string;
  cwd: string;
}

export function resolveWorkflowBuilderBinding(
  boundCodebaseId: string | null,
  selectedCodebaseId: string | null,
  codebases: readonly WorkflowBuilderCodebase[] | undefined
): WorkflowBuilderBinding | undefined {
  const codebaseId = boundCodebaseId ?? selectedCodebaseId;
  if (!codebaseId) return undefined;
  const cwd = codebases?.find(codebase => codebase.id === codebaseId)?.default_cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? { codebaseId, cwd } : undefined;
}
