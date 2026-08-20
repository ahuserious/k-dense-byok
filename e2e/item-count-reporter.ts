import path from "node:path";

import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";

// Keys are POSIX-relative to the `e2e/` directory, NOT basenames. Five Wave-F lanes are each adding
// `e2e/wave-f/<lane>/*.spec.ts` under policy amendment #2, and two of them naming a file
// `settings.spec.ts` would have silently shared one basename pin -- one file's items would have
// satisfied the other's expectation and a whole spec file could go missing without the gate noticing.
// Every pre-existing key sits at the `e2e/` root, so none of their key text changed.
const EXPECTED_ITEMS_BY_FILE = new Map([
  ["builder-typed.spec.ts", 14],
  ["builder.spec.ts", 60],
  ["chat.spec.ts", 28],
  ["console-live.spec.ts", 12],
  ["console-raindrop.spec.ts", 33],
  ["live-backend.spec.ts", 3],
  ["scientific-pipelines.spec.ts", 57],
  ["workspace.spec.ts", 46],
  ["wave-f/harness/app-shell.spec.ts", 15],
  ["wave-f/harness/evidence-contract.spec.ts", 3],
  ["wave-f/harness/smoke.spec.ts", 1],
]);
// 218 + 16 Wave-F harness items (15 app-shell reachability + 1 smoke), all substantive: every one of
// them drives a real user path against a real backend and asserts on something named.
//
// evidence-contract.spec.ts's 3 items are NOT in that figure. They test the `evidence` fixture --
// the harness itself -- rather than a product surface, so they carry the thin label and land in the
// count below. A test of my own scaffolding must not raise the wave's substantive floor.
const EXPECTED_SUBSTANTIVE_ITEMS = 234;
// 35 pre-existing thin items (labelled inventory smokes plus the 3 fixmes) + the 3 Wave-F
// evidence-fixture contract items.
const EXPECTED_THIN_ITEMS = 38;
const EXPECTED_FIXME_ITEMS = 3;
const EXPECTED_SKIP_ITEMS = 0;

/**
 * The inventory key for a collected item: its path relative to the `e2e/` directory, in POSIX form.
 *
 * Derived from the absolute file path rather than from `config.rootDir` or a project `testDir`,
 * because the two projects that collect these files have *different* testDirs (`./e2e` for the
 * mocked tier, `./e2e/wave-f` for the Wave-F tier) and a testDir-relative key would give the same
 * file two different names depending on which project collected it. The last `e2e` path segment is
 * the anchor, so a checkout that itself lives under a directory called `e2e` still keys correctly.
 */
function inventoryKey(absoluteFile: string): string {
  const segments = absoluteFile.split(path.sep);
  const e2eIndex = segments.lastIndexOf("e2e");
  if (e2eIndex === -1) return path.basename(absoluteFile);
  return segments.slice(e2eIndex + 1).join("/");
}

function isFullInventoryRun(config: FullConfig) {
  const configuredGrep = Array.isArray(config.grep) ? config.grep : [config.grep];
  const configuredFilter = (
    configuredGrep.length !== 1 || configuredGrep[0]?.source !== ".*" ||
    config.grepInvert !== null ||
    config.projects.some((project) => project.grepInvert !== null)
  );
  const hasTitleFilter = config.argv.some((argument) => (
    argument === "--grep" ||
    argument === "-g" ||
    argument.startsWith("--grep=") ||
    argument === "--grep-invert" ||
    argument.startsWith("--grep-invert=")
  ));
  const hasLocationFilter = config.argv.some((argument) => (
    /(?:^|\/)e2e(?:\/|$)/.test(argument) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?(?::\d+)?$/.test(argument)
  ));
  const hasSubsetMode = config.argv.some((argument) => (
    argument === "--last-failed" || argument === "--only-changed"
  ));
  // `--project=<name>` selects a subset of the collection just as surely as a path or a grep does,
  // and it was in none of the buckets above. The committed config had a single project, so nothing
  // ever exercised that hole; the moment the Wave-F tier added a second one, the command every lane
  // runs -- `npx playwright test --project=wave-f` -- would have been classified as a full inventory
  // run, collected only the Wave-F items, and thrown "E2E inventory drifted" against the full pins.
  const hasProjectFilter = config.argv.some((argument) => (
    argument === "--project" || argument.startsWith("--project=")
  ));
  return !configuredFilter && !hasTitleFilter && !hasLocationFilter && !hasSubsetMode &&
    !hasProjectFilter && config.shard === null;
}

export default class ItemCountReporter implements Reporter {
  onBegin(config: FullConfig, suite: Suite) {
    process.stdout.write(`E2E globalSetup resolved: ${config.globalSetup ?? "none"}\n`);
    const tests = suite.allTests();
    const actualItemsByFile = new Map<string, number>();
    let thinItems = 0;
    let fixmeItems = 0;
    let skippedItems = 0;

    for (const test of tests) {
      const file = inventoryKey(test.location.file);
      actualItemsByFile.set(file, (actualItemsByFile.get(file) ?? 0) + 1);
      const labelledThin = test.titlePath().some(
        (title) => title.includes("excluded from the substantive count"),
      );
      const isFixme = test.annotations.some((annotation) => annotation.type === "fixme");
      const isSkipped = test.annotations.some((annotation) => annotation.type === "skip");
      if (isFixme) fixmeItems += 1;
      if (isSkipped) skippedItems += 1;
      if (labelledThin || isFixme || isSkipped) thinItems += 1;
    }

    const substantiveItems = tests.length - thinItems;
    const problems: string[] = [];
    const fullInventoryRun = isFullInventoryRun(config);
    if (fullInventoryRun) {
      for (const [file, expected] of EXPECTED_ITEMS_BY_FILE) {
        const actual = actualItemsByFile.get(file) ?? 0;
        if (actual !== expected) problems.push(`${file}: expected ${expected}, collected ${actual}`);
        actualItemsByFile.delete(file);
      }
      for (const [file, actual] of actualItemsByFile) {
        problems.push(`${file}: expected 0, collected ${actual}`);
      }
      if (substantiveItems !== EXPECTED_SUBSTANTIVE_ITEMS) {
        problems.push(
          `substantive items: expected ${EXPECTED_SUBSTANTIVE_ITEMS}, collected ${substantiveItems}`,
        );
      }
      if (thinItems !== EXPECTED_THIN_ITEMS) {
        problems.push(`thin items: expected ${EXPECTED_THIN_ITEMS}, collected ${thinItems}`);
      }
      if (fixmeItems !== EXPECTED_FIXME_ITEMS) {
        problems.push(`fixme items: expected ${EXPECTED_FIXME_ITEMS}, collected ${fixmeItems}`);
      }
      if (skippedItems !== EXPECTED_SKIP_ITEMS) {
        problems.push(`skipped items: expected ${EXPECTED_SKIP_ITEMS}, collected ${skippedItems}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`E2E inventory drifted:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    }

    const status = fullInventoryRun ? "verified" : "observed for filtered run";
    process.stdout.write(
      `E2E inventory ${status}: ${String(tests.length)} total = ${String(substantiveItems)} executing-substantive + ${String(thinItems)} thin; ${String(fixmeItems)} fixme + ${String(skippedItems)} skip.\n`,
    );
  }
}
