/**
 * N-30 regression: a project sandbox must never adopt, reconfigure, or move the
 * ref of a repository it does not own.
 *
 * The incident these cover: `ensureProjectRepository` guarded only on
 * `<sandbox>/.git` existing plus `rev-parse --verify HEAD`, neither of which
 * proves the sandbox is the toplevel of its own repository. Run against a
 * sandbox that resolved inside a developer's checkout — or with a `GIT_DIR`
 * inherited from one — it wrote `user.name`/`user.email` into that checkout and
 * moved its branch ref to a fabricated commit.
 *
 * The second half covers the follow-up: a containment refusal for one *known*
 * project must reach the caller, not be swallowed by the request-scoping hook
 * into a silent redirect that lands the request — writes included — in the
 * default project.
 *
 * Every case builds real temporary repositories; nothing about Git is mocked.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import {
  createProjectRunSnapshot,
  ensureProjectExists,
  ensureProjectRepository,
  getProject,
  ProjectRepositoryContainmentError,
  resolvePaths,
} from "../src/projects.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

/** A scratch directory outside every project root, removed after each test. */
function makeTemporaryRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "kady-containment-")),
  );
  temporaryRoots.push(root);
  return root;
}

/**
 * Run git with an environment that cannot be steered by the developer's own
 * config or by variables this test suite inherited.
 */
function git(workingDirectory: string, args: string[]): string {
  return execFileSync("git", ["-C", workingDirectory, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Outer Developer",
      GIT_AUTHOR_EMAIL: "outer@example.test",
      GIT_COMMITTER_NAME: "Outer Developer",
      GIT_COMMITTER_EMAIL: "outer@example.test",
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOrNull(workingDirectory: string, args: string[]): string | null {
  try {
    return git(workingDirectory, args);
  } catch {
    return null;
  }
}

/** A repository with a configured identity, one tracked file, and one commit. */
function makeCheckoutWithHistory(root: string, name: string): string {
  const checkout = path.join(root, name);
  fs.mkdirSync(checkout, { recursive: true });
  // Name the branch explicitly: the fixtures assert on it, and the default
  // branch name is a global-config setting these tests deliberately ignore.
  git(checkout, ["init", "--quiet", "-b", "main", "."]);
  git(checkout, ["config", "user.name", "Outer Developer"]);
  git(checkout, ["config", "user.email", "outer@example.test"]);
  fs.writeFileSync(path.join(checkout, "tracked.txt"), "real work\n", "utf-8");
  git(checkout, ["add", "tracked.txt"]);
  git(checkout, ["commit", "--quiet", "-m", "real commit"]);
  return checkout;
}

interface CheckoutFingerprint {
  userName: string | null;
  userEmail: string | null;
  head: string | null;
  commitCount: string | null;
  configBytes: string;
}

/** Everything the incident changed, captured byte-for-byte. */
function fingerprintCheckout(checkout: string): CheckoutFingerprint {
  return {
    userName: gitOrNull(checkout, ["config", "--local", "user.name"]),
    userEmail: gitOrNull(checkout, ["config", "--local", "user.email"]),
    head: gitOrNull(checkout, ["rev-parse", "HEAD"]),
    commitCount: gitOrNull(checkout, ["rev-list", "--count", "HEAD"]),
    configBytes: fs.readFileSync(path.join(checkout, ".git", "config"), "utf-8"),
  };
}

function makeSandboxWithFile(sandbox: string): void {
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "AGENTS.md"), "# sandbox\n", "utf-8");
}

describe("project repository containment", () => {
  it("refuses a sandbox nested inside a checkout that has tracked files and commits", () => {
    const root = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(root, "sds-lane-w1");
    const sandbox = path.join(checkout, "projects", "default", "sandbox");
    makeSandboxWithFile(sandbox);
    const before = fingerprintCheckout(checkout);

    let thrown: unknown;
    try {
      ensureProjectRepository(sandbox);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    const containmentError = thrown as ProjectRepositoryContainmentError;
    expect(containmentError.invariant).toBe("sandbox_inside_tracked_repository");
    expect(containmentError.sandbox).toBe(sandbox);
    expect(containmentError.offendingToplevel).toBe(checkout);
    expect(containmentError.message).toContain(sandbox);
    expect(containmentError.message).toContain(checkout);

    // The developer's checkout is byte-identical: identity, ref, history.
    expect(fingerprintCheckout(checkout)).toEqual(before);
    expect(before.head).not.toBeNull();
    expect(before.commitCount).toBe("1");
    // Nothing was committed and no repository was planted in the sandbox.
    expect(git(checkout, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(fs.existsSync(path.join(sandbox, ".git"))).toBe(false);
    // The refusal happens before the lock is taken, so no lock file is left
    // behind inside the checkout either.
    expect(
      fs.existsSync(path.join(path.dirname(sandbox), ".git-init.lock")),
    ).toBe(false);
  });

  it("refuses a sandbox whose .git is a linked-worktree pointer file", () => {
    const root = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(root, "main-checkout");
    const sandbox = path.join(root, "linked-worktree");
    git(checkout, ["worktree", "add", "--quiet", sandbox, "-b", "sandbox-branch"]);
    expect(fs.lstatSync(path.join(sandbox, ".git")).isFile()).toBe(true);
    const before = fingerprintCheckout(checkout);
    const sandboxHeadBefore = git(sandbox, ["rev-parse", "HEAD"]);

    let thrown: unknown;
    try {
      ensureProjectRepository(sandbox);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    const containmentError = thrown as ProjectRepositoryContainmentError;
    expect(containmentError.invariant).toBe("sandbox_git_is_a_pointer_file");
    expect(containmentError.sandbox).toBe(sandbox);
    expect(containmentError.offendingToplevel).toBe(checkout);

    expect(fingerprintCheckout(checkout)).toEqual(before);
    expect(git(sandbox, ["rev-parse", "HEAD"])).toBe(sandboxHeadBefore);
    expect(gitOrNull(sandbox, ["config", "--local", "user.name"])).toBe(
      "Outer Developer",
    );
  });

  it("leaves the ref and identity of a sandbox repository that already has commits", () => {
    const root = makeTemporaryRoot();
    const sandbox = makeCheckoutWithHistory(root, "sandbox-with-history");
    const before = fingerprintCheckout(sandbox);

    ensureProjectRepository(sandbox);

    expect(fingerprintCheckout(sandbox)).toEqual(before);
    expect(git(sandbox, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("real commit");
  });

  it("leaves a sandbox repository whose history sits on a branch its unborn HEAD does not name", () => {
    // A repository can hold every one of its commits while `rev-parse HEAD`
    // fails — checking out an orphan branch is enough. "HEAD does not resolve"
    // is therefore not proof that a repository is empty, and treating it as
    // proof rewrites the identity and plants a commit in someone's repository.
    const root = makeTemporaryRoot();
    const sandbox = makeCheckoutWithHistory(root, "orphan-head-sandbox");
    const historyHead = git(sandbox, ["rev-parse", "HEAD"]);
    git(sandbox, ["checkout", "--quiet", "--orphan", "fresh-start"]);
    expect(gitOrNull(sandbox, ["rev-parse", "--verify", "HEAD"])).toBeNull();
    const before = fingerprintCheckout(sandbox);

    ensureProjectRepository(sandbox);

    expect(fingerprintCheckout(sandbox)).toEqual(before);
    expect(gitOrNull(sandbox, ["rev-parse", "--verify", "HEAD"])).toBeNull();
    expect(git(sandbox, ["rev-parse", "refs/heads/main"])).toBe(historyHead);
    expect(git(sandbox, ["config", "--local", "user.name"])).toBe(
      "Outer Developer",
    );
    expect(git(sandbox, ["config", "--local", "user.email"])).toBe(
      "outer@example.test",
    );
  });

  it("gives a sandbox that owns an initialised but commitless repository its baseline commit", () => {
    const root = makeTemporaryRoot();
    const sandbox = path.join(root, "commitless-sandbox");
    makeSandboxWithFile(sandbox);
    git(sandbox, ["init", "--quiet", "."]);
    git(sandbox, ["config", "user.name", "Sandbox Owner"]);
    git(sandbox, ["config", "user.email", "owner@example.test"]);
    expect(gitOrNull(sandbox, ["rev-parse", "--verify", "HEAD"])).toBeNull();

    ensureProjectRepository(sandbox);

    expect(git(sandbox, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
    expect(git(sandbox, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("AGENTS.md");
    // A repository this call did not create keeps the identity it came with.
    expect(git(sandbox, ["config", "--local", "user.name"])).toBe("Sandbox Owner");
    expect(git(sandbox, ["config", "--local", "user.email"])).toBe(
      "owner@example.test",
    );
  });

  it("initialises a fresh empty sandbox directory unchanged", () => {
    const root = makeTemporaryRoot();
    const sandbox = path.join(root, "project", "sandbox");
    makeSandboxWithFile(sandbox);
    fs.mkdirSync(path.join(sandbox, ".kady"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, ".env"), "SECRET=1\n", "utf-8");

    ensureProjectRepository(sandbox);

    expect(fs.lstatSync(path.join(sandbox, ".git")).isDirectory()).toBe(true);
    expect(git(sandbox, ["rev-parse", "--show-toplevel"])).toBe(sandbox);
    expect(git(sandbox, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
    expect(git(sandbox, ["log", "-1", "--format=%an <%ae>"])).toBe(
      "Kady <kady@localhost>",
    );
    // A repository this call created is the only one it gives an identity to.
    expect(git(sandbox, ["config", "--local", "user.name"])).toBe("Kady");
    expect(git(sandbox, ["config", "--local", "user.email"])).toBe("kady@localhost");
    // The privacy-safe path list is unchanged: dotfiles and credentials stay out.
    expect(git(sandbox, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("AGENTS.md");
    // Idempotent: a second call must not add a commit or move the ref.
    const head = git(sandbox, ["rev-parse", "HEAD"]);
    ensureProjectRepository(sandbox);
    expect(git(sandbox, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(sandbox, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("ignores a GIT_DIR inherited from a real checkout instead of writing into it", () => {
    const root = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(root, "inherited-checkout");
    const sandbox = path.join(root, "project", "sandbox");
    makeSandboxWithFile(sandbox);
    const before = fingerprintCheckout(checkout);

    const inheritedGitDir = process.env.GIT_DIR;
    const inheritedWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = path.join(checkout, ".git");
    process.env.GIT_WORK_TREE = checkout;
    try {
      ensureProjectRepository(sandbox);
    } finally {
      if (inheritedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inheritedGitDir;
      if (inheritedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = inheritedWorkTree;
    }

    // The checkout named by the inherited variables is untouched...
    expect(fingerprintCheckout(checkout)).toEqual(before);
    expect(git(checkout, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(checkout, ["log", "-1", "--format=%s"])).toBe("real commit");
    // ...and the sandbox got its own repository anyway.
    expect(git(sandbox, ["rev-parse", "--show-toplevel"])).toBe(sandbox);
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
  });
});

/**
 * A project whose sandbox violates containment, registered so the scope hook
 * treats it as a known project. `createProject` cannot build this fixture: it
 * calls `ensureProjectRepository` itself and would refuse before the request
 * under test ever runs.
 */
function registerProjectWithoutRepository(
  projectId: string,
  name: string,
): ReturnType<typeof resolvePaths> {
  const paths = resolvePaths(projectId);
  fs.mkdirSync(paths.root, { recursive: true });
  const timestamp = "2026-08-18T00:00:00.000Z";
  fs.writeFileSync(
    paths.projectJson,
    JSON.stringify(
      {
        id: projectId,
        name,
        description: "",
        tags: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        archived: false,
        spendLimitUsd: null,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  return paths;
}

/**
 * Replace a project's sandbox with a linked worktree of somebody else's
 * checkout: the exact arrangement whose `.git` is a pointer file rather than a
 * repository the sandbox owns.
 */
function makeSandboxALinkedWorktree(
  sandbox: string,
  checkout: string,
  branch: string,
): void {
  fs.rmSync(sandbox, { recursive: true, force: true });
  git(checkout, ["worktree", "add", "--quiet", sandbox, "-b", branch]);
  expect(fs.lstatSync(path.join(sandbox, ".git")).isFile()).toBe(true);
}

const LEAKED_FILE = "leaked-write.txt";

describe("request scoping refuses a containment violation instead of redirecting", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  });

  it("does not land a write addressed to a contained-violating project in the healthy default project", async () => {
    // A healthy default project, exactly as a running backend would have it.
    const defaultSandbox = ensureProjectExists(DEFAULT_PROJECT_ID).sandbox;
    expect(git(defaultSandbox, ["rev-parse", "--show-toplevel"])).toBe(
      fs.realpathSync(defaultSandbox),
    );

    // ...and one specifically-named project whose sandbox belongs to somebody
    // else's checkout. The caller addresses *this* project.
    const outerRoot = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(outerRoot, "operator-checkout");
    const poisoned = registerProjectWithoutRepository("worktree-study", "Worktree study");
    makeSandboxALinkedWorktree(poisoned.sandbox, checkout, "study-branch");
    expect(getProject("worktree-study")).not.toBeNull();
    const checkoutBefore = fingerprintCheckout(checkout);

    const response = await app.inject({
      method: "PUT",
      url: `/sandbox/file?path=${LEAKED_FILE}`,
      headers: {
        "x-project-id": "worktree-study",
        "content-type": "application/octet-stream",
      },
      payload: "written for worktree-study\n",
    });

    // The point of the regression: the write must not appear in the default
    // project's sandbox on disk. Asserted before the status code, because the
    // misroute answered 200 while depositing the file here.
    expect(fs.existsSync(path.join(defaultSandbox, LEAKED_FILE))).toBe(false);
    // Nor anywhere else: the refusal happens before the handler runs.
    expect(fs.existsSync(path.join(poisoned.sandbox, LEAKED_FILE))).toBe(false);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      reason: "project_repository_containment",
      invariant: "sandbox_git_is_a_pointer_file",
    });
    // The refusal is attributable: it names the sandbox and the repository at
    // risk, so an operator can find the misconfigured projects root.
    expect(String(response.json().detail)).toContain(fs.realpathSync(poisoned.sandbox));
    expect(String(response.json().detail)).toContain(checkout);
    // A silent redirect is not a fallback: no fallback header is offered.
    expect(response.headers["x-project-fallback"]).toBeUndefined();

    // The operator's checkout is byte-identical across the refused request.
    expect(fingerprintCheckout(checkout)).toEqual(checkoutBefore);
  });

  it("refuses a read addressed to a contained-violating project rather than serving the default project's files", async () => {
    const defaultSandbox = ensureProjectExists(DEFAULT_PROJECT_ID).sandbox;
    fs.writeFileSync(
      path.join(defaultSandbox, "default-only.txt"),
      "belongs to the default project\n",
      "utf-8",
    );
    const outerRoot = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(outerRoot, "operator-checkout");
    const poisoned = registerProjectWithoutRepository("worktree-study", "Worktree study");
    makeSandboxALinkedWorktree(poisoned.sandbox, checkout, "study-branch");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: { "x-project-id": "worktree-study" },
    });

    // Asserted before the status code: the redirect answered 200 while handing
    // this caller the *default* project's file listing.
    expect(response.body).not.toContain("default-only.txt");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      reason: "project_repository_containment",
    });
    expect(response.headers["x-project-fallback"]).toBeUndefined();
  });

  it("refuses rather than redirects when the default project itself violates containment", async () => {
    const defaultSandbox = ensureProjectExists(DEFAULT_PROJECT_ID).sandbox;
    const outerRoot = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(outerRoot, "operator-checkout");
    makeSandboxALinkedWorktree(defaultSandbox, checkout, "default-branch");

    const response = await app.inject({
      method: "PUT",
      url: `/sandbox/file?path=${LEAKED_FILE}`,
      headers: { "content-type": "application/octet-stream" },
      payload: "written for the default project\n",
    });

    expect(fs.existsSync(path.join(defaultSandbox, LEAKED_FILE))).toBe(false);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      reason: "project_repository_containment",
      invariant: "sandbox_git_is_a_pointer_file",
    });
  });

  it("serves a healthy second project's write into that project's own sandbox", async () => {
    // The refusal must be specific to the violating project: a well-formed
    // project alongside it keeps working.
    ensureProjectExists(DEFAULT_PROJECT_ID);
    const healthy = ensureProjectExists("healthy-study");

    const response = await app.inject({
      method: "PUT",
      url: `/sandbox/file?path=${LEAKED_FILE}`,
      headers: {
        "x-project-id": "healthy-study",
        "content-type": "application/octet-stream",
      },
      payload: "written for healthy-study\n",
    });

    expect(response.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(healthy.sandbox, LEAKED_FILE), "utf-8")).toBe(
      "written for healthy-study\n",
    );
    expect(
      fs.existsSync(path.join(resolvePaths(DEFAULT_PROJECT_ID).sandbox, LEAKED_FILE)),
    ).toBe(false);
  });

  it("keeps the default-project fallback for a scoping failure that is not a containment refusal", async () => {
    // An id that cannot resolve to a path at all fails inside `getProject`
    // with a plain Error. That path is unchanged: reads still degrade to the
    // default project rather than failing the request.
    ensureProjectExists(DEFAULT_PROJECT_ID);

    const response = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { "x-project-id": "../escape" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeInstanceOf(Array);
  });
});

describe("project commits carry their own authoring identity", () => {
  afterAll(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  });

  it("authors a run snapshot as Kady in a sandbox-owned repository that has no identity of its own", () => {
    // The awkward case: the sandbox owns its repository, so nothing here may
    // write `user.name`/`user.email` into it — but it arrived with neither, so
    // there is no configured identity for `commit-tree` to fall back to. The
    // identity has to be supplied per-invocation or the host's own Git identity
    // ends up signing project history.
    const paths = resolvePaths("identityless-study");
    fs.mkdirSync(paths.sandbox, { recursive: true });
    git(paths.sandbox, ["init", "--quiet", "."]);
    expect(gitOrNull(paths.sandbox, ["config", "--local", "user.name"])).toBeNull();

    ensureProjectExists("identityless-study");
    // Its baseline commit already had this fixed for it in round 14...
    expect(git(paths.sandbox, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Kady <kady@localhost>|Kady <kady@localhost>",
    );

    // ...now prove the snapshot does too, with a host identity in the ambient
    // environment that a fallback would otherwise pick up.
    const inherited = {
      authorName: process.env.GIT_AUTHOR_NAME,
      authorEmail: process.env.GIT_AUTHOR_EMAIL,
      committerName: process.env.GIT_COMMITTER_NAME,
      committerEmail: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_AUTHOR_NAME = "Host Developer";
    process.env.GIT_AUTHOR_EMAIL = "host@example.test";
    process.env.GIT_COMMITTER_NAME = "Host Developer";
    process.env.GIT_COMMITTER_EMAIL = "host@example.test";
    let snapshot: string;
    try {
      snapshot = createProjectRunSnapshot("identityless-study", "run-identity-check");
    } finally {
      for (const [key, value] of [
        ["GIT_AUTHOR_NAME", inherited.authorName],
        ["GIT_AUTHOR_EMAIL", inherited.authorEmail],
        ["GIT_COMMITTER_NAME", inherited.committerName],
        ["GIT_COMMITTER_EMAIL", inherited.committerEmail],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(
      git(paths.sandbox, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", snapshot]),
    ).toBe("Kady <kady@localhost>|Kady <kady@localhost>");
    // The sandbox's repository still has no identity written into it: the
    // commits carry theirs, the repository is left as it was found.
    expect(gitOrNull(paths.sandbox, ["config", "--local", "user.name"])).toBeNull();
    expect(gitOrNull(paths.sandbox, ["config", "--local", "user.email"])).toBeNull();
  });
});
