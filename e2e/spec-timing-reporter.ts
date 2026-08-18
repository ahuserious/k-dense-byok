import fs from "node:fs";
import path from "node:path";

import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

// Relative to the directory `playwright test` was invoked from, which for every CI and local
// invocation is the repository root. `.stably/` is ignored wholesale by `.stably/.gitignore`, and
// unlike `.stably/test-results` it is not walked by the hosted evidence scan, so a timing log left
// here cannot perturb that scan's byte accounting.
const DEFAULT_TIMINGS_FILE = ".stably/e2e-spec-timings.ndjson";

interface TimingRecord {
  file: string;
  line: number;
  project: string;
  title: string;
  status: TestResult["status"];
  retry: number;
  workerIndex: number;
  durationMs: number;
  startedAt: string;
}

/**
 * Records one NDJSON line per finished test so that a slowdown can be attributed to a spec rather
 * than guessed at.
 *
 * Two decisions here are deliberate and load-bearing:
 *
 *  1. Each line is appended synchronously as the test ends, instead of buffering and emitting the
 *     whole report from `onEnd`. The run this instrumentation exists for is the run that gets
 *     killed part-way through by the suite step's `timeout-minutes`, and in that run `onEnd` never
 *     executes. Streaming means the timings for the portion that did run survive the kill, which is
 *     exactly the evidence a budget overrun needs.
 *
 *  2. A write failure disables the reporter and warns once; it never throws. Instrumentation that
 *     can fail a suite is worse than no instrumentation.
 *
 * Reporters run in the Playwright coordinator process, not in the workers, so a single append
 * handle observes every worker's results with no interleaving.
 */
export default class SpecTimingReporter implements Reporter {
  private timingsFile = DEFAULT_TIMINGS_FILE;
  private enabled = false;
  private warnedAboutWriteFailure = false;

  printsToStdout() {
    // Only the one-off failure warning ever reaches stdout, so `list` keeps its terminal control.
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite) {
    // `--list` collects without executing; leaving the previous run's timings untouched is more
    // honest than truncating a file no test is about to write to.
    if (config.argv.includes("--list")) return;

    this.timingsFile = path.resolve(
      process.cwd(),
      process.env.KADY_E2E_TIMINGS_FILE ?? DEFAULT_TIMINGS_FILE,
    );
    try {
      fs.mkdirSync(path.dirname(this.timingsFile), { recursive: true });
      fs.writeFileSync(this.timingsFile, "");
      this.enabled = true;
    } catch (error) {
      this.warnOnce(error);
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.enabled) return;

    const specFileName = path.basename(test.location.file);
    const titleSegments = test.titlePath().filter((segment) => segment.length > 0);
    // titlePath() is [project, file, ...describes, title]; the human-readable part is whatever
    // follows the file entry. Falling back to the bare title keeps this working if that shape
    // changes rather than silently recording an empty string.
    const fileSegmentIndex = titleSegments.findIndex((segment) => segment.endsWith(specFileName));
    const title = fileSegmentIndex === -1
      ? test.title
      : titleSegments.slice(fileSegmentIndex + 1).join(" > ");

    const record: TimingRecord = {
      file: specFileName,
      line: test.location.line,
      project: test.parent.project()?.name ?? "unknown",
      title,
      status: result.status,
      retry: result.retry,
      workerIndex: result.workerIndex,
      durationMs: result.duration,
      startedAt: result.startTime.toISOString(),
    };

    try {
      fs.appendFileSync(this.timingsFile, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.enabled = false;
      this.warnOnce(error);
    }
  }

  private warnOnce(error: unknown) {
    if (this.warnedAboutWriteFailure) return;
    this.warnedAboutWriteFailure = true;
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`E2E spec timings disabled (${reason}); the suite is unaffected.\n`);
  }
}
