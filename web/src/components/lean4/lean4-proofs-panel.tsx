"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { Lean4ProofArtifact } from "./lean4-proof-artifact";
import {
  Lean4ApiError,
  listLean4RunProofs,
  readLean4ProofSource,
  type Lean4ArtifactKind,
  type Lean4ProofReceipt,
  type Lean4ProofSource,
} from "@/lib/lean4-proof";

/**
 * The one host for `Lean4ProofArtifact`.
 *
 * F4 owns this file. Dest Console applies `{ Lean4ProofsPanel }` from
 * `@/components/lean4` (INTEGRATION.md §2). F6 / F11 reuse the same host —
 * they must not write a second renderer. This panel owns the fetches; the
 * artifact stays presentational. Do not take F6 palette / inspector files.
 */
export interface Lean4ProofsPanelProps {
  projectId: string;
  runId: string;
  className?: string;
}

export function Lean4ProofsPanel({
  projectId,
  runId,
  className,
}: Lean4ProofsPanelProps) {
  const headingId = useId();
  const [receipts, setReceipts] = useState<Lean4ProofReceipt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<Lean4ProofSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSource(null);
    setSourceError(null);
    void listLean4RunProofs(projectId, runId)
      .then((body) => {
        if (cancelled) return;
        setReceipts(body.proofs);
        setSelectedId(body.proofs[0]?.executionId ?? null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setReceipts([]);
        setSelectedId(null);
        if (caught instanceof Lean4ApiError) {
          setError(
            caught.code
              ? `${caught.message} (${caught.code})`
              : caught.message,
          );
          return;
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Lean 4 proofs could not be read.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId]);

  const selected = receipts.find((row) => row.executionId === selectedId) ?? null;

  const onRequestSource = useCallback(
    (artifact: Lean4ArtifactKind) => {
      if (!selected) return;
      setSourceLoading(true);
      setSourceError(null);
      void readLean4ProofSource(projectId, runId, selected.executionId, artifact)
        .then((body) => {
          setSource(body);
        })
        .catch((caught: unknown) => {
          setSource(null);
          if (caught instanceof Lean4ApiError) {
            setSourceError(
              caught.code
                ? `${caught.message} (${caught.code})`
                : caught.message,
            );
            return;
          }
          setSourceError(
            caught instanceof Error
              ? caught.message
              : "Lean 4 artifact text could not be read.",
          );
        })
        .finally(() => {
          setSourceLoading(false);
        });
    },
    [projectId, runId, selected],
  );

  return (
    <section
      data-testid="lean4-proofs-panel"
      aria-labelledby={headingId}
      className={className}
    >
      <h2 id={headingId} className="sr-only">
        Lean 4 proofs for this run
      </h2>
      {receipts.length > 1 ? (
        <label className="mb-2 block text-[11px] text-muted-foreground">
          Proof
          <select
            className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            value={selectedId ?? ""}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setSource(null);
              setSourceError(null);
            }}
          >
            {receipts.map((row) => (
              <option key={row.executionId} value={row.executionId}>
                {row.nodeName} · {row.executionId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Lean4ProofArtifact
        receipt={selected}
        source={source}
        loading={loading}
        sourceLoading={sourceLoading}
        error={error}
        sourceError={sourceError}
        onRequestSource={onRequestSource}
      />
    </section>
  );
}
