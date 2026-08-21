import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Lean4ProofArtifact } from "./lean4-proof-artifact";
import type { Lean4ProofReceipt, Lean4ProofSource } from "@/lib/lean4-proof";

const MATHLIB_REVISION = "4d1f6e2a9c3b8705ef2213a4c65d90bb17e4f0aa";
const MATHLIB_TREE = "9b7c05e1d24f38a6be0913cc74d5f28a6e11b3d0";

function receipt(overrides: Partial<Lean4ProofReceipt> = {}): Lean4ProofReceipt {
  const runId = overrides.runId ?? "wrun_f4proof";
  const executionId = overrides.executionId ?? "exec_lean_1";
  const directory = `workflow_artifacts/dag-workflows/lean/${runId}/${executionId}`;
  return {
    runId,
    nodeId: "lean-proof",
    nodeName: "Lean proof",
    executionId,
    attempt: 1,
    executionStatus: "succeeded",
    status: "verified",
    summary: "Lean accepted the reviewed theorem with no sorry and no extra axioms.",
    mode: "verify",
    mathlibRequested: true,
    theoremName: "kady_reflexive",
    normalizedStatement: "theorem kady_reflexive (n : Nat) : n = n",
    executionPolicy: "unsandboxed-opt-in",
    toolchain: "leanprover/lean4:v4.19.0",
    mathlibRevision: MATHLIB_REVISION,
    mathlibTree: MATHLIB_TREE,
    assumptions: ["propext", "Classical.choice"],
    translationGaps: [],
    artifacts: [
      {
        kind: "proof",
        path: `${directory}/Proof.lean`,
        size: 128,
        sha256: "a".repeat(64),
        mediaType: "text/x-lean",
      },
      {
        kind: "log",
        path: `${directory}/verification.log`,
        size: 512,
        sha256: "b".repeat(64),
        mediaType: "text/plain",
      },
    ],
    proofPath: `${directory}/Proof.lean`,
    logPath: `${directory}/verification.log`,
    provenanceGap: "none",
    error: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_030_000,
    ...overrides,
  };
}

function source(overrides: Partial<Lean4ProofSource> = {}): Lean4ProofSource {
  const base = receipt();
  return {
    runId: base.runId,
    executionId: base.executionId,
    artifact: "proof",
    path: base.proofPath!,
    size: 128,
    sha256: "a".repeat(64),
    truncated: false,
    text: "theorem kady_reflexive (n : Nat) : n = n := rfl\n",
    ...overrides,
  };
}

describe("Lean4ProofArtifact", () => {
  it("renders the mathlib revision and tree verbatim beside the verified status", () => {
    render(<Lean4ProofArtifact receipt={receipt()} />);

    const region = screen.getByRole("region", { name: "Lean 4 proof" });
    expect(within(region).getByText("Verified")).toBeInTheDocument();
    // Verbatim, not abbreviated: a 12-character prefix is not checkable provenance.
    expect(within(region).getByText(MATHLIB_REVISION)).toBeInTheDocument();
    expect(within(region).getByText(MATHLIB_TREE)).toBeInTheDocument();
    expect(within(region).getByText("Mathlib revision")).toBeInTheDocument();
    expect(within(region).getByText("Mathlib tree")).toBeInTheDocument();
    expect(within(region).getByText("leanprover/lean4:v4.19.0")).toBeInTheDocument();
    expect(within(region).getByText("kady_reflexive")).toBeInTheDocument();
    expect(within(region).getByText("unsandboxed-opt-in")).toBeInTheDocument();
    expect(within(region).getByText(`${"a".repeat(64)}`)).toBeInTheDocument();
    expect(within(region).getByText(`${"b".repeat(64)}`)).toBeInTheDocument();
  });

  it("states status with a word as well as a colour, for every display state", () => {
    const cases: Array<[Partial<Lean4ProofReceipt>, string]> = [
      [{ status: "verified" }, "Verified"],
      [{ status: "failed" }, "Rejected"],
      [{ status: "unavailable" }, "Unavailable"],
      [{ status: null, executionStatus: "failed" }, "Errored"],
      [{ status: null, executionStatus: "running" }, "Running"],
      [{ status: null, executionStatus: "pending" }, "Pending"],
    ];
    for (const [overrides, label] of cases) {
      const { unmount } = render(<Lean4ProofArtifact receipt={receipt(overrides)} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders the loading, empty and error states without a receipt", () => {
    const { rerender } = render(<Lean4ProofArtifact receipt={null} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the Lean proof receipt…");

    rerender(<Lean4ProofArtifact receipt={null} />);
    expect(
      screen.getByText("This run executed no Lean 4 node, so there is no proof artifact."),
    ).toBeInTheDocument();

    rerender(<Lean4ProofArtifact receipt={null} error="No such workflow run: wrun_missing" />);
    expect(screen.getByText("No such workflow run: wrun_missing")).toBeInTheDocument();
  });

  it("warns when a verified receipt is missing a host-owned artifact or its mathlib pin", () => {
    render(
      <Lean4ProofArtifact
        receipt={receipt({
          logPath: null,
          artifacts: [receipt().artifacts[0]],
          mathlibRevision: null,
          mathlibTree: null,
          provenanceGap: "discarded-on-failure",
        })}
      />,
    );
    expect(
      screen.getByText(/does not carry both host-owned artifacts/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/accepted without a complete Mathlib pin/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("not recorded").length).toBeGreaterThanOrEqual(2);
  });

  it("says the runtime dropped the mathlib pin rather than blaming the verifier", () => {
    render(
      <Lean4ProofArtifact
        receipt={receipt({
          status: "failed",
          summary: "Trusted Lean verification returned failed.",
          mathlibRevision: null,
          mathlibTree: null,
          provenanceGap: "discarded-on-failure",
          executionStatus: "failed",
          error: {
            code: "WORKFLOW_LEAN_VERIFICATION_FAILED",
            message: "Trusted Lean verification returned failed.",
          },
        })}
      />,
    );
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The run stored no verifier output for this attempt, so the Mathlib pin the verifier reported was not retained.",
      ),
    ).toBeInTheDocument();
    // The receipts themselves survive a rejection, so the proof is still openable.
    expect(screen.getByText(/Proof\.lean$/)).toBeInTheDocument();
    // A verified-only warning must NOT appear on a rejection.
    expect(screen.queryByText(/accepted without a complete Mathlib pin/)).toBeNull();
  });

  it("loads an artifact through the mounting surface and renders its text", async () => {
    const user = userEvent.setup();
    const onRequestSource = vi.fn();
    const { rerender } = render(
      <Lean4ProofArtifact receipt={receipt()} onRequestSource={onRequestSource} />,
    );

    const proofButton = screen.getByRole("button", { name: "Proof source" });
    expect(proofButton).toHaveAttribute("aria-expanded", "false");
    await user.click(proofButton);
    expect(onRequestSource).toHaveBeenCalledWith("proof");

    rerender(
      <Lean4ProofArtifact
        receipt={receipt()}
        onRequestSource={onRequestSource}
        source={source()}
      />,
    );
    expect(
      screen.getByLabelText("Proof source for execution exec_lean_1"),
    ).toHaveTextContent("theorem kady_reflexive (n : Nat) : n = n := rfl");
    expect(screen.getByRole("button", { name: "Proof source" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("renders both source controls DISABLED with an honest reason when nothing can fetch", () => {
    render(<Lean4ProofArtifact receipt={receipt()} />);
    const proofButton = screen.getByRole("button", { name: "Proof source" });
    const logButton = screen.getByRole("button", { name: "Verification log" });
    expect(proofButton).toBeDisabled();
    expect(logButton).toBeDisabled();
    expect(proofButton).toHaveAttribute(
      "title",
      "This surface cannot fetch artifact text; mount the renderer with onRequestSource to enable it.",
    );
  });

  it("disables only the control whose receipt is absent", () => {
    render(
      <Lean4ProofArtifact
        receipt={receipt({ logPath: null, artifacts: [receipt().artifacts[0]] })}
        onRequestSource={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Proof source" })).toBeEnabled();
    const logButton = screen.getByRole("button", { name: "Verification log" });
    expect(logButton).toBeDisabled();
    expect(logButton).toHaveAttribute(
      "title",
      "No verification.log receipt was recorded for this attempt.",
    );
  });

  it("reaches the source controls and the source region by keyboard alone", async () => {
    const user = userEvent.setup();
    render(
      <Lean4ProofArtifact
        receipt={receipt()}
        onRequestSource={vi.fn()}
        source={source()}
      />,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Proof source" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Verification log" })).toHaveFocus();
    await user.tab();
    // The scrollable proof region is in the tab order, so a keyboard user can
    // scroll a long proof without a pointer.
    expect(screen.getByLabelText("Proof source for execution exec_lean_1")).toHaveFocus();
  });

  it("renders a malformed receipt as an honest state instead of throwing", () => {
    const malformed = {
      ...receipt(),
      // Every one of these is a shape the server would refuse, arriving anyway.
      status: "bogus-status",
      executionStatus: "who-knows",
      // Not arrays at all — the shape a non-F4 caller is most likely to send.
      assumptions: null,
      translationGaps: "propext",
      artifacts: undefined,
      error: "not an error object",
      proofPath: null,
      logPath: null,
      summary: null,
      theoremName: null,
      normalizedStatement: null,
      toolchain: null,
      executionPolicy: null,
      mathlibRevision: null,
      mathlibTree: null,
    } as unknown as Lean4ProofReceipt;

    expect(() => render(<Lean4ProofArtifact receipt={malformed} />)).not.toThrow();
    expect(screen.getByText("Errored")).toBeInTheDocument();
    expect(
      screen.getByText("No artifact receipt was recorded for this attempt."),
    ).toBeInTheDocument();
  });

  it("keeps a long single-line proof inside a bounded scroll region and says it is truncated", async () => {
    const user = userEvent.setup();
    const longProof = `theorem long : ${"a + ".repeat(4_000)}0 = 0 := by simp\n`;
    render(
      <Lean4ProofArtifact
        receipt={receipt()}
        onRequestSource={vi.fn()}
        source={source({ text: longProof, size: longProof.length * 4, truncated: true })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Proof source" }));
    const pre = screen.getByLabelText("Proof source for execution exec_lean_1");
    expect(pre.textContent).toHaveLength(longProof.length);
    // Bounded height plus its own scroll container: a 16 000-character single
    // line cannot widen the surface that mounts the renderer.
    expect(pre.className).toContain("max-h-64");
    expect(pre.className).toContain("overflow-auto");
    expect(pre.className).toContain("min-w-0");
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument();
  });

  /**
   * The Gate D / e2e bridge. `e2e/wave-f/f4/lean4-proof-artifact.fixture.html`
   * is the REAL component's real markup, and the browser spec in
   * `e2e/wave-f/f4/` renders exactly that against the running app's own
   * compiled stylesheet. Asserting equality here is what stops the two from
   * drifting: change the renderer and this fails until the fixture is
   * regenerated with `UPDATE_LEAN4_FIXTURE=1 npx vitest run src/components/lean4`.
   */
  it("matches the committed browser fixture, and adds no raw colour literal", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Lean4ProofArtifact
        receipt={receipt()}
        onRequestSource={() => {}}
        source={source()}
      />,
    );
    // The fixture captures the renderer with the proof source OPEN, because
    // that is the state the browser spec walks by keyboard and screenshots.
    await user.click(screen.getByRole("button", { name: "Proof source" }));
    const markup = container.innerHTML;
    expect(markup).toContain(MATHLIB_REVISION);
    expect(markup).toContain(MATHLIB_TREE);
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(/);
    expect(markup).not.toMatch(/\bhsla?\(/);

    const fixturePath = path.resolve(
      process.cwd(),
      "../e2e/wave-f/f4/lean4-proof-artifact.fixture.html",
    );
    if (process.env.UPDATE_LEAN4_FIXTURE === "1") {
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, `${markup}\n`, "utf-8");
    }
    expect(fs.readFileSync(fixturePath, "utf-8").trimEnd()).toBe(markup);
  });
});
