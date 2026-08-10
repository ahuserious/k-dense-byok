import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONALITY_STORE_REF,
  assertPersonalityStoreIsPiInvisible,
  installPersonalityStoreFromDirectory,
  loadPersonalityStore,
  loadPersonalityStoreSnapshot,
  personalityContentManifestDigest,
  readScientificPersonalities,
  selectBestPersonalities,
} from "../src/personality-store/store.ts";
import { PERSONALITY_STORE_REPO } from "../src/config.ts";

const temporaryRoots: string[] = [];
const FIXTURE_COMMIT = "a".repeat(40);

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-personality-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeProfile(source: string, ref: string, title: string, body: string): void {
  const directory = path.join(source, "scientific-agents", ref);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "AGENTS.md"), `# ${title}\n\n${body}\n`);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Pi-invisible personality store", () => {
  it("uses the dedicated ahuserious scientific-agents source", () => {
    expect(PERSONALITY_STORE_REPO).toBe("ahuserious/scientific-agents");
  });

  it("installs ahuserious scientific profiles outside every Pi-visible root", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    const store = path.join(root, "server-only-store");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "AGENTS.md"), "# Repository instructions\n");
    writeProfile(source, "bioinformatician", "Bioinformatician", "Audit sequence alignment and genomics data.");
    writeProfile(source, "statistician", "Statistician", "Check estimands, uncertainty, and statistical power.");
    const pin = {
      source: "ahuserious/scientific-agents",
      commit: FIXTURE_COMMIT,
      manifestSha256: personalityContentManifestDigest(readScientificPersonalities(source)),
    };

    const installed = installPersonalityStoreFromDirectory({
      sourceDir: source,
      pin,
      storeDir: store,
    });

    expect(installed.storeRef).toBe(DEFAULT_PERSONALITY_STORE_REF);
    expect(installed.source).toBe("ahuserious/scientific-agents");
    expect(installed.personalities.map((personality) => personality.ref)).toEqual([
      "bioinformatician",
      "statistician",
    ]);
    expect(loadPersonalityStore(DEFAULT_PERSONALITY_STORE_REF, store, pin)).toEqual(installed);
    expect(fs.existsSync(path.join(store, ".pi"))).toBe(false);
    expect(fs.readdirSync(store).sort()).toEqual(["current.json", "snapshots"]);
  });

  it("fails closed when installed content does not match the pinned manifest digest", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    writeProfile(source, "genomics", "Genomics Scientist", "Audit genome evidence.");

    expect(() => installPersonalityStoreFromDirectory({
      sourceDir: source,
      storeDir: path.join(root, "server-only-store"),
      pin: {
        source: "ahuserious/scientific-agents",
        commit: FIXTURE_COMMIT,
        manifestSha256: "0".repeat(64),
      },
    })).toThrow(/content-manifest digest mismatch/);
  });

  it("retains historical commit provenance when an explicit pin update has identical content", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    const store = path.join(root, "server-only-store");
    fs.mkdirSync(source, { recursive: true });
    writeProfile(source, "genomics", "Genomics Scientist", "Audit genome evidence.");
    const manifestSha256 = personalityContentManifestDigest(readScientificPersonalities(source));
    const firstPin = {
      source: "ahuserious/scientific-agents",
      commit: "a".repeat(40),
      manifestSha256,
    };
    const secondPin = { ...firstPin, commit: "b".repeat(40) };

    installPersonalityStoreFromDirectory({ sourceDir: source, storeDir: store, pin: firstPin });
    installPersonalityStoreFromDirectory({ sourceDir: source, storeDir: store, pin: secondPin });

    expect(loadPersonalityStore(DEFAULT_PERSONALITY_STORE_REF, store, secondPin).revision)
      .toBe(secondPin.commit);
    expect(loadPersonalityStoreSnapshot(
      DEFAULT_PERSONALITY_STORE_REF,
      manifestSha256,
      store,
      { source: firstPin.source, revision: firstPin.commit, refs: ["genomics"] },
    ).revision).toBe(firstPin.commit);
  });

  it("fails closed for every store location under a Pi/global or project-visible root", () => {
    const root = temporaryRoot();
    const piAgentRoot = path.join(root, "pi-agent");
    const projectsRoot = path.join(root, "projects");
    expect(() => assertPersonalityStoreIsPiInvisible(
      path.join(piAgentRoot, "personalities"),
      [piAgentRoot, projectsRoot],
    )).toThrow(/overlaps Pi-visible root/);
    expect(() => assertPersonalityStoreIsPiInvisible(
      path.join(projectsRoot, "default", "sandbox", ".kady", "personalities"),
      [piAgentRoot, projectsRoot],
    )).toThrow(/overlaps Pi-visible root/);
    expect(() => assertPersonalityStoreIsPiInvisible(
      path.join(root, ".pi", "personalities"),
      [piAgentRoot, projectsRoot],
    )).toThrow(/\.pi directory/);
    expect(() => assertPersonalityStoreIsPiInvisible(
      path.join(root, "personality-store"),
      [piAgentRoot, projectsRoot],
    )).not.toThrow();
  });

  it("selects the best n task-matched personalities independently of model count", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      storeRef: DEFAULT_PERSONALITY_STORE_REF,
      source: "ahuserious/scientific-agents",
      revision: FIXTURE_COMMIT,
      digest: "0".repeat(64),
      personalities: [
        { ref: "genomics", title: "Genomics Scientist", instructions: "genome sequencing variants alignment" },
        { ref: "statistician", title: "Statistician", instructions: "power uncertainty estimand" },
        { ref: "chemist", title: "Chemist", instructions: "molecules synthesis assay" },
      ],
    };
    expect(selectBestPersonalities("Audit genome variant alignment uncertainty", 2, snapshot)
      .map((personality) => personality.ref)).toEqual(["genomics", "statistician"]);
    expect(selectBestPersonalities(
      "Audit genome variant alignment uncertainty",
      1,
      snapshot,
      ["chemist", "statistician"],
    ).map((personality) => personality.ref)).toEqual(["statistician"]);
  });
});
