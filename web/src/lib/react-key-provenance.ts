import * as ts from "typescript";

/**
 * React key provenance classifier (BF-47, BF-9's defect class).
 *
 * **Test tooling. Nothing in the application imports this module.**
 *
 * BF-9 was 873 React duplicate-key errors from one key bound to `receipt.slotId`
 * — a *role name* minted per node kind (`server/src/workflows/run-state.ts`
 * returns the literal `"agent"`), not an identifier. It was found only because a
 * live run happened to surface it. `web/src` holds 274 `key=` sites; the rest of
 * that class is undetected, not absent.
 *
 * A static tool cannot prove a runtime array has distinct values, so this
 * classifier does not try. It answers a narrower, decidable question:
 *
 *   **does this key expression draw its uniqueness from a source the repo has
 *   certified, or from an uncertified one?**
 *
 * Certification is by four stated mechanisms and nothing else, and the
 * classifier **fails closed**: an expression it cannot place is `uncertified`,
 * never "probably fine". The cost of failing closed is that a genuinely sound
 * new key that uses none of the four mechanisms must be written down in the
 * baseline with a justification, where a reviewer sees it in the diff. That cost
 * is deliberate: BF-9 was invisible precisely because nothing forced anyone to
 * write down why a key was believed unique.
 */

export type KeyProvenance =
  /** Certified unique by one of the four mechanisms below. */
  | "certified"
  /** A bare loop index: stable per position, wrong under reorder/insert/delete. */
  | "index"
  /** Not certified. The guard fails on this unless the site is in the baseline. */
  | "uncertified";

export interface KeyProvenanceVerdict {
  readonly provenance: KeyProvenance;
  /** Which mechanism certified it, or why it could not be certified. */
  readonly reason: string;
}

/**
 * Mechanism 1 — **position**. A loop index is unique within the one list being
 * rendered, so any composite containing one is unique within that list.
 */
const INDEX_IDENTIFIER = /^(?:i|j|k|idx|index|ri|ci|rowIndex|colIndex|[a-z][A-Za-z0-9]*Index)$/;

/**
 * Mechanism 2 — **purpose-minted key**. The repo convention this guard
 * establishes: a React key that has to be computed is minted under a `…Key` or
 * `…Identity` name, at one place, where the dedup can be read and tested. That
 * is exactly the shape B47's fix took (`keyedModelReceipts()` -> `key`), and it
 * is the shape `diagnosticKey()`, `raindropReferenceKey()`,
 * `workflowRevisionId()` and `scientificPipelineRowIdentity()` already have.
 */
const MINTED_KEY_NAME = /^(?:key|[a-zA-Z0-9]*Key)$/;
const MINTED_KEY_CALLEE = /(?:Key|Identity)$/;

/**
 * Mechanism 3 — **instance id**, minus an evidence ledger of names that look
 * like ids and are not.
 *
 * An `…Id` suffix certifies only when the id names an *instance*. BF-9 is the
 * proof that the suffix alone is not a guarantee, so every name proven to be a
 * role, kind or category is recorded here with its proof. Adding a name to this
 * list requires a citation, not a suspicion; the list is the reason the
 * known-answer test below can catch the one instance we know was real.
 */
export const ROLE_SHAPED_ID_NAMES: ReadonlyMap<string, string> = new Map([
  [
    "slotId",
    "BF-9: `workflowModelCallSlotsForNode` (server/src/workflows/run-state.ts) "
      + "returns the string literal \"agent\" for every agent node — the slot id is a "
      + "role name minted per node kind, unique only within one node execution.",
  ],
]);
const INSTANCE_ID_NAME = /^(?:id|[a-z][A-Za-z0-9]*Id)$/;

/**
 * Mechanism 4 — **string literal**. A constant key cannot collide with a
 * different constant, and a list of constants is not a list.
 */

function certified(reason: string): KeyProvenanceVerdict {
  return { provenance: "certified", reason };
}

function uncertified(reason: string): KeyProvenanceVerdict {
  return { provenance: "uncertified", reason };
}

function isIndexExpression(node: ts.Expression, source: ts.SourceFile): boolean {
  if (ts.isIdentifier(node)) return INDEX_IDENTIFIER.test(node.text);
  // `String(index)` and `index.toString()` are the same position component.
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === "String" && node.arguments.length === 1) {
      return isIndexExpression(node.arguments[0], source);
    }
    if (
      ts.isPropertyAccessExpression(callee)
      && callee.name.text === "toString"
      && ts.isExpression(callee.expression)
    ) {
      return isIndexExpression(callee.expression, source);
    }
  }
  return false;
}

/** The interpolations of a template literal, in order. */
function templateParts(node: ts.TemplateExpression): ts.Expression[] {
  return node.templateSpans.map((span) => span.expression);
}

/**
 * Classify one JSX `key=` expression.
 *
 * Composites are certified only if a *position* component is present, or if
 * **every** varying component is itself certified — one uncertified component
 * poisons the whole key, because it is the component that can repeat.
 */
export function classifyKeyExpression(
  node: ts.Expression,
  source: ts.SourceFile,
): KeyProvenanceVerdict {
  // Mechanism 4: a constant.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return certified("string literal");
  }
  if (ts.isNumericLiteral(node)) return certified("numeric literal");

  if (ts.isParenthesizedExpression(node)) return classifyKeyExpression(node.expression, source);
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return classifyKeyExpression(node.expression, source);
  }

  // Mechanism 1: a bare loop index. Reported separately from `certified` so the
  // audit can decide per site whether the list reorders.
  if (isIndexExpression(node, source)) {
    return { provenance: "index", reason: "bare loop index" };
  }

  if (ts.isIdentifier(node)) {
    if (MINTED_KEY_NAME.test(node.text)) {
      return certified(`purpose-minted key binding \`${node.text}\``);
    }
    if (INSTANCE_ID_NAME.test(node.text)) {
      const role = ROLE_SHAPED_ID_NAMES.get(node.text);
      if (role) return uncertified(`\`${node.text}\` is a role-shaped id — ${role}`);
      return certified(`instance id binding \`${node.text}\``);
    }
    return uncertified(
      `bare identifier \`${node.text}\` — neither a minted key nor an instance id`,
    );
  }

  if (ts.isPropertyAccessExpression(node)) {
    const property = node.name.text;
    if (MINTED_KEY_NAME.test(property)) {
      return certified(`purpose-minted key property \`.${property}\``);
    }
    if (INSTANCE_ID_NAME.test(property)) {
      const role = ROLE_SHAPED_ID_NAMES.get(property);
      if (role) return uncertified(`\`.${property}\` is a role-shaped id — ${role}`);
      return certified(`instance id property \`.${property}\``);
    }
    return uncertified(
      `property \`.${property}\` is a descriptive field, not an identity — `
        + "a name, label, path, type or category can repeat (BF-9's class)",
    );
  }

  if (ts.isElementAccessExpression(node)) {
    return uncertified("element access — the indexed value's provenance is not decidable here");
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (MINTED_KEY_CALLEE.test(calleeName)) {
      return certified(`minted by \`${calleeName}()\``);
    }
    return uncertified(
      `call to \`${calleeName || "<expression>"}()\` — only a \`…Key()\` / \`…Identity()\` `
        + "helper is a certified key mint",
    );
  }

  if (ts.isTemplateExpression(node)) {
    const parts = templateParts(node);
    if (parts.some((part) => isIndexExpression(part, source))) {
      return certified("composite containing a position component");
    }
    const verdicts = parts.map((part) => classifyKeyExpression(part, source));
    const weak = verdicts.findIndex((verdict) => verdict.provenance !== "certified");
    if (weak === -1) return certified("composite of certified components");
    return uncertified(
      `composite whose component \`${parts[weak].getText(source)}\` is not certified: `
        + verdicts[weak].reason,
    );
  }

  // `a ?? b`, `a || b`, `a + b`, `c ? a : b` — a fallback is only as strong as
  // its weakest branch, because the weak branch is the one that renders.
  if (ts.isBinaryExpression(node)) {
    const left = classifyKeyExpression(node.left, source);
    if (left.provenance !== "certified") {
      return uncertified(`left branch of \`${ts.tokenToString(node.operatorToken.kind)}\` `
        + `is not certified: ${left.reason}`);
    }
    const right = classifyKeyExpression(node.right, source);
    if (right.provenance !== "certified") {
      return uncertified(`right branch of \`${ts.tokenToString(node.operatorToken.kind)}\` `
        + `is not certified: ${right.reason}`);
    }
    return certified("every branch certified");
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = classifyKeyExpression(node.whenTrue, source);
    if (whenTrue.provenance !== "certified") {
      return uncertified(`the true branch is not certified: ${whenTrue.reason}`);
    }
    const whenFalse = classifyKeyExpression(node.whenFalse, source);
    if (whenFalse.provenance !== "certified") {
      return uncertified(`the false branch is not certified: ${whenFalse.reason}`);
    }
    return certified("every branch certified");
  }

  return uncertified(`unhandled expression kind ${ts.SyntaxKind[node.kind]} — failing closed`);
}

export interface KeySite {
  /** Path relative to `web/src`, POSIX separators. */
  readonly file: string;
  readonly line: number;
  /** The key expression's source text, whitespace-collapsed. */
  readonly expression: string;
  readonly verdict: KeyProvenanceVerdict;
}

/** Every JSX `key=` attribute in one source text, with its verdict. */
export function collectKeySites(relativeFile: string, sourceText: string): KeySite[] {
  const source = ts.createSourceFile(
    relativeFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativeFile.endsWith(".tsx") || relativeFile.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const sites: KeySite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "key" && node.initializer) {
      const initializer = node.initializer;
      const expression = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
      if (expression) {
        sites.push({
          file: relativeFile,
          line: source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1,
          expression: expression.getText(source).replace(/\s+/g, " "),
          verdict: classifyKeyExpression(expression, source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}
