import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testRoot: string | undefined;

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe('Kady git workspace integration', () => {
  test('terminalizes post-claim isolation and row-rebind failures and releases admission holds', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'pipeline-kady-async-failure-'));
    const childEnvironment = { ...process.env };
    childEnvironment.ARCHON_HOME = join(testRoot, 'engine-home');
    childEnvironment.KADY_PROJECTS_ROOT = join(testRoot, 'projects');
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.FORCE_COLOR;
    delete childEnvironment.NO_COLOR;
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'api.kady-async-failure.integration.fixture.mjs')],
      { env: childEnvironment, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const resultLine = stdout
      .split('\n')
      .find(line => line.startsWith('KADY_ASYNC_FAILURE_RESULT='));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!.slice('KADY_ASYNC_FAILURE_RESULT='.length));
    for (const stage of ['isolation', 'rebind']) {
      expect(result[stage]).toEqual({
        launchStatus: 200,
        terminalStatus: 'failed',
        dispatchState: 'failed',
        failureStage: 'setup',
        watermarkCost: 0,
        reconciliationEvidence: 'durable-completion-watermark',
        admissionStatus: 'settled',
        reservationStatuses: ['failed'],
        activeReservedUsd: 0,
      });
    }
  }, 60_000);

  test('scopes list and every addressed run lifecycle route to the active codebase', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'pipeline-kady-lifecycle-'));
    const childEnvironment = { ...process.env };
    childEnvironment.ARCHON_HOME = join(testRoot, 'engine-home');
    childEnvironment.KADY_PROJECTS_ROOT = join(testRoot, 'projects');
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.FORCE_COLOR;
    delete childEnvironment.NO_COLOR;
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'api.kady-lifecycle.integration.fixture.mjs')],
      { env: childEnvironment, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const resultLine = stdout
      .split('\n')
      .find(line => line.startsWith('KADY_LIFECYCLE_RESULT='));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!.slice('KADY_LIFECYCLE_RESULT='.length));
    expect(result).toMatchObject({
      listStatus: 200,
      listedIds: [result.ownRunId],
      getCrossStatus: 404,
      streamCrossStatus: 404,
      resumeCrossStatus: 404,
      cancelCrossStatus: 404,
      hiddenRunStatusAfterActions: 'pending',
    });
    expect(result.listedIds).not.toContain(result.hiddenRunId);
  }, 60_000);

  test('new, default, and upgraded projects register and complete through the real lock', async () => {
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
      runSnapshotSha: string;
      snapshotInput: string;
      workerInput: string;
      nestedCrud: Record<string, unknown>;
      defaultProject: Record<string, unknown>;
      upgradedProject: Record<string, unknown>;
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
      runSnapshotSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      snapshotInput: 'current-v2',
      workerInput: 'current-v2',
      nestedCrud: {
        filenames: ['alpha/shared.yaml', 'beta/shared.yaml'],
        distinctStableIds: true,
        alphaGetName: 'alpha-shared',
        betaGetName: 'beta-shared',
        alphaUpdateStatus: 200,
        betaDeleteStatus: 200,
        alphaUpdatedInPlace: true,
        betaDeletedInPlace: true,
        rootSiblingCreated: false,
      },
      defaultProject: {
        hasGitDirectory: true,
        commitCountAfterUpgrade: 1,
        commitCountAfterRepeat: 1,
        registrationStatus: 201,
        listStatus: 200,
        launchStatus: 200,
        terminalStatus: 'completed',
      },
      upgradedProject: {
        hasGitDirectory: true,
        commitCountAfterUpgrade: 1,
        commitCountAfterRepeat: 1,
        legacyFileTracked: true,
        registrationStatus: 201,
        listStatus: 200,
        launchStatus: 200,
        terminalStatus: 'completed',
      },
    });
  }, 60_000);

  test('replays a process-crashed pre-dispatch admission and completes the original run', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'pipeline-kady-dispatch-crash-'));
    const childEnvironment = { ...process.env };
    childEnvironment.ARCHON_HOME = join(testRoot, 'engine-home');
    childEnvironment.KADY_PROJECTS_ROOT = join(testRoot, 'projects');
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.FORCE_COLOR;
    delete childEnvironment.NO_COLOR;
    const fixture = join(import.meta.dir, 'api.kady-dispatch-crash.integration.fixture.mjs');

    const seed = Bun.spawn([process.execPath, fixture], {
      env: { ...childEnvironment, KADY_CRASH_FIXTURE_MODE: 'seed' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [seedExit, _seedStdout, seedStderr] = await Promise.all([
      seed.exited,
      new Response(seed.stdout).text(),
      new Response(seed.stderr).text(),
    ]);
    expect({ seedExit, seedStderr }).toEqual({ seedExit: 86, seedStderr: '' });
    const seeded = JSON.parse(
      readFileSync(join(testRoot, 'engine-home', 'crash-state.json'), 'utf8')
    ) as {
      runId: string;
      pendingStatus: string;
      dispatchState: string;
      [key: string]: unknown;
    };
    expect(seeded).toMatchObject({ pendingStatus: 'pending', dispatchState: 'pre_dispatch' });

    const replay = Bun.spawn([process.execPath, fixture], {
      env: {
        ...childEnvironment,
        KADY_CRASH_FIXTURE_MODE: 'replay',
        KADY_CRASH_STATE: JSON.stringify(seeded),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [replayExit, replayStdout, replayStderr] = await Promise.all([
      replay.exited,
      new Response(replay.stdout).text(),
      new Response(replay.stderr).text(),
    ]);
    expect({ replayExit, replayStderr }).toEqual({ replayExit: 0, replayStderr: '' });
    const replayLine = replayStdout
      .split('\n')
      .find(line => line.startsWith('KADY_CRASH_REPLAY='));
    expect(replayLine).toBeDefined();
    const replayed = JSON.parse(replayLine!.slice('KADY_CRASH_REPLAY='.length)) as {
      replayStatus: number;
      runId: string;
      terminalStatus: string;
      dispatchState: string;
    };
    expect(replayed).toEqual({
      replayStatus: 200,
      runId: seeded.runId,
      terminalStatus: 'completed',
      dispatchState: 'running',
    });
  }, 60_000);
});
