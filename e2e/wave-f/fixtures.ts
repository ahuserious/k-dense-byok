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

export interface WaveFEvidence {
  /** The lane id this spec's evidence is filed under (its directory under `e2e/wave-f/`). */
  readonly lane: string;
  /** Absolute directory this spec's screenshots are written to. */
  readonly directory: string;
  /**
   * Take a full-page screenshot at a deterministic path and attach it to the Playwright report.
   *
   *   await evidence.shot("settings-model-presets");
   *
   * Writes `.stably/wave-f-evidence/<lane>/<spec-basename>/<NN>-<name>.png`, where `<NN>` is a
   * two-digit counter that makes the on-disk order the call order. Returns the absolute path so a
   * spec can name it in an assertion message or a lane can copy it into its evidence report.
   */
  shot(name: string): Promise<string>;
}

export const test = liveTest.extend<{ evidence: WaveFEvidence }>({
  evidence: async ({ page }, use, testInfo) => {
    const identity = waveFSpecIdentity(testInfo);
    const directory = path.join(
      identity.repositoryRoot,
      WAVE_F_EVIDENCE_DIRECTORY,
      identity.lane,
      identity.specName,
    );
    let shotCount = 0;
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
        shotCount += 1;
        const fileName = `${String(shotCount).padStart(2, "0")}-${name}.png`;
        const absolutePath = path.join(directory, fileName);
        await page.screenshot({ path: absolutePath, fullPage: true });
        // Attached as well as written: the written copy is what a lane quotes by path in its
        // evidence file and what the CI artifact step uploads, the attachment is what makes it
        // visible in the HTML report and the trace viewer without anyone knowing the path.
        await testInfo.attach(`${identity.lane}/${identity.specName}/${fileName}`, {
          path: absolutePath,
          contentType: "image/png",
        });
        return absolutePath;
      },
    });
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
