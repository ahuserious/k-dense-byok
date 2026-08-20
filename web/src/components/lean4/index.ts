/**
 * Public surface of the Lean 4 proof renderer (lane F4, matrix row 10).
 *
 * Lane F6's node inspector and lane F11's `lean4-prover` skill surface both
 * import from HERE. The props type is the contract published in
 * `interfaces/F4-lean4.md`; the wire types live in `@/lib/lean4-proof`.
 */
export {
  Lean4ProofArtifact,
  type Lean4ProofArtifactProps,
} from "./lean4-proof-artifact";
