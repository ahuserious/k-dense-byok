import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyKeyExpression,
  collectKeySites,
  ROLE_SHAPED_ID_NAMES,
  type KeySite,
} from "./react-key-provenance";
import {
  REACT_KEY_PROVENANCE_BASELINE_V1,
  type KeyProvenanceBaselineEntry,
} from "./react-key-provenance.baseline";

/**
 * BF-47 — the repository guard for BF-9's defect class.
 *
 * BF-9 was 873 React duplicate-key errors from a key bound to `receipt.slotId`,
 * a role name and not an id. It surfaced only because one live run happened to
 * hit it. This guard is the part of B50 that outlives the fix: it makes a new
 * key with no uniqueness provenance fail in CI instead of waiting for a run.
 *
 * **Where it lives and why.** A vitest repo guard next to the two the repo
 * already has — `scientific-pipeline-visible-copy.test.ts` (walks `web/src` with
 * the TypeScript AST) and `scientific-pipeline-vocabulary.repo.test.ts` (an
 * explicit shrinking ratchet with a written justification per entry). This guard
 * needs both of those shapes at once: a whole-tree census and a persisted
 * baseline diff. ESLint was the other candidate and was rejected — this repo
 * runs ESLint over a narrow glob (`web/package.json`'s `lint:dag`), and a
 * per-file lint rule has no way to hold a tree-wide census or to notice that a
 * baselined site has disappeared.
 *
 * **How it avoids flagging all 274 sites.** The classifier certifies a key when
 * its uniqueness comes from one of four stated mechanisms (position component,
 * purpose-minted `…Key` / `…Identity`, instance id minus a proven role-name
 * ledger, or a literal). That covers 147 of the 274 sites with no baseline at
 * all. The remaining 127 are the ones a human actually had to think about, and
 * each is written down.
 *
 * **It fails closed.** An expression the classifier cannot place is
 * `uncertified`, never "probably fine", and an uncertified site that is not in
 * the baseline fails this test. The cost is real: a genuinely sound new key that
 * uses none of the four mechanisms must be justified in the baseline before it
 * can land. That cost is the deterrent.
 *
 * Runs with `cd web && npx vitest run src/lib/react-key-provenance.repo.test.ts`
 * (and therefore with `cd web && npm test`).
 */

const WEB_SRC = path.resolve(__dirname, "..");
const SKIP_DIRECTORY_NAMES = new Set(["node_modules", ".next", "__fixtures__"]);
const SCANNED_EXTENSIONS = [".tsx", ".jsx", ".ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORY_NAMES.has(entry.name)) walk(full, out);
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

function relativePosix(absolute: string): string {
  return path.relative(WEB_SRC, absolute).split(path.sep).join("/");
}

function census(): KeySite[] {
  const sites: KeySite[] = [];
  for (const file of walk(WEB_SRC).sort()) {
    sites.push(...collectKeySites(relativePosix(file), fs.readFileSync(file, "utf8")));
  }
  return sites;
}

function baselineKey(entry: { file: string; expression: string }): string {
  return `${entry.file}|${entry.expression}`;
}

const BASELINE = new Map<string, KeyProvenanceBaselineEntry>(
  REACT_KEY_PROVENANCE_BASELINE_V1.map((entry) => [baselineKey(entry), entry]),
);

describe("React key provenance guard (BF-47)", () => {
  const sites = census();

  it("finds the key sites it is supposed to be guarding", () => {
    // A guard that walked nothing would pass every other assertion here.
    expect(sites.length).toBeGreaterThan(200);
    expect(new Set(sites.map((site) => site.file)).size).toBeGreaterThan(50);
  });

  it("matches the audited B50 census", () => {
    const certifiedSites = sites.filter(
      (site) => site.verdict.provenance === "certified",
    ).length;
    const indexKeyedSites = sites.filter(
      (site) => site.verdict.provenance === "index",
    ).length;
    const uncertifiedSites = sites.filter(
      (site) => site.verdict.provenance === "uncertified",
    ).length;

    expect({
      filesWithKeys: new Set(sites.map((site) => site.file)).size,
      totalSites: sites.length,
      certifiedSites,
      indexKeyedSites,
      uncertifiedSites,
      baselineEntries: REACT_KEY_PROVENANCE_BASELINE_V1.length,
    }).toEqual({
      filesWithKeys: 91,
      totalSites: 274,
      certifiedSites: 147,
      indexKeyedSites: 30,
      uncertifiedSites: 97,
      baselineEntries: 109,
    });
  });

  it("every key expression is either certified or audited in the baseline", () => {
    const unaccounted = sites
      .filter((site) => site.verdict.provenance !== "certified")
      .filter((site) => !BASELINE.has(baselineKey(site)))
      .map((site) => `${site.file}:${site.line}  key={${site.expression}}\n      ${site.verdict.reason}`);

    expect(
      unaccounted,
      "A React key with no certified uniqueness provenance. Either mint it through a "
        + "`…Key()` / `…Identity()` helper, compose it with the loop index, or add it to "
        + "REACT_KEY_PROVENANCE_BASELINE_V1 with the reason it is unique. BF-9 was 873 "
        + "duplicate-key errors from exactly this shape.",
    ).toEqual([]);
  });

  it("no site regresses to a key that was demonstrated to collide", () => {
    const regressions = sites
      .map((site) => ({ site, entry: BASELINE.get(baselineKey(site)) }))
      .filter(({ entry }) => entry?.bucket === "provably-non-unique")
      .map(({ site, entry }) => `${site.file}:${site.line}  key={${site.expression}} — ${entry!.why}`);

    expect(
      regressions,
      "This key expression is recorded as reproducibly non-unique. It must not come back.",
    ).toEqual([]);
  });

  it("the baseline is a ratchet: no stale entries, no drifted site counts", () => {
    const observed = new Map<string, number>();
    for (const site of sites) {
      if (site.verdict.provenance === "certified") continue;
      const key = baselineKey(site);
      observed.set(key, (observed.get(key) ?? 0) + 1);
    }

    const stale = REACT_KEY_PROVENANCE_BASELINE_V1
      .filter((entry) => !observed.has(baselineKey(entry)))
      .map((entry) => `${entry.file}  key={${entry.expression}} — gone; delete this entry`);
    expect(stale, "Baselined key sites that no longer exist. Shrink the ratchet.").toEqual([]);

    const drifted = REACT_KEY_PROVENANCE_BASELINE_V1
      .filter((entry) => observed.get(baselineKey(entry)) !== entry.sites)
      .map((entry) =>
        `${entry.file}  key={${entry.expression}} — baseline says ${entry.sites} site(s), `
          + `tree has ${observed.get(baselineKey(entry))}`);
    expect(
      drifted,
      "A copy of an already-audited uncertified key was added or removed. Copying an "
        + "unproven key to a second list is a new claim, not a covered one.",
    ).toEqual([]);
  });

  it("every baseline entry carries a written justification", () => {
    const empty = REACT_KEY_PROVENANCE_BASELINE_V1
      .filter((entry) => entry.why.trim().length < 40)
      .map((entry) => `${entry.file}  key={${entry.expression}}`);
    expect(empty, "A baseline entry with no real justification is an exemption.").toEqual([]);
  });
});

/**
 * Known-answer validation, both directions.
 *
 * The fixture is the exact JSX of `live-event-drawer.tsx` before and after B47
 * fixed BF-9 — the one instance of this defect class that is known to have been
 * real, and the one fix that is known to have closed it. It is inlined rather
 * than read from B47's `pre/` evidence directory so this test is self-contained
 * in the repo; B50 also ran the shipped classifier against both files on disk
 * (`gates/05-known-answer.log`).
 *
 * A guard that flags neither, or both, is not distinguishing anything.
 */
const PRE_FIX_DRAWER = `
export function ModelReceipts({ receipts }: { receipts: ModelReceiptView[] }) {
  return (
    <div>
      {receipts.map((receipt, index) => (
        <ModelReceiptCard key={receipt.slotId ?? \`receipt-\${index}\`} receipt={receipt} />
      ))}
    </div>
  );
}
`;

const POST_FIX_DRAWER = `
export function ModelReceipts({ events }: { events: LiveDrawerEvent[] }) {
  const receipts = keyedModelReceipts(events);
  return (
    <div>
      {receipts.map(({ key, receipt }) => (
        <ModelReceiptCard key={key} receipt={receipt} />
      ))}
    </div>
  );
}
`;

describe("React key provenance guard — known answer (BF-9 / B47)", () => {
  const flagged = (source: string) =>
    collectKeySites("components/console/live-event-drawer.tsx", source)
      .filter((site) => site.verdict.provenance !== "certified");

  it("flags the pre-fix key that produced BF-9's 873 duplicate-key errors", () => {
    const hits = flagged(PRE_FIX_DRAWER);
    expect(hits.map((hit) => hit.expression)).toEqual([
      "receipt.slotId ?? `receipt-${index}`",
    ]);
    expect(hits[0].verdict.reason).toContain("role-shaped id");
  });

  it("stays quiet on the fix B47 shipped", () => {
    expect(flagged(POST_FIX_DRAWER)).toEqual([]);
  });

  it("the role-name ledger is what makes the pre-fix key fail, and it is cited", () => {
    // Without `slotId` on the ledger, `.slotId` would pass as an instance id and
    // the known-answer test above would silently stop distinguishing anything.
    expect(ROLE_SHAPED_ID_NAMES.has("slotId")).toBe(true);
    expect(ROLE_SHAPED_ID_NAMES.get("slotId")).toContain("run-state.ts");
  });

  it("does not simply flag every property access", () => {
    // The other key in the same pre-fix file was already sound and must not be
    // swept up, or the guard would be measuring nothing.
    const sites = collectKeySites(
      "x.tsx",
      "const a = <ul>{rows.map((event) => <li key={event.key} />)}</ul>;",
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].verdict.provenance).toBe("certified");
  });
});

describe("React key provenance classifier — mechanism unit tests", () => {
  const verdictOf = (keyExpression: string) => {
    const sites = collectKeySites(
      "x.tsx",
      `const a = <ul>{rows.map((row, index) => <li key={${keyExpression}} />)}</ul>;`,
    );
    expect(sites).toHaveLength(1);
    return sites[0].verdict;
  };

  it("certifies a composite carrying a position component", () => {
    expect(verdictOf("`${row.name}:${index}`").provenance).toBe("certified");
    expect(verdictOf("`${row.name}:${String(index)}`").provenance).toBe("certified");
  });

  it("does not certify a composite of descriptive components alone", () => {
    expect(verdictOf("`${row.name}:${row.label}`").provenance).toBe("uncertified");
  });

  it("certifies a purpose-minted key and a `…Key()` mint", () => {
    expect(verdictOf("row.key").provenance).toBe("certified");
    expect(verdictOf("rowKey(row)").provenance).toBe("certified");
    expect(verdictOf("rowIdentity(row)").provenance).toBe("certified");
  });

  it("does not certify an arbitrary call", () => {
    expect(verdictOf("labelOf(row)").provenance).toBe("uncertified");
  });

  it("reports a bare loop index as `index`, not as certified", () => {
    expect(verdictOf("index").provenance).toBe("index");
    expect(verdictOf("i").provenance).toBe("index");
  });

  it("refuses descriptive properties — BF-9's class", () => {
    for (const expression of ["row.name", "row.label", "row.path", "row.type", "row.category"]) {
      expect(verdictOf(expression).provenance, expression).toBe("uncertified");
    }
  });

  it("is only as strong as the weakest branch of a fallback", () => {
    expect(verdictOf("row.id ?? row.name").provenance).toBe("uncertified");
    expect(verdictOf("row.name ?? row.id").provenance).toBe("uncertified");
    expect(verdictOf("row.id ?? row.otherId").provenance).toBe("certified");
    expect(verdictOf("row.ok ? row.name : row.id").provenance).toBe("uncertified");
  });

  it("fails closed on an expression shape it has an explicit rule for", () => {
    expect(verdictOf("row!.tags[0]").provenance).toBe("uncertified");
    expect(verdictOf("(() => row.name)()").provenance).toBe("uncertified");
  });

  it("fails closed on an expression shape it has NO rule for", () => {
    // These reach the classifier's catch-all rather than any named branch.
    // B50's first mutant pass had no test here and a fail-open catch-all
    // survived: `row!.tags[0]` is an element access and `(() => …)()` is a
    // call, so both were caught by explicit rules and the catch-all was never
    // exercised. Anything genuinely unmodelled must still refuse.
    expect(verdictOf("sql`${row.name}`").provenance).toBe("uncertified"); // tagged template
    expect(verdictOf("-index").provenance).toBe("uncertified"); // prefix unary
    expect(verdictOf("typeof row").provenance).toBe("uncertified"); // typeof
    expect(verdictOf("[row.id, index].length").provenance).toBe("uncertified"); // array literal receiver
  });

  it("classifies a raw expression through the exported entry point too", () => {
    // `classifyKeyExpression` is exported for tooling; keep it wired.
    expect(typeof classifyKeyExpression).toBe("function");
  });
});
