#!/usr/bin/env node
import fs from "node:fs";

const sourceFile = process.argv[2];
const theoremName = process.argv[3];
if (!sourceFile || !theoremName) {
  process.stderr.write(
    "usage: scan-lean-source.mjs <source.lean> <theorem-name>\n",
  );
  process.exit(64);
}

const LEAN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_']*$/;
const RESERVED_IDENTIFIERS = new Set([
  "axiom",
  "constant",
  "end",
  "lemma",
  "namespace",
  "section",
  "theorem",
]);

function isValidTheoremName(value) {
  if (value.length > 256) return false;
  const segments = value.split(".");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        LEAN_IDENTIFIER.test(segment) &&
        segment !== "_" &&
        segment !== "_root_" &&
        !RESERVED_IDENTIFIERS.has(segment),
    )
  );
}

if (!isValidTheoremName(theoremName)) {
  process.stderr.write(
    `byom-dag-fusion: invalid theorem identity: ${JSON.stringify(theoremName)}\n`,
  );
  process.exit(2);
}

let source;
try {
  source = fs.readFileSync(sourceFile, "utf8");
} catch (error) {
  process.stderr.write(
    `byom-dag-fusion: cannot read Lean source: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(2);
}

const forbidden = new Set([
  "admit",
  "axiom",
  "constant",
  "elab",
  "eval",
  "macro",
  "macro_rules",
  "partial",
  "print",
  "run_cmd",
  "sorry",
  "sorryAx",
  "syntax",
  "unsafe",
]);
let index = 0;
let line = 1;
let column = 1;
let blockCommentDepth = 0;
let inLineComment = false;
let inString = false;
let escaped = false;
const findings = [];
const tokens = [];

function advance(character) {
  index += 1;
  if (character === "\n") {
    line += 1;
    column = 1;
  } else {
    column += 1;
  }
}

while (index < source.length) {
  const character = source[index];
  const next = source[index + 1];

  if (inLineComment) {
    advance(character);
    if (character === "\n") inLineComment = false;
    continue;
  }
  if (blockCommentDepth > 0) {
    if (character === "/" && next === "-") {
      advance(character);
      advance(next);
      blockCommentDepth += 1;
    } else if (character === "-" && next === "/") {
      advance(character);
      advance(next);
      blockCommentDepth -= 1;
    } else {
      advance(character);
    }
    continue;
  }
  if (inString) {
    advance(character);
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
    continue;
  }

  if (character === "-" && next === "-") {
    advance(character);
    advance(next);
    inLineComment = true;
    continue;
  }
  if (character === "/" && next === "-") {
    advance(character);
    advance(next);
    blockCommentDepth = 1;
    continue;
  }
  if (character === '"') {
    advance(character);
    inString = true;
    continue;
  }
  if (/[A-Za-z_]/.test(character)) {
    const tokenLine = line;
    const tokenColumn = column;
    let value = "";
    while (index < source.length && /[A-Za-z0-9_']/.test(source[index])) {
      value += source[index];
      advance(source[index]);
    }
    tokens.push({ value, line: tokenLine, column: tokenColumn });
    if (forbidden.has(value)) {
      findings.push(`${tokenLine}:${tokenColumn}: forbidden token ${value}`);
    }
    continue;
  }
  if (character === ".") {
    tokens.push({ value: character, line, column });
  }
  advance(character);
}

if (blockCommentDepth > 0) findings.push(`${line}:${column}: unterminated block comment`);
if (inString) findings.push(`${line}:${column}: unterminated string literal`);

function readQualifiedName(startIndex) {
  const first = tokens[startIndex];
  if (!first || !LEAN_IDENTIFIER.test(first.value)) return undefined;
  const segments = [first.value];
  let nextIndex = startIndex + 1;
  while (
    tokens[nextIndex]?.value === "." &&
    LEAN_IDENTIFIER.test(tokens[nextIndex + 1]?.value ?? "")
  ) {
    segments.push(tokens[nextIndex + 1].value);
    nextIndex += 2;
  }
  return { segments, nextIndex };
}

const blockStack = [];
const namespaceSegments = [];
let foundTheorem = false;

for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
  const token = tokens[tokenIndex];
  if (token.value === "namespace") {
    const namespaceName = readQualifiedName(tokenIndex + 1);
    if (namespaceName) {
      blockStack.push({ kind: "namespace", length: namespaceName.segments.length });
      namespaceSegments.push(...namespaceName.segments);
      tokenIndex = namespaceName.nextIndex - 1;
    }
    continue;
  }
  if (token.value === "section") {
    blockStack.push({ kind: "section", length: 0 });
    continue;
  }
  if (token.value === "end") {
    const block = blockStack.pop();
    if (block?.kind === "namespace") {
      namespaceSegments.splice(namespaceSegments.length - block.length, block.length);
    }
    continue;
  }
  if (token.value !== "theorem" && token.value !== "lemma") continue;

  const declarationName = readQualifiedName(tokenIndex + 1);
  if (!declarationName) continue;
  const writtenName = declarationName.segments.join(".");
  const qualifiedName = [...namespaceSegments, ...declarationName.segments].join(".");
  if (theoremName === writtenName || theoremName === qualifiedName) {
    foundTheorem = true;
  }
  tokenIndex = declarationName.nextIndex - 1;
}

if (!foundTheorem) {
  findings.push(
    `the named theorem ${theoremName} is not declared with theorem or lemma in this source`,
  );
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`byom-dag-fusion: admitted source theorem=${theoremName}\n`);
