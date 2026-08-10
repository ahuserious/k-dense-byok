export function workflowRequestPath(
  name: string,
  cwd?: string,
  codebaseId?: string,
  source?: string
): string {
  const query = new URLSearchParams();
  if (cwd) query.set('cwd', cwd);
  if (codebaseId) query.set('codebaseId', codebaseId);
  if (source === 'global') query.set('source', source);
  const params = query.toString() ? `?${query.toString()}` : '';
  return `/api/workflows/${encodeURIComponent(name)}${params}`;
}
