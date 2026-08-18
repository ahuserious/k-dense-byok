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
 * Every case builds real temporary repositories; nothing about Git is mocked.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureProjectRepository,
  ProjectRepositoryContainmentError,
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
