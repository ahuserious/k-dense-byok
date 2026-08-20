/**
 * Wave-F click-through tier — the shared fixture surface every Wave-F lane writes against.
 *
 * TIER: UNMOCKED. There is no `page.route` anywhere in this chain. A spec in `e2e/wave-f/**` talks to
 * the real backend, the real vendored engine and the real frontend, booted by
 * `scripts/preview-up.mjs`. That is the whole reason this tier exists: the mocked tier at the `e2e/`
 * root intercepts every backend response at the browser boundary (`e2e/fixtures.ts:513` for the
 * backend, `:436` for the engine), so a green run there proves front-end behaviour and *nothing*
 * about the server. This file must never grow a route interceptor.
 *
 * It extends `../live-fixtures` rather than re-deriving an unmocked tier from `@playwright/test`.
 * `live-fixtures` already provides exactly the three things this tier needs — zero interception, the
 * console-error / `pageerror` discipline in its strictest honest form, and a real
 * "open the project, land on the workspace" entry — and a second implementation of those would be a
 * duplicate of an existing capability.
 *
 * The one net-new capability here is `evidence`.
 *
 * WHAT THIS TIER IS AND IS NOT EVIDENCE FOR (master brief §3):
 *   - Gate U (reachable in the UI): yes. A wave-F item plus its screenshot is Gate U evidence.
 *   - Gate B (bound on the backend): NO. Gate B needs a *server* test asserting on the effect. A
 *     green Playwright item is not backend binding, however unmocked it is.
 *   - Gate D (design-compliant): partially. Screenshots support a contrast/keyboard argument; they do
 *     not replace measured numbers.
 */
import fs from "node:fs";
import path from "node:path";

import type { TestInfo } from "@playwright/test";

import {
  expect,
  selectLiveWorkspaceTab,
  test as liveTest,
  type LiveProject,
  type LiveWorkspace,
} from "../live-fixtures";

/** Where every Wave-F screenshot lands, relative to the repository root. */
export const WAVE_F_EVIDENCE_DIRECTORY = path.join(".stably", "wave-f-evidence");

const WAVE_F_PATH_MARKER = `${path.sep}e2e${path.sep}wave-f${path.sep}`;

interface WaveFSpecIdentity {
  /** Repository root, derived from the spec's own path — no config lookup, no cwd assumption. */
  repositoryRoot: string;
  /**
   * The lane that owns this spec: the first directory segment under `e2e/wave-f/`. A spec sitting
   * directly under `e2e/wave-f/` is attributed to the shared lane id `wave-f`, which is a real
   * answer rather than an empty string in a path.
   */
  lane: string;
  /** The spec file's basename without its `.spec.ts` suffix. */
  specName: string;
}

function waveFSpecIdentity(testInfo: TestInfo): WaveFSpecIdentity {
  const markerIndex = testInfo.file.lastIndexOf(WAVE_F_PATH_MARKER);
  if (markerIndex === -1) {
    throw new Error(
      `The Wave-F fixtures are only for specs under e2e/wave-f/; ${testInfo.file} is outside that ` +
        "tree. A spec that needs a mocked backend belongs at the e2e/ root instead, and must say so.",
    );
  }
  const repositoryRoot = testInfo.file.slice(0, markerIndex);
  const relativeSegments = testInfo.file
    .slice(markerIndex + WAVE_F_PATH_MARKER.length)
    .split(path.sep);
  const specFileName = relativeSegments[relativeSegments.length - 1] ?? "";
  return {
    repositoryRoot,
    lane: relativeSegments.length > 1 ? relativeSegments[0]! : "wave-f",
    specName: specFileName.replace(/\.spec\.[cm]?tsx?$/, ""),
  };
}

/** The per-item provenance file written next to that item's screenshots. */
export const WAVE_F_EVIDENCE_MANIFEST_NAME = "run.json";
/** A sibling directory held while one Playwright invocation owns an item's deterministic path. */
export const WAVE_F_EVIDENCE_LOCK_SUFFIX = ".lock";

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function acquireEvidenceDirectoryLock(directory: string, testInfo: TestInfo): string {
  const lockDirectory = `${directory}${WAVE_F_EVIDENCE_LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    // `mkdir` is the cross-platform atomic claim. The item id is unique only within one Playwright
    // session; two Playwright CLI processes can execute the same item concurrently and therefore
    // compute the same deterministic evidence directory. Without this claim, either process can
    // `rmSync` the other process's screenshots or both can write the same PNG/run.json.
    fs.mkdirSync(lockDirectory);
  } catch (error) {
    if (hasNodeErrorCode(error, "EEXIST")) {
      throw new Error(
        `Wave-F evidence directory ${directory} is already owned by another Playwright invocation ` +
          `(lock: ${lockDirectory}). Refusing to clear or write it, because concurrent runs of the ` +
          "same item would race. If no Playwright run is active, remove the stale lock directory " +
          "and run the item again.",
      );
    }
    throw error;
  }

  try {
    fs.writeFileSync(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify(
        {
          pid: process.pid,
          testId: testInfo.testId,
          project: testInfo.project.name,
          retry: testInfo.retry,
          acquiredAt: new Date().toISOString(),
          ciRunId: process.env.GITHUB_RUN_ID ?? null,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    throw error;
  }
  return lockDirectory;
}

export interface WaveFEvidence {
  /** The lane id this spec's evidence is filed under (its directory under `e2e/wave-f/`). */
  readonly lane: string;
  /**
   * Absolute directory THIS TEST ITEM's screenshots are written to:
   * `.stably/wave-f-evidence/<lane>/<spec-basename>/<testId>/`. The last segment is
   * `testInfo.testId`, so two items in one spec file never share a directory however they are
   * titled, and the directory is emptied when this item starts.
   */
  readonly directory: string;
  /**
   * Take a full-page screenshot at a deterministic path and attach it to the Playwright report.
   *
   *   await evidence.shot("settings-model-presets");
   *
   * Writes `.stably/wave-f-evidence/<lane>/<spec-basename>/<testId>/<NN>-<name>.png`, where `<NN>`
   * is a per-item counter that makes the on-disk order the call order. Returns the absolute path so
   * a spec can name it in an assertion message or a lane can copy it into its evidence report.
   *
   * NAMES MUST BE UNIQUE WITHIN AN ITEM. A second `shot("same-name")` in the same item REJECTS
   * rather than overwriting the first: a silently-lost screenshot is worse than a red test, because
   * a lane pastes a path into an evidence file and never learns the file it names came from
   * somewhere else.
   */
  shot(name: string): Promise<string>;
}

export const test = liveTest.extend<{ evidence: WaveFEvidence }>({
  evidence: async ({ page }, use, testInfo) => {
    const identity = waveFSpecIdentity(testInfo);
    // `testInfo.testId` and NOT a slug of the title: a parameterised title
    // (`test(\`preset ${preset.id}\`, …)`) can produce two identical slugs, and a slug of a title
    // with unicode or punctuation in it is a second escaping problem. The id is Playwright's own
    // per-item key -- it already folds in the project, the file, the full title path and the
    // repeat-each index -- so two items cannot collide, and it is stable across runs of the same
    // item, so a path quoted in a lane's evidence file keeps resolving.
    const directory = path.join(
      identity.repositoryRoot,
      WAVE_F_EVIDENCE_DIRECTORY,
      identity.lane,
      identity.specName,
      testInfo.testId,
    );
    const lockDirectory = acquireEvidenceDirectoryLock(directory, testInfo);
    let shotCount = 0;
    const writtenFileNameByName = new Map<string, string>();
    try {
      // Emptied, not merely created. `.stably/wave-f-evidence` is never cleaned between local runs,
      // so without this a screenshot from an earlier run -- or from attempt 1 of a retried item --
      // sits in the directory a lane is about to quote from, indistinguishable from what this run
      // produced. The sibling lock above makes this clearing safe even when a second Playwright CLI
      // process starts the same item in the same checkout.
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });

      try {
        await use({
          lane: identity.lane,
          directory,
          async shot(name: string): Promise<string> {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
              throw new Error(
                `Evidence name ${JSON.stringify(name)} must be lower-case kebab-case so the on-disk ` +
                  "evidence tree stays sortable and quotable in a report.",
              );
            }
            const alreadyWritten = writtenFileNameByName.get(name);
            if (alreadyWritten !== undefined) {
              throw new Error(
                `Evidence name ${JSON.stringify(name)} was already used by this test item; it wrote ` +
                  `${alreadyWritten}. Screenshot names must be unique within an item -- pass a ` +
                  "different name (for example a suffix naming the step: " +
                  `${JSON.stringify(`${name}-after`)}) rather than reusing this one. Refusing to ` +
                  "overwrite, because a lane that quotes the first path would silently be shown the " +
                  "second screenshot.",
              );
            }
            shotCount += 1;
            const fileName = `${String(shotCount).padStart(2, "0")}-${name}.png`;
            const absolutePath = path.join(directory, fileName);
            writtenFileNameByName.set(name, fileName);
            const screenshot = await page.screenshot({ fullPage: true });
            try {
              // `existsSync` followed by `page.screenshot({path})` was a TOCTOU check: another writer
              // could create/truncate the target between the check and the browser's write. Capture
              // first, then claim the final path with O_EXCL (`wx`) so an overwrite is impossible.
              fs.writeFileSync(absolutePath, screenshot, { flag: "wx" });
            } catch (error) {
              if (hasNodeErrorCode(error, "EEXIST")) {
                throw new Error(
                  `Evidence path ${absolutePath} already exists in this run. Refusing to overwrite ` +
                    "it, because two writers sharing one Wave-F evidence name would lose a screenshot.",
                );
              }
              throw error;
            }
            // Attached as well as written: the written copy is what a lane quotes by path in its
            // evidence file and what the CI artifact step uploads, the attachment is what makes it
            // visible in the HTML report and the trace viewer without anyone knowing the path.
            await testInfo.attach(`${identity.lane}/${identity.specName}/${fileName}`, {
              body: screenshot,
              contentType: "image/png",
            });
            return absolutePath;
          },
        });
      } finally {
        // Written on the way out, so a failed item still leaves provenance for whatever it did shoot.
        // A directory whose test was renamed or deleted keeps its old manifest and is visibly from
        // another run; a reader can inspect this file without trusting a screenshot's filename.
        fs.writeFileSync(
          path.join(directory, WAVE_F_EVIDENCE_MANIFEST_NAME),
          `${JSON.stringify(
            {
              lane: identity.lane,
              spec: path
                .relative(identity.repositoryRoot, testInfo.file)
                .split(path.sep)
                .join("/"),
              title: testInfo.titlePath.join(" › "),
              testId: testInfo.testId,
              project: testInfo.project.name,
              retry: testInfo.retry,
              workerIndex: testInfo.workerIndex,
              writtenAt: new Date().toISOString(),
              ciRunId: process.env.GITHUB_RUN_ID ?? null,
              shots: [...writtenFileNameByName.values()],
            },
            null,
            2,
          )}\n`,
        );
      }
    } finally {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  },
});

export { expect, selectLiveWorkspaceTab };
export type { LiveProject, LiveWorkspace };

/**
 * Assert the currently focused element is a real, visible control and return how it identifies
 * itself. Wave-F items use this to record a keyboard check next to their screenshot: Gate U requires
 * a surface to be reachable by keyboard, not merely clickable.
 */
export async function focusedControlDescription(page: import("@playwright/test").Page) {
  const focused = page.locator(":focus");
  await expect(
    focused,
    "Tab must land on a visible control; a surface no keyboard can reach is not reachable.",
  ).toBeVisible();
  return focused.evaluate((element) => ({
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    accessibleName: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(),
  }));
}
