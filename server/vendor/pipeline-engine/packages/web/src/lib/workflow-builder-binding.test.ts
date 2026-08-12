import { describe, expect, test } from 'bun:test';
import { resolveWorkflowBuilderBinding } from './workflow-builder-binding';
import { workflowRequestPath } from './workflow-request-path';

describe('resolveWorkflowBuilderBinding', () => {
  test('same-filename edit from A cannot read or write the localStorage-selected project B', () => {
    const codebases = [
      { id: 'codebase-a', default_cwd: '/sandboxes/a' },
      { id: 'codebase-b', default_cwd: '/sandboxes/b' },
    ];
    const binding = resolveWorkflowBuilderBinding('codebase-a', 'codebase-b', codebases);

    expect(binding).toEqual({ codebaseId: 'codebase-a', cwd: '/sandboxes/a' });
    const loadPath = workflowRequestPath('shared.yaml', binding?.cwd, binding?.codebaseId);
    const savePath = workflowRequestPath('shared.yaml', binding?.cwd, binding?.codebaseId);
    expect(loadPath).toContain('codebaseId=codebase-a');
    expect(savePath).toBe(loadPath);
    expect(loadPath).not.toContain('codebaseId=codebase-b');
    expect(loadPath).not.toContain('%2Fsandboxes%2Fb');
  });

  test('changing the bound project produces a distinct binding for reload', () => {
    const codebases = [
      { id: 'codebase-a', default_cwd: '/sandboxes/a' },
      { id: 'codebase-b', default_cwd: '/sandboxes/b' },
    ];
    const first = resolveWorkflowBuilderBinding('codebase-a', 'codebase-b', codebases);
    const second = resolveWorkflowBuilderBinding('codebase-b', 'codebase-a', codebases);

    expect(second).toEqual({ codebaseId: 'codebase-b', cwd: '/sandboxes/b' });
    expect(second).not.toEqual(first);
  });
});
