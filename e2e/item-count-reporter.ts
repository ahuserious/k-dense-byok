import path from "node:path";

import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";

const EXPECTED_ITEMS_BY_FILE = new Map([
  ["builder.spec.ts", 60],
  ["chat.spec.ts", 28],
  ["console-raindrop.spec.ts", 33],
  ["scientific-pipelines.spec.ts", 54],
  ["studio.spec.ts", 34],
  ["workspace.spec.ts", 37],
]);
const EXPECTED_SUBSTANTIVE_ITEMS = 210;
const EXPECTED_THIN_ITEMS = 36;
const EXPECTED_FIXME_ITEMS = 31;
const EXPECTED_SKIP_ITEMS = 3;

export default class ItemCountReporter implements Reporter {
  onBegin(_config: FullConfig, suite: Suite) {
    const tests = suite.allTests();
    const actualItemsByFile = new Map<string, number>();
    let thinItems = 0;
    let fixmeItems = 0;
    let skippedItems = 0;

    for (const test of tests) {
      const file = path.basename(test.location.file);
      actualItemsByFile.set(file, (actualItemsByFile.get(file) ?? 0) + 1);
      if (test.titlePath().some((title) => title.includes("excluded from the substantive count"))) {
        thinItems += 1;
      }
      if (test.annotations.some((annotation) => annotation.type === "fixme")) fixmeItems += 1;
      if (test.annotations.some((annotation) => annotation.type === "skip")) skippedItems += 1;
    }

    const substantiveItems = tests.length - thinItems;
    const problems: string[] = [];
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
    if (problems.length > 0) {
      throw new Error(`E2E inventory drifted:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    }

    process.stdout.write(
      `E2E inventory verified: ${String(tests.length)} total = ${String(substantiveItems)} substantive + ${String(thinItems)} thin; ${String(fixmeItems)} fixme + ${String(skippedItems)} skip.\n`,
    );
  }
}
