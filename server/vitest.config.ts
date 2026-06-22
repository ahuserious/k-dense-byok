import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // All test files share one projects root (below), and some suites reset that
    // whole root in beforeEach (e.g. agent-files.test.ts). Run files SEQUENTIALLY
    // so a reset in one file can't race filesystem writes in another — otherwise
    // concurrent .kady/runs writes hit ENOENT/ENOTEMPTY non-deterministically.
    fileParallelism: false,
    // Each run gets an isolated projects root under the OS temp dir.
    env: {
      KADY_PROJECTS_ROOT: process.env.VITEST_PROJECTS_ROOT ?? "/tmp/kady-vitest-projects",
    },
  },
});
