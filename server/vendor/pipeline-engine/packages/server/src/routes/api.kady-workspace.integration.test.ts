import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testRoot: string | undefined;

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe('Kady git workspace integration', () => {
  test('createProject retains a lost-response pending admission and completes through the real lock', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'pipeline-kady-workspace-'));
    const childEnvironment = { ...process.env };
    childEnvironment.ARCHON_HOME = join(testRoot, 'engine-home');
    childEnvironment.KADY_PROJECTS_ROOT = join(testRoot, 'projects');
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.FORCE_COLOR;
    delete childEnvironment.NO_COLOR;

    // Route-unit tests use process-global Bun module mocks. Run this real-engine
    // proof in a clean child process so those mocks cannot replace the database,
    // registration, discovery, or route modules under test.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'api.kady-workspace.integration.fixture.mjs')],
      {
        env: childEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

    const resultLine = stdout
      .split('\n')
      .find(line => line.startsWith('KADY_WORKSPACE_RESULT='));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!.slice('KADY_WORKSPACE_RESULT='.length)) as {
      hasGitDirectory: boolean;
      initialCommitAuthor: string;
      initialCommitCount: number;
      seededContentsCommitted: boolean;
      finalCommitCount: number;
      registrationStatus: number;
      saveStatus: number;
      listStatus: number;
      workflowId: string;
      launchStatus: number;
      pendingAuthoritative: boolean;
      pendingStatus: string;
      terminalStatus: string;
      terminalWorkingPath: string;
    };
    expect(result).toEqual({
      hasGitDirectory: true,
      initialCommitAuthor: 'Kady <kady@localhost>',
      initialCommitCount: 1,
      seededContentsCommitted: true,
      finalCommitCount: 1,
      registrationStatus: 201,
      saveStatus: 200,
      listStatus: 200,
      workflowId: expect.stringMatching(/^workflow_[a-f0-9]{32}$/),
      launchStatus: 200,
      pendingAuthoritative: true,
      pendingStatus: 'pending',
      terminalStatus: 'completed',
      terminalWorkingPath: expect.stringContaining('worktrees'),
    });
  }, 30_000);
});
