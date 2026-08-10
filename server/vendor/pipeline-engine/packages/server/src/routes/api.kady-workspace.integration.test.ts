import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testRoot: string | undefined;

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe('Kady non-git workspace integration', () => {
  test('createProject sandbox lists and launches a scoped workflow without git init', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'pipeline-kady-workspace-'));
    const childEnvironment = { ...process.env };
    childEnvironment.ARCHON_HOME = join(testRoot, 'engine-home');
    childEnvironment.KADY_PROJECTS_ROOT = join(testRoot, 'projects');
    delete childEnvironment.DATABASE_URL;

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
      registrationStatus: number;
      listStatus: number;
      workflowId: string;
      launchStatus: number;
      launchBody: unknown;
    };
    expect(result).toEqual({
      hasGitDirectory: false,
      registrationStatus: 201,
      listStatus: 200,
      workflowId: expect.stringMatching(/^workflow_[a-f0-9]{32}$/),
      launchStatus: 200,
      launchBody: { accepted: true, status: 'started' },
    });
  });
});
