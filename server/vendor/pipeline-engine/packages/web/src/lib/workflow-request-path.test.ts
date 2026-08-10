import { describe, expect, test } from 'bun:test';
import { workflowRequestPath } from './workflow-request-path';

describe('workflowRequestPath', () => {
  test('keeps same-filename reads and writes bound to their exact codebase', () => {
    const projectARead = workflowRequestPath('shared.yaml', '/sandboxes/a', 'codebase-a');
    const projectAWrite = workflowRequestPath('shared.yaml', '/sandboxes/a', 'codebase-a');
    const projectBRead = workflowRequestPath('shared.yaml', '/sandboxes/b', 'codebase-b');

    expect(projectARead).toBe(
      '/api/workflows/shared.yaml?cwd=%2Fsandboxes%2Fa&codebaseId=codebase-a'
    );
    expect(projectAWrite).toBe(projectARead);
    expect(projectARead).not.toBe(projectBRead);
    expect(new URL(projectARead, 'http://engine.local').searchParams.get('codebaseId'))
      .toBe('codebase-a');
    expect(new URL(projectARead, 'http://engine.local').searchParams.get('cwd'))
      .toBe('/sandboxes/a');
  });
});
