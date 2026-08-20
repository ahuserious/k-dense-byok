import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Lean4ProofsPanel } from "./lean4-proofs-panel";
import {
  Lean4ApiError,
  type Lean4ProofListResponse,
  type Lean4ProofReceipt,
} from "@/lib/lean4-proof";

const listLean4RunProofs = vi.fn();
const readLean4ProofSource = vi.fn();

vi.mock("@/lib/lean4-proof", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lean4-proof")>(
    "@/lib/lean4-proof",
  );
  return {
    ...actual,
    listLean4RunProofs: (...args: unknown[]) => listLean4RunProofs(...args),
    readLean4ProofSource: (...args: unknown[]) => readLean4ProofSource(...args),
  };
});

const MATHLIB_REVISION = "4d1f6e2a9c3b8705ef2213a4c65d90bb17e4f0aa";
const MATHLIB_TREE = "9b7c05e1d24f38a6be0913cc74d5f28a6e11b3d0";

function receipt(overrides: Partial<Lean4ProofReceipt> = {}): Lean4ProofReceipt {
  return {
    runId: "wrun_f4proof",
    nodeId: "lean-proof",
    nodeName: "Lean proof",
    executionId: "exec_lean_1",
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
    assumptions: [],
    translationGaps: [],
    artifacts: [],
    proofPath: "workflow_artifacts/dag-workflows/lean/wrun_f4proof/exec_lean_1/Proof.lean",
    logPath: "workflow_artifacts/dag-workflows/lean/wrun_f4proof/exec_lean_1/verification.log",
    provenanceGap: "none",
    error: null,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  };
}

function listResponse(
  proofs: Lean4ProofReceipt[],
): Lean4ProofListResponse {
  return {
    runId: "wrun_f4proof",
    runStatus: "succeeded",
    workflowId: "wf_lean",
    truncated: false,
    proofs,
  };
}

describe("Lean4ProofsPanel", () => {
  beforeEach(() => {
    listLean4RunProofs.mockReset();
    readLean4ProofSource.mockReset();
  });

  it("hosts Lean4ProofArtifact and shows the Mathlib pin from the run receipt", async () => {
    listLean4RunProofs.mockResolvedValue(listResponse([receipt()]));
    render(<Lean4ProofsPanel projectId="default" runId="wrun_f4proof" />);

    const panel = await screen.findByTestId("lean4-proofs-panel");
    expect(listLean4RunProofs).toHaveBeenCalledWith("default", "wrun_f4proof");
    expect(panel).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Lean 4 proof" })).toBeInTheDocument();
    expect(screen.getByText(MATHLIB_REVISION)).toBeInTheDocument();
    expect(screen.getByText(MATHLIB_TREE)).toBeInTheDocument();
  });

  it("states a wired miss when the run is absent", async () => {
    listLean4RunProofs.mockRejectedValue(
      new Lean4ApiError(404, "No such workflow run: wrun_missing", "LEAN4_RUN_NOT_FOUND"),
    );
    render(<Lean4ProofsPanel projectId="default" runId="wrun_missing" />);

    await waitFor(() => {
      expect(screen.getByText(/LEAN4_RUN_NOT_FOUND/)).toBeInTheDocument();
    });
  });
});
