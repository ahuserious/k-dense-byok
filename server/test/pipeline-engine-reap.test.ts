import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * start.mjs spawns the vendored workflow engine (server/vendor/pipeline-engine)
 * with bun as a DETACHED owned child: `bun --filter '@archon/server' start`
 * re-spawns the actual server as a grandchild in the same process group, so a
 * plain child.kill() leaks the grandchild (observed live: the health endpoint
 * kept answering after the direct child died). This test proves the launcher's
 * group-kill / waitForOwnedTree discipline reaps the WHOLE engine tree.
 *
 * It mirrors start.mjs startWorkflowEngine()/stopAll() exactly: detached
 * spawn, health readiness, SIGTERM to the process group, ownedTreeGone probe
 * on the group. Skipped where the discipline (or the engine) cannot run:
 * Windows (no POSIX process groups — start.mjs uses taskkill /T there), no
 * bun, or vendor node_modules not installed (they are git-ignored; start.mjs
 * installs them on first run).
 */

const isWin = process.platform === "win32";
const VENDOR_DIR = path.join(process.cwd(), "vendor", "pipeline-engine");

/** Same resolution order as start.mjs findBun(): PATH, then ~/.bun/bin. */
function findBun(): string | null {
  for (const candidate of ["bun", path.join(os.homedir(), ".bun", "bin", "bun")]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const bunPath = isWin ? null : findBun();
const engineInstalled =
  fs.existsSync(path.join(VENDOR_DIR, "package.json")) &&
  fs.existsSync(path.join(VENDOR_DIR, "node_modules"));
const runnable = !isWin && bunPath !== null && engineInstalled;

/** Mirror of start.mjs ownedTreeGone(): only ESRCH proves the group is gone. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** PIDs currently in the engine's process group (pgrep sweep; empty = reaped). */
function groupPids(pgid: number): number[] {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("vendored workflow engine owned-tree reaping", () => {
  it.skipIf(!runnable)(
    "group SIGTERM reaps the whole detached bun engine tree",
    async () => {
      // Ephemeral-ish test port well away from the real 3091 engine and the
    // backend/frontend ports; ARCHON_HOME keeps engine state out of the user's default home.
      const enginePort = 3400 + (process.pid % 500);
      const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pipeline-engine-reap-"));
      const engineEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(enginePort),
        HOST: "127.0.0.1",
        ARCHON_HOME: engineHome,
        DEFAULT_AI_ASSISTANT: "pi",
        ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING: "1",
      };
      delete engineEnv.CLAUDECODE;
      // Keep the test web-only: an inherited bot token would start a live
      // Telegram poller that fights the user's real engine over the bot.
      delete engineEnv.TELEGRAM_BOT_TOKEN;

      const child = spawn(bunPath!, ["--filter", "@archon/server", "start"], {
        cwd: VENDOR_DIR,
        stdio: "ignore",
        detached: true, // own process group — the property under test
        env: engineEnv,
      });
      const pgid = child.pid!;

      try {
        // Readiness: the engine answers /api/health (bounded, like start.mjs).
        const bootDeadline = Date.now() + 30_000;
        let healthy = false;
        while (Date.now() < bootDeadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${enginePort}/api/health`, {
              signal: AbortSignal.timeout(1_000),
            });
            if (res.ok) {
              const body = (await res.json()) as { status?: string };
              expect(body.status).toBe("ok");
              healthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await sleep(200);
        }
        expect(healthy, "engine never answered /api/health").toBe(true);

        // The failure mode this guards: bun re-spawned the server as a
        // grandchild, so the group must hold MORE than the direct child.
        expect(groupPids(pgid).length).toBeGreaterThanOrEqual(2);

        // stopAll() discipline: SIGTERM the group, then waitForOwnedTree.
        process.kill(-pgid, "SIGTERM");
        const reapDeadline = Date.now() + 15_000;
        while (groupAlive(pgid) && Date.now() < reapDeadline) await sleep(100);

        // pgrep sweep for the engine's group after teardown = empty, and the
        // port is released (nothing keeps answering health).
        expect(groupAlive(pgid), `engine group ${String(pgid)} survived SIGTERM`).toBe(false);
        expect(groupPids(pgid)).toEqual([]);
        await expect(
          fetch(`http://127.0.0.1:${enginePort}/api/health`, {
            signal: AbortSignal.timeout(1_000),
          }),
        ).rejects.toThrow();
      } finally {
        // Belt-and-braces: never leak the engine tree, even on assertion failure.
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* already gone */
        }
        fs.rmSync(engineHome, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
