import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below.
// Covers: GET /api/auth/status (enabled/disabled shape) and the non-enforcing
// ?mine filter on the runs + conversations list endpoints (session-first, then
// the X-Pipeline-User header, threaded into the DB query as a userId filter).
// ---------------------------------------------------------------------------

const mockWarn = mock(() => undefined);
const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mockWarn,
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

// --- Controllable web-auth module (../auth) ---
let authEnabled = false;
let signupMode: 'allowlist' | 'open' | 'disabled' = 'disabled';
let apiGateEnabled = false;
let authInstance: { api: { getSession: (args: unknown) => Promise<unknown> } } | null = null;

mock.module('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => authEnabled,
  getSignupMode: () => signupMode,
  isApiGateEnabled: () => apiGateEnabled,
}));

// --- Identity resolution ---
const mockFindOrCreateUser = mock(async (_platform: string, platformUserId: string) => ({
  id: `user-from-${platformUserId}`,
  display_name: null,
  email: null,
  role: 'admin' as const,
  created_at: new Date(),
  updated_at: new Date(),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

// --- List endpoints we assert the filter threading on ---
const mockListWorkflowRuns = mock(async (_opts?: { userId?: string }) => [] as unknown[]);
const mockListConversations = mock(
  async (
    _limit?: number,
    _platform?: string,
    _codebaseId?: string,
    _excludeEmpty?: boolean,
    _userId?: string
  ) => [] as unknown[]
);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
}));

mock.module('@archon/paths', () => ({
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.pipeline-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.pipeline-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mockListConversations,
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'm' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes, resetLegacyWebIdentityHeaderWarningForTests } from './api';

const originalPipelineWebAuthHeader = process.env.PIPELINE_WEB_AUTH_HEADER;
const originalWebAuthHeader = process.env.ARCHON_WEB_AUTH_HEADER;

beforeEach(() => {
  delete process.env.PIPELINE_WEB_AUTH_HEADER;
  delete process.env.ARCHON_WEB_AUTH_HEADER;
  resetLegacyWebIdentityHeaderWarningForTests();
  mockWarn.mockClear();
});

afterEach(() => {
  if (originalPipelineWebAuthHeader === undefined) delete process.env.PIPELINE_WEB_AUTH_HEADER;
  else process.env.PIPELINE_WEB_AUTH_HEADER = originalPipelineWebAuthHeader;
  if (originalWebAuthHeader === undefined) delete process.env.ARCHON_WEB_AUTH_HEADER;
  else process.env.ARCHON_WEB_AUTH_HEADER = originalWebAuthHeader;
});

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

describe('GET /api/auth/status', () => {
  beforeEach(() => {
    authEnabled = false;
    // `disabled` is the real default posture (no allowlist + no open-signup flag).
    signupMode = 'disabled';
    authInstance = null;
  });

  test('auth disabled → { enabled: false, signup: disabled }', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, signup: 'disabled' });
  });

  test('enabled + no allowlist → { enabled: true, signup: disabled } (safe default)', async () => {
    authEnabled = true;
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'disabled' });
  });

  test('enabled + allowlist → { enabled: true, signup: allowlist }', async () => {
    authEnabled = true;
    signupMode = 'allowlist';
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'allowlist' });
  });
});

describe('server-side /api/* gate', () => {
  beforeEach(() => {
    authEnabled = false;
    apiGateEnabled = false;
    authInstance = null;
    mockFindOrCreateUser.mockClear();
  });
  afterEach(() => {
    apiGateEnabled = false; // don't leak the gate into other describes
  });

  test('gate off (default) → /api/conversations is reachable unauthenticated', async () => {
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('gate on + no identity → 401 on a protected /api route', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });

  test('gate on → /api/auth/status stays public (login surface allowlisted)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    const res = await makeApp().request('/api/auth/status');
    expect(res.status).toBe(200);
  });

  test('gate on → /api/health is never blocked by the gate (healthcheck allowlist)', async () => {
    apiGateEnabled = true;
    // /api/health is registered in startServer, not registerApiRoutes, so it 404s
    // in this app — but the assertion that matters is it is NOT a 401 (the gate let it through).
    const res = await makeApp().request('/api/health');
    expect(res.status).not.toBe(401);
  });

  test('gate on + Better Auth session → protected route passes', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: { getSession: async () => ({ user: { id: 'sess-1', name: 'A', email: 'a@x.io' } }) },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('legacy default trusts only X-Archon-User and warns at startup', async () => {
    apiGateEnabled = true;
    const app = makeApp();
    const untrusted = await app.request('/api/conversations', {
      headers: { 'X-Pipeline-User': 'not-trusted' },
    });
    expect(untrusted.status).toBe(401);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      {
        trustedHeader: 'X-Archon-User',
        legacySource: 'legacy-default',
        replacementEnv: 'PIPELINE_WEB_AUTH_HEADER',
      },
      'web_auth.legacy_identity_header_deprecated'
    );
    makeApp();
    expect(
      mockWarn.mock.calls.filter(
        call => call[1] === 'web_auth.legacy_identity_header_deprecated'
      )
    ).toHaveLength(1);
  });

  test('legacy default header authenticates and preserves attribution', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations', {
      // deprecated-compat: supported only for the reverse-proxy migration window.
      headers: { 'X-Archon-User': 'legacy-alice' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith(
      'web',
      'legacy-alice',
      'legacy-alice'
    );
  });

  test('explicit legacy configuration still rejects the canonical alternate header', async () => {
    apiGateEnabled = true;
    process.env.ARCHON_WEB_AUTH_HEADER = 'X-Archon-User';
    const res = await makeApp().request('/api/conversations', {
      headers: { 'X-Pipeline-User': 'not-trusted' },
    });
    expect(res.status).toBe(401);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      {
        trustedHeader: 'X-Archon-User',
        legacySource: 'ARCHON_WEB_AUTH_HEADER',
        replacementEnv: 'PIPELINE_WEB_AUTH_HEADER',
      },
      'web_auth.legacy_identity_header_deprecated'
    );
  });

  test('explicit canonical configuration rejects the legacy alternate but authenticates canonical', async () => {
    apiGateEnabled = true;
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    process.env.ARCHON_WEB_AUTH_HEADER = 'X-Archon-User';
    const app = makeApp();
    const untrusted = await app.request('/api/conversations', {
      headers: { 'X-Archon-User': 'not-trusted' },
    });
    expect(untrusted.status).toBe(401);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();

    const trusted = await app.request('/api/conversations', {
      headers: { 'X-Pipeline-User': 'canonical-user' },
    });
    expect(trusted.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith(
      'web',
      'canonical-user',
      'canonical-user'
    );
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'web_auth.legacy_identity_header_deprecated'
    );
  });

  test('trusted and alternate identity headers with conflicting values fail closed', async () => {
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    const res = await makeApp().request('/api/conversations', {
      headers: {
        'X-Pipeline-User': 'canonical-user',
        // deprecated-compat: supported only for the reverse-proxy migration window.
        'X-Archon-User': 'different-user',
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Conflicting web identity headers' });
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
  });

  // Fail-closed: a session lookup that throws (e.g. DB outage) with NO trusted
  // header must NOT admit the request. resolveAuthContext swallows the throw and
  // returns undefined, which the gate maps to 401 — never access-granted.
  test('gate on + session lookup throws + no header → 401 (fails closed)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });
});

describe('?mine filter — non-enforcing', () => {
  beforeEach(() => {
    authEnabled = false;
    signupMode = 'open';
    authInstance = null;
    mockListWorkflowRuns.mockClear();
    mockListConversations.mockClear();
    mockFindOrCreateUser.mockClear();
  });

  test('runs: no ?mine → listWorkflowRuns called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs');
    expect(res.status).toBe(200);
    const opts = mockListWorkflowRuns.mock.calls[0]?.[0];
    expect(opts?.userId).toBeUndefined();
  });

  test('runs: ?mine=true with X-Pipeline-User header → filters by resolved userId', async () => {
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Pipeline-User': 'alice' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'alice', 'alice');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-alice');
  });

  test('runs: ?mine=true with legacy identity header → preserves attribution', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      // deprecated-compat: supported only for the reverse-proxy migration window.
      headers: { 'X-Archon-User': 'legacy-owner' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith(
      'web',
      'legacy-owner',
      'legacy-owner'
    );
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-legacy-owner');
  });

  test('runs: ?mine=true with a Better Auth session → session wins over header', async () => {
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => ({ user: { id: 'sess-1', name: 'Sessioned', email: 's@x.io' } }),
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      // header present too — session must take precedence
      headers: { 'X-Pipeline-User': 'header-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'sess-1', 'Sessioned');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-sess-1');
  });

  test('conversations: no ?mine → listConversations called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations');
    expect(res.status).toBe(200);
    // listConversations(limit, platform, codebaseId, excludeEmpty, userId)
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  test('conversations: ?mine=true with X-Pipeline-User header → filters by userId', async () => {
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true', {
      headers: { 'X-Pipeline-User': 'bob' },
    });
    expect(res.status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[4]).toBe('user-from-bob');
  });

  // The headline guarantee of this PR: ?mine is non-enforcing. With no
  // resolvable identity (no session, no header) it must degrade to listing
  // everything — NOT to an empty/zero-result gate.
  test('runs: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBeUndefined();
  });

  test('conversations: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  // Resilience: a Better Auth session lookup that throws (e.g. DB outage) must
  // fall through to the trusted proxy header rather than dropping attribution.
  test('runs: ?mine=true — session lookup throws → falls through to header', async () => {
    process.env.PIPELINE_WEB_AUTH_HEADER = 'X-Pipeline-User';
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Pipeline-User': 'fallback-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'fallback-user', 'fallback-user');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-fallback-user');
  });
});
