import path from "node:path";

import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";

const EXPECTED_ITEMS_BY_FILE = new Map([
  ["builder-typed.spec.ts", 14],
  ["builder.spec.ts", 60],
  ["chat.spec.ts", 28],
  ["console-live.spec.ts", 12],
  ["console-raindrop.spec.ts", 33],
  // Wave F lane F12 (matrix rows 48-50): integrations registry in Settings ▸ Connectors.
  ["f12-integrations.spec.ts", 3],
  ["live-backend.spec.ts", 3],
  ["harness-endpoint.spec.ts", 3],
  ["scientific-pipelines.spec.ts", 57],
  ["workspace.spec.ts", 46],
]);
const EXPECTED_SUBSTANTIVE_ITEMS = 224;
const EXPECTED_THIN_ITEMS = 35;
const EXPECTED_FIXME_ITEMS = 3;
const EXPECTED_SKIP_ITEMS = 0;

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
  return !configuredFilter && !hasTitleFilter && !hasLocationFilter && !hasSubsetMode && config.shard === null;
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
      const file = path.basename(test.location.file);
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
