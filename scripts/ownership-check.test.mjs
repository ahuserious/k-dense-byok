import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const checkerPath = path.join(scriptDirectory, "ownership-check.mjs");

function run(...arguments_) {
  return spawnSync(process.execPath, [checkerPath, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf-8",
  });
}

test("ownership writer/base flags reject joined, unknown, duplicate, and option-shaped values", () => {
  for (const arguments_ of [
    ["--writer=C1", "--base", "cf0ab87"],
    ["--writter", "C1", "--base", "cf0ab87"],
    ["--writer", "C1", "--writer", "C1", "--base", "cf0ab87"],
    ["--writer", "C1", "--base", "-s"],
    ["--writer", "C1", "--base", "HEAD"],
  ]) {
    const result = run(...arguments_);
    assert.equal(result.status, 2, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ownership-check: FAIL/);
  }
});

test("writer validation reads the trusted base and refuses candidate-only policy grants", () => {
  const result = run("--writer", "C1", "--base", "6655abf");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /trusted base/);
  assert.match(result.stderr, /docs\/inventory\/ownership\.json/);
  assert.match(result.stderr, /scripts\/ownership-check\.mjs/);
});
