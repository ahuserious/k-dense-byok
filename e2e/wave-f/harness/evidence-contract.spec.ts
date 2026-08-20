/**
 * Wave-F evidence-fixture contract — 3 items, all THIN.
 *
 * These items test the HARNESS, not the product. They are inside the `— excluded from the
 * substantive count` describe block on purpose: the wave's floor claim is a count of items that
 * drive a real user path through a real feature, and a test of my own fixture is not one of those.
 * Counting them as substantive would inflate the ADR S11 floor with the harness's own scaffolding,
 * which is exactly the shape this wave exists to stop.
 *
 * What they pin is the round-2 fix to `evidence.shot()`. Before it, the screenshot path was
 * `<lane>/<spec>/<NN>-<name>.png` with `<NN>` reset per item, so two items in one spec file that
 * passed the same name wrote the same absolute file — silently, and concurrently under this
 * config's `workers: 4` / `fullyParallel: true`, which can truncate a PNG rather than merely keep
 * the last writer's. Five lanes are about to write against this API; the loop
 * `for (const preset of PRESETS) test(…, async ({evidence}) => evidence.shot("preset-saved"))`
 * is the natural thing to write and was the thing that broke.
 *
 * TIER: UNMOCKED, like every spec here — these items open the real app through `liveWorkspace` and
 * screenshot a real rendered surface, because a fixture that only ever shot `about:blank` would not
 * be exercising the path lanes use.
 *
 * GATE SCOPE: none. This is harness self-verification, not Gate U, B or D evidence for any feature.
 */
import fs from "node:fs";
import path from "node:path";

import {
  WAVE_F_EVIDENCE_LOCK_SUFFIX,
  WAVE_F_EVIDENCE_MANIFEST_NAME,
  expect,
  test,
} from "../fixtures";

/**
 * The first item's screenshot path, read by the second item. Safe only because this block is
 * `describe.serial`: a serial group runs in one worker, in declaration order, so the second item
 * sees what the first assigned. Two items in a plain parallel block are in different processes and
 * would each see `undefined`.
 */
let firstItemScreenshotPath: string | undefined;

test.describe.serial(
  "Wave-F evidence contract: same name, two items — excluded from the substantive count",
  () => {
    test("the first item writes 01-shared-evidence-name.png under its own test id", async ({
      liveWorkspace,
      evidence,
    }, testInfo) => {
      const { page } = liveWorkspace;
      await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();

      const written = await evidence.shot("shared-evidence-name");
      firstItemScreenshotPath = written;

      expect(
        path.basename(written),
        "The file name is still the sortable <NN>-<name> the interface doc promises.",
      ).toBe("01-shared-evidence-name.png");
      expect(
        path.basename(path.dirname(written)),
        "The directory's last segment must be this item's Playwright test id.",
      ).toBe(testInfo.testId);
      expect(fs.statSync(written).size, "A screenshot with no bytes is not evidence.")
        .toBeGreaterThan(0);
      const lockDirectory = `${evidence.directory}${WAVE_F_EVIDENCE_LOCK_SUFFIX}`;
      expect(
        fs.statSync(lockDirectory).isDirectory(),
        "The deterministic item path must be exclusively held for the whole fixture lifetime.",
      ).toBe(true);
      expect(
        () => fs.mkdirSync(lockDirectory),
        "A second Playwright invocation must be unable to claim this item's path concurrently.",
      ).toThrow(/EEXIST/);
    });

    test("the second item passing the SAME name writes a different file, not over the first", async ({
      liveWorkspace,
      evidence,
    }, testInfo) => {
      const { page } = liveWorkspace;
      await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();

      expect(
        firstItemScreenshotPath,
        "This item reads the first item's path; the serial block guarantees that order.",
      ).toBeDefined();
      expect(
        fs.existsSync(
          `${path.dirname(firstItemScreenshotPath!)}${WAVE_F_EVIDENCE_LOCK_SUFFIX}`,
        ),
        "The first item's lock must be released after fixture teardown so a later run can refresh it.",
      ).toBe(false);
      expect(
        fs.existsSync(`${evidence.directory}${WAVE_F_EVIDENCE_LOCK_SUFFIX}`),
        "This second item must hold its own lock while it writes.",
      ).toBe(true);

      const written = await evidence.shot("shared-evidence-name");

      // The whole finding, asserted directly: identical name, identical file name, different file.
      expect(path.basename(written)).toBe(path.basename(firstItemScreenshotPath!));
      expect(
        written,
        "Two items in one spec file that pass the same evidence name must not share a path.",
      ).not.toBe(firstItemScreenshotPath);
      expect(path.basename(path.dirname(written))).toBe(testInfo.testId);

      // Both files are on disk, both non-empty: nothing was overwritten or truncated.
      for (const candidate of [firstItemScreenshotPath!, written]) {
        expect(fs.statSync(candidate).size, `${candidate} must still hold a real PNG.`)
          .toBeGreaterThan(0);
      }

      // And the sibling directories are two, under one spec directory, each with its provenance.
      const specDirectory = path.dirname(path.dirname(written));
      const itemDirectories = fs.readdirSync(specDirectory).sort();
      expect(itemDirectories.length, `Expected one directory per item under ${specDirectory}.`)
        .toBeGreaterThanOrEqual(2);
      const firstManifest = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(firstItemScreenshotPath!), WAVE_F_EVIDENCE_MANIFEST_NAME),
          "utf8",
        ),
      ) as { shots: string[]; testId: string };
      expect(firstManifest.shots).toEqual(["01-shared-evidence-name.png"]);
      expect(firstManifest.testId).toBe(path.basename(path.dirname(firstItemScreenshotPath!)));
    });
  },
);

test.describe("Wave-F evidence contract: reuse inside one item — excluded from the substantive count", () => {
  test("a repeated evidence name inside one item is refused, not silently overwritten", async ({
    liveWorkspace,
    evidence,
  }) => {
    const { page } = liveWorkspace;
    await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();

    const first = await evidence.shot("duplicate-inside-one-item");
    const bytesAfterFirstShot = fs.readFileSync(first);

    await expect(
      evidence.shot("duplicate-inside-one-item"),
      "The fixture must reject the reused name; a lane that quotes the first path must never be " +
        "shown a screenshot taken somewhere else in the item.",
    ).rejects.toThrow(/was already used by this test item/);

    // Refused means refused: the first screenshot is byte-for-byte what it was, and no second file
    // appeared. (A `.rejects` that had left a half-written PNG behind would be the same bug wearing
    // an error message.)
    expect(fs.readFileSync(first).equals(bytesAfterFirstShot)).toBe(true);
    expect(
      fs.readdirSync(path.dirname(first)).filter((entry) => entry.endsWith(".png")),
    ).toEqual(["01-duplicate-inside-one-item.png"]);
  });
});
