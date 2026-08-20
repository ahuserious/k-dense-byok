/**
 * Public surface of the Lean 4 proof renderer (lane F4, matrix row 10).
 *
 * Dest Console, lane F6's node inspector, and lane F11's `lean4-prover`
 * skill surface all import from HERE. Dest apply is INTEGRATION.md §2.
 * The props type is the contract published in `interfaces/F4-lean4.md`;
 * the wire types live in `@/lib/lean4-proof`. Do not take F6 files.
 */
export {
  Lean4ProofArtifact,
  type Lean4ProofArtifactProps,
} from "./lean4-proof-artifact";
export {
  Lean4ProofsPanel,
  type Lean4ProofsPanelProps,
} from "./lean4-proofs-panel";
