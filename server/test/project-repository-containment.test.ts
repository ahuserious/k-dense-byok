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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import {
  createProjectRunSnapshot,
  ensureProjectExists,
  ensureProjectRepository,
  getProject,
  GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK,
  PROJECT_GIT_SUBCOMMANDS,
  projectGitEnvironment,
  ProjectRepositoryContainmentError,
  RELOCATING_GIT_ENVIRONMENT_KEYS,
  resolvePaths,
} from "../src/projects.ts";

const PROJECTS_MODULE_PATH = fileURLToPath(new URL("../src/projects.ts", import.meta.url));
const TSX_BINARY = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/**
 * Run a script against the real module in a child process with a doctored
 * `PATH`. The interesting failures here are at the process boundary — which
 * argv Git is handed, and what happens when Git itself misbehaves — and neither
 * is observable from inside the test process.
 */
function runInChildProcess(
  root: string,
  source: string,
  environment: Record<string, string>,
): string {
  const scriptPath = path.join(root, `child-${crypto.randomUUID()}.mts`);
  fs.writeFileSync(scriptPath, source, "utf-8");
  return execFileSync(TSX_BINARY, [scriptPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
    timeout: 120_000,
  });
}

/**
 * A directory holding a `git` that runs `body` and then hands off to the real
 * Git, placed at the front of a child process's PATH.
 */
function makeGitShim(root: string, body: string): string {
  const directory = path.join(root, "shim-bin");
  fs.mkdirSync(directory, { recursive: true });
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf-8",
  }).trim();
  fs.writeFileSync(
    path.join(directory, "git"),
    `#!/bin/sh\n${body}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return directory;
}

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

  it("ignores a GIT_CONFIG inherited from a real checkout instead of rewriting its identity", () => {
    // The second half of the incident, and the one a hand-written scrub list
    // missed: `git config <key> <value>` honours GIT_CONFIG and writes to the
    // file it names, while no other git command reads it — so ownership is
    // proven correctly for the sandbox and the identity write lands in the
    // developer's checkout anyway.
    const root = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(root, "inherited-config-checkout");
    const sandbox = path.join(root, "project", "sandbox");
    makeSandboxWithFile(sandbox);
    const before = fingerprintCheckout(checkout);

    const inheritedGitConfig = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = path.join(checkout, ".git", "config");
    try {
      ensureProjectRepository(sandbox);
    } finally {
      if (inheritedGitConfig === undefined) delete process.env.GIT_CONFIG;
      else process.env.GIT_CONFIG = inheritedGitConfig;
    }

    // The checkout's config is byte-identical: no Kady identity written into it.
    expect(fingerprintCheckout(checkout)).toEqual(before);
    expect(git(checkout, ["config", "--local", "user.name"])).toBe("Outer Developer");
    expect(git(checkout, ["config", "--local", "user.email"])).toBe(
      "outer@example.test",
    );
    // ...and the identity landed where it belongs, in the sandbox's own
    // repository, rather than being diverted out of it.
    expect(git(sandbox, ["config", "--local", "user.name"])).toBe("Kady");
    expect(git(sandbox, ["config", "--local", "user.email"])).toBe("kady@localhost");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
  });

  it("scrubs every environment variable git itself names as repository-local", () => {
    // The list is derived from `git rev-parse --local-env-vars` rather than
    // maintained by hand, because maintaining it by hand is how both halves of
    // the incident happened. This fails if the installed git names a variable
    // the static fallback does not — the fallback is what runs when that
    // invocation cannot, so it going stale silently reopens the hole.
    const named = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(named.length).toBeGreaterThan(0);
    expect(named).toContain("GIT_CONFIG");
    for (const key of named) {
      // The rule is a prefix. This is the one thing that could make a prefix
      // insufficient: a repository-binding variable git names that is not
      // called GIT_something.
      expect(key.startsWith("GIT_")).toBe(true);
      expect(RELOCATING_GIT_ENVIRONMENT_KEYS).toContain(key);
      expect(GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK).toContain(key);
    }
    // Discovery-steering variables are not on git's list and still have to go.
    expect(RELOCATING_GIT_ENVIRONMENT_KEYS).toContain("GIT_CEILING_DIRECTORIES");
    expect(RELOCATING_GIT_ENVIRONMENT_KEYS).toContain("GIT_NAMESPACE");
  });

  it("ignores inherited config injected through GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT", () => {
    // Both carry arbitrary settings into every git invocation. `init.defaultBranch`
    // is the observable one: it changes what `git init` writes to HEAD, so a
    // leaked setting is visible in the sandbox's own repository afterwards.
    const root = makeTemporaryRoot();
    const sandbox = path.join(root, "project", "sandbox");
    makeSandboxWithFile(sandbox);

    const injected: Record<string, string | undefined> = {
      GIT_CONFIG_PARAMETERS: "'init.defaultBranch=injected-parameters'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "injected-count",
    };
    const inherited: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(injected)) {
      inherited[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      ensureProjectRepository(sandbox);
    } finally {
      for (const key of Object.keys(injected)) {
        if (inherited[key] === undefined) delete process.env[key];
        else process.env[key] = inherited[key];
      }
    }

    // Whatever this host's default branch is, it is not one the environment
    // dictated. (The name itself is a global-config setting these tests refuse
    // to depend on, so only the injected values are ruled out.)
    const sandboxHead = git(sandbox, ["symbolic-ref", "HEAD"]);
    expect(sandboxHead).not.toBe("refs/heads/injected-parameters");
    expect(sandboxHead).not.toBe("refs/heads/injected-count");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
  });

  it("refuses a sandbox whose .git directory borrows another repository's refs", () => {
    // A `.git` DIRECTORY holding a `commondir` file is a repository whose refs
    // and objects live somewhere else, and `--show-toplevel` still answers "the
    // sandbox" — the same illusion an inherited GIT_DIR creates, one layout
    // over. With no refs of its own yet, the victim reads as an empty
    // repository, so nothing downstream stops the write.
    const root = makeTemporaryRoot();
    const victim = path.join(root, "victim-fresh");
    fs.mkdirSync(victim, { recursive: true });
    git(victim, ["init", "--quiet", "-b", "main", "."]);
    const refsBefore = git(victim, ["for-each-ref", "--format=%(refname)"]);
    expect(refsBefore).toBe("");

    const sandbox = path.join(root, "borrowing-sandbox");
    const sandboxGit = path.join(sandbox, ".git");
    makeSandboxWithFile(sandbox);
    fs.mkdirSync(sandboxGit, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxGit, "commondir"),
      path.join(victim, ".git") + "\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(sandboxGit, "HEAD"), "ref: refs/heads/kady-sandbox\n", "utf-8");
    fs.writeFileSync(path.join(sandboxGit, "gitdir"), sandbox + "\n", "utf-8");
    // The layout the old check walked past: a directory, and a toplevel that
    // answers "the sandbox".
    expect(fs.lstatSync(sandboxGit).isDirectory()).toBe(true);
    expect(git(sandbox, ["rev-parse", "--show-toplevel"])).toBe(sandbox);

    let thrown: unknown;
    try {
      ensureProjectRepository(sandbox);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    const containmentError = thrown as ProjectRepositoryContainmentError;
    expect(containmentError.invariant).toBe("sandbox_git_common_dir_is_foreign");
    expect(containmentError.offendingToplevel).toBe(victim);
    // No branch and no objects were planted in the repository next door.
    expect(git(victim, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });

  it("re-proves ownership when the .git directory it proved is changed underneath it", () => {
    // Ownership is proven on every call, never remembered: a repository that
    // stops being the sandbox's own between one request and the next is caught
    // on the next one. This shape — a `commondir` file appearing in a `.git`
    // that was already proven — is the cheap half of that; the in-place
    // `.git/config` rewrite below is the half a cache cannot see.
    const root = makeTemporaryRoot();
    const sandbox = path.join(root, "proved-sandbox");
    makeSandboxWithFile(sandbox);
    ensureProjectRepository(sandbox);
    // Prove it twice: the second call is the one that records the memo.
    ensureProjectRepository(sandbox);
    ensureProjectRepository(sandbox);

    // A `commondir` written into the very directory that was proven — the same
    // path, the same inode, nothing a path-keyed cache would notice.
    const victim = makeCheckoutWithHistory(root, "commondir-victim");
    fs.writeFileSync(
      path.join(sandbox, ".git", "commondir"),
      path.join(victim, ".git") + "\n",
      "utf-8",
    );
    const victimBefore = fingerprintCheckout(victim);

    let thrown: unknown;
    try {
      ensureProjectRepository(sandbox);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    expect((thrown as ProjectRepositoryContainmentError).invariant).toBe(
      "sandbox_git_common_dir_is_foreign",
    );
    expect(fingerprintCheckout(victim)).toEqual(victimBefore);
  });

  it("refuses a sandbox whose repository was repointed by an in-place rewrite of its own .git/config", () => {
    // Round 16 cached the proven verdict against five `stat` fields of
    // `<sandbox>/.git`. A directory's mtime/ctime/size move when an entry is
    // created, removed or renamed — not when a file already inside it is
    // overwritten in place — and `.git/config` always exists after `git init`.
    // Two ordinary writes from inside the sandbox therefore changed what the
    // proof would answer while leaving the fingerprint identical, and the stale
    // "owned" verdict read a foreign checkout's file contents into a snapshot.
    const root = makeTemporaryRoot();
    const victim = makeCheckoutWithHistory(root, "repointed-victim");
    fs.writeFileSync(path.join(victim, "AGENTS.md"), "victim agents\n", "utf-8");
    git(victim, ["add", "AGENTS.md"]);
    git(victim, ["commit", "--quiet", "-m", "victim content"]);

    const sandbox = path.join(root, "repointed-sandbox");
    makeSandboxWithFile(sandbox);
    // Prove it repeatedly first: whatever a cache would have recorded, it is
    // recorded by now.
    ensureProjectRepository(sandbox);
    ensureProjectRepository(sandbox);
    ensureProjectRepository(sandbox);

    const fingerprint = (): string => {
      const sandboxEntry = fs.lstatSync(sandbox);
      const gitEntry = fs.lstatSync(path.join(sandbox, ".git"));
      return [
        sandboxEntry.dev, sandboxEntry.ino, gitEntry.dev, gitEntry.ino,
        gitEntry.size, gitEntry.mtimeMs, gitEntry.ctimeMs,
      ].join(":");
    };
    const before = fingerprint();

    const configPath = path.join(sandbox, ".git", "config");
    const repointed = fs
      .readFileSync(configPath, "utf-8")
      .replace(/\[core\]\n/, `[core]\n\tworktree = ${victim}\n`);
    const descriptor = fs.openSync(configPath, "r+");
    fs.writeSync(descriptor, repointed, 0, "utf-8");
    fs.ftruncateSync(descriptor, Buffer.byteLength(repointed));
    fs.closeSync(descriptor);

    // The mutation is invisible to any fingerprint of the directory itself...
    expect(fingerprint()).toBe(before);
    // ...and it really did repoint the repository.
    expect(git(sandbox, ["rev-parse", "--show-toplevel"])).toBe(victim);

    let thrown: unknown;
    try {
      ensureProjectRepository(sandbox);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    expect((thrown as ProjectRepositoryContainmentError).invariant).toBe(
      "sandbox_is_not_repository_toplevel",
    );
  });
});

describe("ensureProjectExists refuses before it creates anything", () => {
  afterEach(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  });

  it("writes no skeleton and no seed files when the projects root is inside a checkout", () => {
    // `ensureProjectRepository` refuses, but its caller had already run
    // mkdir → mkdir → mkdir → seedSandboxFiles by the time it was reached, so
    // a refusal deposited three untracked files in the developer's checkout —
    // and, because the scope hook re-runs on every request, kept depositing
    // them. The inspection has to happen above the first mkdir.
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    git(PROJECTS_ROOT, ["init", "--quiet", "-b", "main", "."]);
    git(PROJECTS_ROOT, ["config", "user.name", "Outer Developer"]);
    git(PROJECTS_ROOT, ["config", "user.email", "outer@example.test"]);
    fs.writeFileSync(path.join(PROJECTS_ROOT, "tracked.txt"), "real work\n", "utf-8");
    git(PROJECTS_ROOT, ["add", "tracked.txt"]);
    git(PROJECTS_ROOT, ["commit", "--quiet", "-m", "real commit"]);
    expect(git(PROJECTS_ROOT, ["status", "--porcelain", "-uall"])).toBe("");

    let thrown: unknown;
    try {
      ensureProjectExists("nested-study");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProjectRepositoryContainmentError);
    expect((thrown as ProjectRepositoryContainmentError).invariant).toBe(
      "sandbox_inside_tracked_repository",
    );
    // Nothing at all in the checkout: not the project root, not the sandbox,
    // not the seed files, not a stray lock.
    expect(git(PROJECTS_ROOT, ["status", "--porcelain", "-uall"])).toBe("");
    expect(fs.existsSync(resolvePaths("nested-study").root)).toBe(false);
    // ...and it stays that way however many requests arrive.
    expect(() => ensureProjectExists("nested-study")).toThrow(
      ProjectRepositoryContainmentError,
    );
    expect(git(PROJECTS_ROOT, ["status", "--porcelain", "-uall"])).toBe("");
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

  it("offers no fallback header on a refusal reached through an unknown project id", async () => {
    // An unknown id on a GET sets X-Project-Fallback and *then* falls back to
    // the default project — which is the project that refuses. A client reading
    // the header off the 500 would conclude it had been served from the default
    // project when it had been served nothing.
    const defaultSandbox = ensureProjectExists(DEFAULT_PROJECT_ID).sandbox;
    const outerRoot = makeTemporaryRoot();
    const checkout = makeCheckoutWithHistory(outerRoot, "operator-checkout");
    makeSandboxALinkedWorktree(defaultSandbox, checkout, "default-branch");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: { "x-project-id": "no-such-project" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      reason: "project_repository_containment",
    });
    expect(response.headers["x-project-fallback"]).toBeUndefined();
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

/**
 * N-30 follow-up: the sandbox owns its repository, and that is exactly the
 * problem. `<sandbox>/.git` is inside the sandbox, and the agent runs with
 * `cwd` set to the sandbox — so the repository's config, its `.git/hooks`
 * directory, its `.git/info/attributes` and its in-tree `.gitattributes` are
 * all writable by whatever runs in it, and Git executes what they name, as the
 * server. A containment proof cannot catch this: nothing about the ownership is
 * wrong. It reproduced both halves of the 2026-08-17 incident against the
 * hardened build.
 */
describe("git runs no code the project sandbox supplied", () => {
  afterAll(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  });

  /** A script that records that it ran and then rewrites the victim checkout. */
  function writeIncidentPayload(scriptPath: string, marker: string, victim: string): void {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        `echo executed >> ${JSON.stringify(marker)}`,
        `git -C ${JSON.stringify(victim)} config user.name Kady`,
        `git -C ${JSON.stringify(victim)} config user.email kady@localhost`,
        `fabricated=$(git -C ${JSON.stringify(victim)} commit-tree ` +
          `$(git -C ${JSON.stringify(victim)} hash-object -t tree /dev/null) -m fabricated)`,
        `git -C ${JSON.stringify(victim)} update-ref refs/heads/main "$fabricated"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  it("runs no hook the sandbox's own repository installs or relocates", () => {
    const root = makeTemporaryRoot();
    const victim = makeCheckoutWithHistory(root, "hook-victim");
    const before = fingerprintCheckout(victim);
    const sandbox = ensureProjectExists("hooked-study").sandbox;

    // Both hook locations, because relocating is only half of it: the default
    // `<sandbox>/.git/hooks` is as writable as any config key.
    const defaultHookMarker = path.join(root, "default-hook-ran.txt");
    writeIncidentPayload(
      path.join(sandbox, ".git", "hooks", "reference-transaction"),
      defaultHookMarker,
      victim,
    );
    const relocatedHookMarker = path.join(root, "relocated-hook-ran.txt");
    writeIncidentPayload(
      path.join(sandbox, ".kady-hooks", "reference-transaction"),
      relocatedHookMarker,
      victim,
    );
    // ...and `core.fsmonitor`, the other key that executes during this
    // module's invocation set.
    const fsmonitorMarker = path.join(root, "fsmonitor-ran.txt");
    writeIncidentPayload(path.join(sandbox, "fsmonitor.sh"), fsmonitorMarker, victim);
    fs.appendFileSync(
      path.join(sandbox, ".git", "config"),
      `[core]\n\thooksPath = ${path.join(sandbox, ".kady-hooks")}\n` +
        `\tfsmonitor = ${path.join(sandbox, "fsmonitor.sh")}\n`,
      "utf-8",
    );

    const snapshot = createProjectRunSnapshot("hooked-study", "hook-run");

    expect(fs.existsSync(defaultHookMarker)).toBe(false);
    expect(fs.existsSync(relocatedHookMarker)).toBe(false);
    expect(fs.existsSync(fsmonitorMarker)).toBe(false);
    // Both halves of the incident, asserted on the checkout itself.
    expect(fingerprintCheckout(victim)).toEqual(before);
    expect(git(victim, ["config", "--local", "user.name"])).toBe("Outer Developer");
    expect(git(victim, ["rev-parse", "refs/heads/main"])).toBe(before.head);
    // The snapshot itself still worked.
    expect(git(sandbox, ["ls-tree", "-r", "--name-only", snapshot])).toContain("AGENTS.md");
  });

  it("runs no clean filter the sandbox's own repository configures, from either attribute source", () => {
    // `filter.<driver>.clean` is the same class as `core.hooksPath` and cannot
    // be answered the same way: the driver name is the attacker's, so there is
    // no fixed key for `-c` to override. The staging path has to not consult
    // the attribute stack at all.
    for (const attributeSource of ["gitattributes", "info-attributes"] as const) {
      fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
      fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
      const root = makeTemporaryRoot();
      const projectId = `filtered-${attributeSource}`;
      const sandbox = ensureProjectExists(projectId).sandbox;

      const marker = path.join(root, "filter-ran.txt");
      const payload = path.join(sandbox, "payload.sh");
      fs.writeFileSync(
        payload,
        `#!/bin/sh\necho executed >> ${JSON.stringify(marker)}\nexit 0\n`,
        { mode: 0o755 },
      );
      fs.appendFileSync(
        path.join(sandbox, ".git", "config"),
        `[filter "evil"]\n\tclean = ${payload}\n`,
        "utf-8",
      );
      const attributes = "* filter=evil\n";
      if (attributeSource === "gitattributes") {
        fs.writeFileSync(path.join(sandbox, ".gitattributes"), attributes, "utf-8");
      } else {
        fs.mkdirSync(path.join(sandbox, ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(sandbox, ".git", "info", "attributes"), attributes, "utf-8");
      }
      fs.writeFileSync(path.join(sandbox, "AGENTS.md"), "# real sandbox content\n", "utf-8");

      const snapshot = createProjectRunSnapshot(projectId, `filter-run-${attributeSource}`);

      expect(fs.existsSync(marker)).toBe(false);
      // A clean filter that ran would have replaced the content with nothing.
      expect(git(sandbox, ["show", `${snapshot}:AGENTS.md`])).toBe("# real sandbox content");
    }
  });

  it("stages executable bits, symlinks and awkward names the way git add did", () => {
    // The staging path stopped using `git add`, so the tree it produces has to
    // be the same tree for everything a sandbox can legitimately contain.
    const sandbox = ensureProjectExists("staging-study").sandbox;
    fs.writeFileSync(path.join(sandbox, "script.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.writeFileSync(path.join(sandbox, "plain.txt"), "plain\n", "utf-8");
    fs.writeFileSync(path.join(sandbox, "awkward\nname.txt"), "awkward\n", "utf-8");
    fs.mkdirSync(path.join(sandbox, "nested"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "nested", "deep.txt"), "deep\n", "utf-8");
    fs.symlinkSync("plain.txt", path.join(sandbox, "link.txt"));

    const snapshot = createProjectRunSnapshot("staging-study", "staging-run");
    const entries = git(sandbox, ["ls-tree", "-r", snapshot]).split("\n");

    expect(entries.find((line) => line.endsWith("script.sh"))).toContain("100755");
    expect(entries.find((line) => line.endsWith("link.txt"))).toContain("120000");
    expect(entries.find((line) => line.endsWith("plain.txt"))).toContain("100644");
    expect(git(sandbox, ["show", `${snapshot}:link.txt`])).toBe("plain.txt");
    expect(git(sandbox, ["show", `${snapshot}:nested/deep.txt`])).toBe("deep");
    expect(git(sandbox, ["show", `${snapshot}:awkward\nname.txt`])).toBe("awkward");
  });

  it("hands git the same overrides and --local on every invocation, and runs no other subcommand", () => {
    // `--local` and the `-c` overrides are belt-and-braces whose whole point is
    // to hold under a *future* change, so nothing about today's behaviour pins
    // them. The argv Git is handed does. The subcommand list is pinned with
    // them because the reasoning for which config keys are unreachable — no
    // diff, no network transport, no interactive command, no upload-pack — is
    // only true of this set.
    const root = makeTemporaryRoot();
    const record = path.join(root, "git-argv.log");
    const shim = makeGitShim(
      root,
      `{ for a in "$@"; do printf '%s\u001f' "$a"; done; printf '\\n'; } >> ${JSON.stringify(record)}`,
    );
    const projectsRoot = path.join(root, "child-projects");
    runInChildProcess(
      root,
      [
        `process.env.KADY_PROJECTS_ROOT = ${JSON.stringify(projectsRoot)};`,
        `const projects = await import(${JSON.stringify(PROJECTS_MODULE_PATH)});`,
        `projects.ensureProjectExists("argv-study");`,
        `projects.createProjectRunSnapshot("argv-study", "argv-run");`,
        "",
      ].join("\n"),
      { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}` },
    );

    const invocations = fs
      .readFileSync(record, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\u001f").filter(Boolean));
    expect(invocations.length).toBeGreaterThan(0);

    const subcommands = new Set<string>();
    for (const argv of invocations) {
      // Every invocation neutralises the config keys that make Git execute
      // something, whatever the sandbox's own config says.
      expect(argv).toContain(`core.hooksPath=${os.devNull}`);
      expect(argv).toContain("core.fsmonitor=false");
      expect(argv).toContain("--no-pager");
      const subcommand = argv.find(
        (argument, index) =>
          !argument.startsWith("-") && argv[index - 1] !== "-c" && argv[index - 1] !== "-C",
      );
      expect(subcommand).toBeDefined();
      subcommands.add(subcommand!);
      // The identity write names the file it writes: without `--local`,
      // `git config` writes wherever GIT_CONFIG points.
      if (subcommand === "config") expect(argv).toContain("--local");
    }
    for (const subcommand of subcommands) {
      expect(PROJECT_GIT_SUBCOMMANDS).toContain(subcommand);
    }
    // `git add` is specifically gone: it is the invocation that ran filters.
    expect(subcommands.has("add")).toBe(false);
    expect(subcommands.has("config")).toBe(true);
    expect(subcommands.has("update-ref")).toBe(true);
  }, 120_000);
});

describe("inherited git environment", () => {
  afterAll(() => {
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  });

  it("scrubs every inherited GIT_ variable, whatever its name", () => {
    // A list was wrong twice: round 14's hand-written one missed GIT_CONFIG,
    // round 15's derivation from `--local-env-vars` missed GIT_TRACE, which is
    // not repository-binding and so is not on that list. The rule is the fix;
    // these names are only samples of the families a list keeps missing.
    const injected = {
      GIT_TRACE: "/tmp/kady-should-not-be-written",
      GIT_TRACE2_EVENT: "/tmp/kady-should-not-be-written",
      GIT_EXEC_PATH: "/tmp/kady-hostile-exec-path",
      GIT_TEMPLATE_DIR: "/tmp/kady-hostile-template",
      GIT_ATTR_SOURCE: "HEAD",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/tmp/kady-hostile-hooks",
      GIT_A_VARIABLE_GIT_DOES_NOT_HAVE_YET: "1",
    };
    const inherited: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(injected)) {
      inherited[key] = process.env[key];
      process.env[key] = value;
    }
    let scrubbed: NodeJS.ProcessEnv;
    try {
      scrubbed = projectGitEnvironment({ GIT_INDEX_FILE: "/tmp/kady-index" });
    } finally {
      for (const key of Object.keys(injected)) {
        if (inherited[key] === undefined) delete process.env[key];
        else process.env[key] = inherited[key];
      }
    }

    for (const key of Object.keys(injected)) expect(scrubbed[key]).toBeUndefined();
    expect(Object.keys(scrubbed).filter((key) => key.startsWith("GIT_"))).toEqual([
      "GIT_INDEX_FILE",
    ]);
    // Non-Git variables are left alone: PATH still has to reach git.
    expect(scrubbed.PATH).toBe(process.env.PATH);
  });

  it("ignores an inherited GIT_TRACE instead of appending git trace output to the file it names", () => {
    // GIT_TRACE is not repository-binding, so `--local-env-vars` does not name
    // it and the derived list did not cover it. It names a file every git
    // invocation appends to: one unauthenticated request was enough to append
    // trace output into a checkout's `.git/config` until git could no longer
    // read the repository at all.
    const root = makeTemporaryRoot();
    const victim = makeCheckoutWithHistory(root, "traced-checkout");
    const sandbox = path.join(root, "project", "sandbox");
    makeSandboxWithFile(sandbox);
    const before = fingerprintCheckout(victim);

    const inheritedTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = path.join(victim, ".git", "config");
    try {
      ensureProjectRepository(sandbox);
    } finally {
      if (inheritedTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = inheritedTrace;
    }

    expect(fingerprintCheckout(victim)).toEqual(before);
    // Still a readable repository, which is what the trace output destroyed.
    expect(git(victim, ["rev-list", "--count", "--all"])).toBe("1");
    expect(git(sandbox, ["log", "-1", "--format=%s"])).toBe("Initialize Kady project");
  });

  it("falls back to the pinned key list when git cannot answer within the discovery timeout", () => {
    // Discovery runs synchronously while the module initialises, so an
    // unbounded one turns a slow or wedged git on PATH into a server that never
    // starts. This is also the only way to prove the fallback is live code.
    const root = makeTemporaryRoot();
    const shim = makeGitShim(
      root,
      'if printf "%s\\n" "$@" | grep -q -- "--local-env-vars"; then sleep 30; fi',
    );
    const started = Date.now();
    const printed = runInChildProcess(
      root,
      [
        `const projects = await import(${JSON.stringify(PROJECTS_MODULE_PATH)});`,
        "console.log(JSON.stringify(projects.RELOCATING_GIT_ENVIRONMENT_KEYS));",
        "",
      ].join("\n"),
      { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}` },
    );
    const elapsed = Date.now() - started;

    // Bounded: the module loaded rather than waiting out the 30 s sleep.
    expect(elapsed).toBeLessThan(20_000);
    // ...and it loaded with exactly the pinned fallback, which is what the
    // fallback exists for.
    expect(JSON.parse(printed)).toEqual(
      [
        ...new Set([
          ...GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK,
          "GIT_CEILING_DIRECTORIES",
          "GIT_NAMESPACE",
        ]),
      ].sort(),
    );
  }, 120_000);
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
