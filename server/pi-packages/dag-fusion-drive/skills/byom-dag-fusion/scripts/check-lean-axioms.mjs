#!/usr/bin/env node
import fs from "node:fs";

const outputFile = process.argv[2];
const theoremName = process.argv[3];
const marker = process.argv[4];
if (!outputFile || !theoremName || !marker) {
  process.stderr.write(
    "usage: check-lean-axioms.mjs <lean-output> <theorem-name> <marker>\n",
  );
  process.exit(64);
}
if (!/^[A-Za-z0-9_]+$/.test(marker)) {
  process.stderr.write("byom-dag-fusion: invalid axiom-output marker\n");
  process.exit(2);
}

let output;
try {
  output = fs.readFileSync(outputFile, "utf8");
} catch (error) {
  process.stderr.write(
    `byom-dag-fusion: cannot read Lean axiom output: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(2);
}

const beginMarker = `${marker}_BEGIN`;
const endMarker = `${marker}_END`;
const beginIndex = output.indexOf(beginMarker);
const endIndex = output.indexOf(endMarker);
if (
  beginIndex < 0 ||
  endIndex < 0 ||
  endIndex <= beginIndex ||
  output.indexOf(beginMarker, beginIndex + beginMarker.length) >= 0 ||
  output.indexOf(endMarker, endIndex + endMarker.length) >= 0
) {
  process.stderr.write(
    "byom-dag-fusion: Lean axiom output is missing unique audit markers\n",
  );
  process.exit(2);
}

const auditOutput = output.slice(beginIndex + beginMarker.length, endIndex);
const quotedTheorem = `'${theoremName}'`;
const noAxioms = `${quotedTheorem} does not depend on any axioms`;
let axioms = [];

if (!auditOutput.includes(noAxioms)) {
  const escapedTheorem = quotedTheorem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...auditOutput.matchAll(
      new RegExp(`${escapedTheorem} depends on axioms:\\s*\\[([^\\]]*)\\]`, "g"),
    ),
  ];
  if (matches.length !== 1) {
    process.stderr.write(
      `byom-dag-fusion: no unique #print axioms result for ${theoremName}\n`,
    );
    process.exit(2);
  }
  axioms = matches[0][1]
    .split(",")
    .map((axiom) => axiom.trim())
    .filter(Boolean);
}

const allowedAxioms = new Set(["propext", "Classical.choice", "Quot.sound"]);
const unsupportedAxioms = axioms.filter((axiom) => !allowedAxioms.has(axiom));
if (unsupportedAxioms.length > 0) {
  process.stderr.write(
    `byom-dag-fusion: theorem depends on unsupported axioms: ${unsupportedAxioms.join(", ")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `byom-dag-fusion: allowed_axioms=${axioms.length > 0 ? axioms.join(",") : "none"}\n`,
);
