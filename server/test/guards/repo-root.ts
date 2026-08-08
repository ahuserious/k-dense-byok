import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function guardRepoRoot(): string {
  return path.resolve(process.env.R1_GUARD_REPO_ROOT ?? DEFAULT_REPO_ROOT);
}
