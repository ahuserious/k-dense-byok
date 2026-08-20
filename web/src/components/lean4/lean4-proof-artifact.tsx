"use client";

/**
 * THE proof renderer. There is exactly one.
 *
 * Matrix row 10 (lane F4) and row 45 (lane F11, the `lean4-prover` skill)
 * share this surface; lane F6's node inspector mounts it. Its props are a
 * published contract (`interfaces/F4-lean4.md`), not an internal detail — if a
 * second component ever renders a `proof` artifact, one of the two is wrong and
 * it is not this one.
 *
 * What it insists on showing, because row 10 asks for provenance and a proof
 * without provenance is a screenshot of a claim:
 *   - the pinned **Mathlib revision** and **Mathlib tree** the verifier ran
 *     against, verbatim and copy-selectable, never abbreviated on their own;
 *   - both host-owned receipts (`Proof.lean`, `verification.log`) with their
 *     sha256, and an explicit warning when the pair is incomplete;
 *   - an honest disabled state, with the reason, for anything that is not bound.
 *
 * Design constraints it is written to (§6.5 and Gate D):
 *   - Tokens only. No raw hex/rgb/hsl anywhere in this file.
 *   - shadcn primitives from `components/ui`, composed, never forked.
 *   - No effects: no gradients, no hover-driven expansion, no motion of its own.
 *   - Status is never colour alone: every state carries an icon AND a word.
 *   - Nothing is stated through `opacity`.
 *
 * The `transition-none` on the source controls is not cosmetic: the shadcn
 * `Button` carries `transition-all`, which ANIMATES the focus outline's colour.
 * A focus indicator that fades in is an effect (§6.5), and it also makes the
 * indicator unmeasurable — the browser spec caught it reading a half-blended
 * colour, 5.12:1 on one run and 18.63:1 on the next for the same pixel.
 *
 * One deliberate departure, with the numbers behind it: the focus indicator is
 * a 2px `--foreground` outline, not the `--ring` token. `--foreground` on
 * `--card` MEASURES **19.8:1 light / 17.18:1 dark** in a live preview
 * (`e2e/wave-f/f4/lean4-proof-renderer.spec.ts`). `--ring` on `--card` COMPUTES
 * to **2.59:1 in light** from the declared tokens in `globals.css`
 * (`oklch(0.708 0 0)` on `oklch(1 0 0)`) — below the 3:1 floor for a non-text
 * UI indicator. Both are tokens; only one is legible. (The shadcn `Button`
 * primitive is composed, not forked: the outline is added through `className`
 * on top of its own `focus-visible` ring, which stays.)
 */

import { useId, useState } from "react";
import {
  AlertTriangleIcon,
  BadgeCheckIcon,
  CircleSlashIcon,
  ClockIcon,
  FileTextIcon,
  OctagonXIcon,
  ScrollTextIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  lean4DisplayState,
  lean4MissingProvenanceReason,
  lean4ProvenanceComplete,
  lean4ReceiptPairComplete,
  shortGitObjectId,
  type Lean4ArtifactKind,
  type Lean4DisplayState,
  type Lean4ProofReceipt,
  type Lean4ProofSource,
} from "@/lib/lean4-proof";

export interface Lean4ProofArtifactProps {
  /** The projected receipt from `GET /lean4/runs/:runId/proofs`. `null` renders the empty state. */
  receipt: Lean4ProofReceipt | null;
  /** Fetched artifact text, when the mounting surface has loaded one. */
  source?: Lean4ProofSource | null;
  /** The receipt request is in flight. */
  loading?: boolean;
  /** The source request is in flight. */
  sourceLoading?: boolean;
  /** A receipt-level failure message, already safe to display. */
  error?: string | null;
  /** A source-level failure message, already safe to display. */
  sourceError?: string | null;
  /**
   * Ask the mounting surface to load an artifact's text. Omit it and both
   * source controls render DISABLED with an honest reason, which is the correct
   * rendering for a surface that cannot fetch (Gate B: an unbindable control is
   * disabled and says why, it is not hidden and it is not a lie).
   */
  onRequestSource?: (artifact: Lean4ArtifactKind) => void;
  /** Copy for the empty state, when a run simply has no Lean node. */
  emptyLabel?: string;
  className?: string;
}

interface DisplayStateCopy {
  label: string;
  description: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
  Icon: typeof BadgeCheckIcon;
}

const DISPLAY_STATE_COPY: Record<Lean4DisplayState, DisplayStateCopy> = {
  verified: {
    label: "Verified",
    description: "The trusted Lean verifier accepted this proof.",
    badgeVariant: "default",
    Icon: BadgeCheckIcon,
  },
  failed: {
    label: "Rejected",
    description: "The trusted Lean verifier rejected this proof.",
    badgeVariant: "destructive",
    Icon: OctagonXIcon,
  },
  unavailable: {
    label: "Unavailable",
    description:
      "The Lean toolchain or the pinned Mathlib checkout was unavailable, so nothing was verified.",
    badgeVariant: "outline",
    Icon: CircleSlashIcon,
  },
  errored: {
    label: "Errored",
    description: "The node failed before the trusted verifier returned a receipt.",
    badgeVariant: "destructive",
    Icon: AlertTriangleIcon,
  },
  running: {
    label: "Running",
    description: "The Lean node is still executing. No receipt exists yet.",
    badgeVariant: "secondary",
    Icon: ClockIcon,
  },
  pending: {
    label: "Pending",
    description: "The Lean node has not started. No receipt exists yet.",
    badgeVariant: "secondary",
    Icon: ClockIcon,
  },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A dense unadorned label/value row. Secondary text is a token colour, not an opacity. */
function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-0.5 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs break-words text-foreground">{children}</dd>
    </div>
  );
}

function MissingValue({ reason }: { reason: string }) {
  return (
    <span className="text-xs text-muted-foreground" title={reason}>
      not recorded
    </span>
  );
}

/**
 * A git object id, shown in full and selectable. The abbreviated form is
 * additional, never a replacement: a 12-character prefix is not provenance you
 * can check a checkout against.
 */
function GitObjectId({ value }: { value: string }) {
  const abbreviated = shortGitObjectId(value);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <code className="font-mono text-xs break-all text-foreground">{value}</code>
      {abbreviated !== value ? (
        <span className="text-xs text-muted-foreground">({abbreviated})</span>
      ) : null}
    </span>
  );
}

function Shell({
  className,
  children,
  labelledBy,
}: {
  className?: string;
  children: React.ReactNode;
  labelledBy: string;
}) {
  return (
    <section
      data-slot="lean4-proof-artifact"
      aria-labelledby={labelledBy}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border border-border bg-card p-3 text-card-foreground",
        className,
      )}
    >
      {children}
    </section>
  );
}

function StatusNotice({
  tone,
  children,
}: {
  tone: "warning" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs",
        tone === "warning" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

export function Lean4ProofArtifact({
  receipt,
  source = null,
  loading = false,
  sourceLoading = false,
  error = null,
  sourceError = null,
  onRequestSource,
  emptyLabel = "This run executed no Lean 4 node, so there is no proof artifact.",
  className,
}: Lean4ProofArtifactProps) {
  const headingId = useId();
  const sourceRegionId = useId();
  const [openArtifact, setOpenArtifact] = useState<Lean4ArtifactKind | null>(null);

  const heading = (
    <h3 id={headingId} className="text-sm font-medium text-foreground">
      Lean 4 proof
    </h3>
  );

  if (error) {
    return (
      <Shell className={className} labelledBy={headingId}>
        {heading}
        <StatusNotice tone="warning">{error}</StatusNotice>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell className={className} labelledBy={headingId}>
        {heading}
        <p role="status" className="text-xs text-muted-foreground">
          Loading the Lean proof receipt…
        </p>
      </Shell>
    );
  }

  if (!receipt) {
    return (
      <Shell className={className} labelledBy={headingId}>
        {heading}
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      </Shell>
    );
  }

  // A malformed receipt renders an honest state; it never throws (#62, #71).
  // The server validates before serialising, so these coercions only matter
  // when something OTHER than the F4 endpoint supplies the prop — which is
  // exactly the case a published contract has to survive.
  const assumptions = Array.isArray(receipt.assumptions) ? receipt.assumptions : [];
  const translationGaps = Array.isArray(receipt.translationGaps)
    ? receipt.translationGaps
    : [];
  const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
  const receiptError = receipt.error && typeof receipt.error.code === "string"
    ? receipt.error
    : null;

  const state = lean4DisplayState(receipt);
  const copy = DISPLAY_STATE_COPY[state] ?? DISPLAY_STATE_COPY.errored;
  const { Icon } = copy;
  const provenanceComplete = lean4ProvenanceComplete(receipt);
  const missingProvenanceReason = lean4MissingProvenanceReason(receipt);
  const receiptPairComplete = lean4ReceiptPairComplete(receipt);
  const sourceDisabledReason = onRequestSource
    ? null
    : "This surface cannot fetch artifact text; mount the renderer with onRequestSource to enable it.";

  const requestArtifact = (artifact: Lean4ArtifactKind) => {
    setOpenArtifact(artifact);
    onRequestSource?.(artifact);
  };

  const visibleSource = openArtifact && source?.artifact === openArtifact ? source : null;

  return (
    <Shell className={className} labelledBy={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <Badge variant={copy.badgeVariant} className="gap-1">
          <Icon aria-hidden="true" className="size-3" />
          {copy.label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {receipt.mode === "solve" ? "solve mode" : "verify mode"}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{receipt.summary ?? copy.description}</p>

      {state === "verified" && !receiptPairComplete ? (
        <StatusNotice tone="warning">
          This receipt claims a verified proof but does not carry both host-owned artifacts. The
          runner never records that combination — treat the result as untrusted.
        </StatusNotice>
      ) : null}

      {receiptError ? (
        <StatusNotice tone="warning">
          {receiptError.code}: {receiptError.message}
        </StatusNotice>
      ) : null}

      <Separator />

      <dl className="min-w-0 divide-y divide-border">
        <DetailRow label="Theorem">
          {receipt.theoremName ? (
            <code className="font-mono text-xs break-all">{receipt.theoremName}</code>
          ) : (
            <MissingValue reason="The verifier reported no theorem name for this attempt." />
          )}
        </DetailRow>
        <DetailRow label="Statement">
          {receipt.normalizedStatement ? (
            <code className="font-mono text-xs break-words whitespace-pre-wrap">
              {receipt.normalizedStatement}
            </code>
          ) : (
            <MissingValue reason="The verifier reported no normalized statement for this attempt." />
          )}
        </DetailRow>
        <DetailRow label="Toolchain">
          {receipt.toolchain ? (
            <code className="font-mono text-xs break-all">{receipt.toolchain}</code>
          ) : (
            <MissingValue reason="No Lean toolchain identity reached the receipt." />
          )}
        </DetailRow>
        <DetailRow label="Mathlib">
          {receipt.mathlibRequested ? "requested by the node" : "not requested by the node"}
        </DetailRow>
        <DetailRow label="Mathlib revision">
          {receipt.mathlibRevision ? (
            <GitObjectId value={receipt.mathlibRevision} />
          ) : (
            <MissingValue reason={missingProvenanceReason} />
          )}
        </DetailRow>
        <DetailRow label="Mathlib tree">
          {receipt.mathlibTree ? (
            <GitObjectId value={receipt.mathlibTree} />
          ) : (
            <MissingValue reason={missingProvenanceReason} />
          )}
        </DetailRow>
        <DetailRow label="Execution policy">
          {receipt.executionPolicy ?? (
            <MissingValue reason="No execution policy reached the receipt." />
          )}
        </DetailRow>
      </dl>

      {state === "verified" && !provenanceComplete ? (
        <StatusNotice tone="warning">
          This proof was accepted without a complete Mathlib pin. Its provenance cannot be checked
          against a checkout.
        </StatusNotice>
      ) : null}

      {receipt.provenanceGap === "discarded-on-failure" && !provenanceComplete ? (
        <StatusNotice tone="neutral">{missingProvenanceReason}</StatusNotice>
      ) : null}

      {assumptions.length > 0 ? (
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Assumptions</p>
          <ul className="mt-0.5 list-inside list-disc text-xs break-words text-foreground">
            {assumptions.map((assumption, index) => (
              <li key={`${String(index)}-${assumption}`}>{assumption}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {translationGaps.length > 0 ? (
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Translation gaps</p>
          <ul className="mt-0.5 list-inside list-disc text-xs break-words text-foreground">
            {translationGaps.map((gap, index) => (
              <li key={`${String(index)}-${gap}`}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Separator />

      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">Host-owned artifacts</p>
        {artifacts.length === 0 ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            No artifact receipt was recorded for this attempt.
          </p>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-1">
            {artifacts.map((artifact) => (
              <li key={artifact.path} className="min-w-0 text-xs">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {artifact.kind === "proof" ? (
                    <FileTextIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
                  ) : (
                    <ScrollTextIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
                  )}
                  <code className="font-mono break-all text-foreground">{artifact.path}</code>
                  <span className="text-muted-foreground">{formatBytes(artifact.size)}</span>
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  sha256{" "}
                  {artifact.sha256 ? (
                    <code className="font-mono break-all">{artifact.sha256}</code>
                  ) : (
                    "not recorded"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["proof", "log"] as const).map((artifact) => {
          const available = artifact === "proof" ? receipt.proofPath : receipt.logPath;
          const disabledReason = sourceDisabledReason ??
            (available
              ? null
              : `No ${artifact === "proof" ? "Proof.lean" : "verification.log"} receipt was recorded for this attempt.`);
          return (
            <Button
              key={artifact}
              type="button"
              size="sm"
              variant={openArtifact === artifact ? "secondary" : "outline"}
              disabled={disabledReason !== null}
              aria-expanded={openArtifact === artifact}
              aria-controls={sourceRegionId}
              title={disabledReason ?? undefined}
              className="h-7 text-xs transition-none focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--foreground)]"
              onClick={() => requestArtifact(artifact)}
            >
              {artifact === "proof" ? "Proof source" : "Verification log"}
            </Button>
          );
        })}
        {sourceDisabledReason ? (
          <span className="text-xs text-muted-foreground">{sourceDisabledReason}</span>
        ) : null}
      </div>

      <div id={sourceRegionId} className="min-w-0">
        {sourceError ? (
          <StatusNotice tone="warning">{sourceError}</StatusNotice>
        ) : sourceLoading ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading artifact text…
          </p>
        ) : visibleSource ? (
          <div className="min-w-0">
            <pre
              tabIndex={0}
              aria-label={`${visibleSource.artifact === "proof" ? "Proof source" : "Verification log"} for execution ${receipt.executionId}`}
              className="max-h-64 min-w-0 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-xs whitespace-pre text-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--foreground)]"
            >
              {visibleSource.text}
            </pre>
            {visibleSource.truncated ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Showing the first {formatBytes(visibleSource.text.length)} of{" "}
                {formatBytes(visibleSource.size)}. The full artifact is on disk at{" "}
                <code className="font-mono break-all">{visibleSource.path}</code>.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Separator />

      <p className="text-xs break-all text-muted-foreground">
        node {receipt.nodeName} ({receipt.nodeId}) · execution {receipt.executionId} · attempt{" "}
        {receipt.attempt} · run {receipt.runId}
      </p>
    </Shell>
  );
}
