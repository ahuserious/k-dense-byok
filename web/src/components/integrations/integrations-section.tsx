"use client";

/**
 * Settings ▸ Connectors → "Known integrations" (matrix rows 48, 49, 50).
 *
 * Mounted into the existing connectors panel, not a new tab. Dense unadorned
 * rows, secondary text in --muted-foreground, no chrome that does not carry
 * information — the same idiom as the connector rows above it.
 *
 * Every state here is designed rather than defaulted: loading, error,
 * configured, not-configured, already-connected. A row that cannot act renders
 * its action DISABLED with the reason visible next to it (§6.7), never live.
 * State is never carried by opacity or colour alone — each row states its status
 * in words.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getIntegrations,
  registerIntegration,
  type IntegrationStatus,
} from "@/lib/integrations";

/** The short status word each row states in text, so colour is never the only signal. */
function statusLabel(integration: IntegrationStatus): string {
  if (!integration.configured) return "Not configured";
  if (integration.mcp && !integration.mcp.registered) return "Configured · not connected";
  if (integration.mcp && !integration.mcp.enabled) return "Connected · disabled";
  return "Configured";
}

function EnvVarList({ integration }: { integration: IntegrationStatus }) {
  if (integration.envVars.length === 0) return null;
  return (
    <dl className="mt-1.5 flex flex-col gap-0.5">
      {integration.envVars.map((envVar) => (
        <div key={envVar.name} className="flex items-baseline gap-1.5 text-[11px]">
          <dt className="font-mono text-foreground">{envVar.name}</dt>
          <dd className="text-muted-foreground">
            {envVar.present ? "set" : "not set"} — {envVar.purpose}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CliLine({ integration }: { integration: IntegrationStatus }) {
  if (!integration.cli) return null;
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground">
      {integration.cli.found
        ? `CLI: found at ${integration.cli.path}${
            integration.cli.version ? ` (${integration.cli.version})` : ""
          }`
        : `CLI: not found — ${integration.cli.binary} is not on this machine's PATH. The features above do not depend on it.`}
    </p>
  );
}

export function IntegrationsSection() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setIntegrations(await getIntegrations());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(
    async (integration: IntegrationStatus) => {
      setConnecting(integration.id);
      setResult(null);
      try {
        const response = await registerIntegration(integration.id);
        setResult({
          id: integration.id,
          ok: response.ok,
          text: response.ok
            ? `Connected as "${response.serverName}". Its tools appear to a run as ${response.toolPrefix}<tool>, discovered when the server connects.`
            : response.detail ?? "Connect failed",
        });
        if (response.ok) await load();
      } finally {
        setConnecting(null);
      }
    },
    [load],
  );

  return (
    <section className="flex flex-col gap-2" aria-labelledby="known-integrations-heading">
      <div>
        <h4 id="known-integrations-heading" className="text-xs font-medium">
          Known integrations
        </h4>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Integrations this build knows how to configure. Each one names the environment variables it
          needs; set them in the repository&apos;s <span className="font-mono">.env</span> file. An
          integration that is not configured reaches nothing.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading integrations…</p>
      ) : integrations.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">No known integrations are declared.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {integrations.map((integration) => {
            const canConnect = Boolean(integration.mcp) && integration.configured;
            const alreadyConnected = integration.mcp?.registered === true;
            const disabledReason = !integration.configured
              ? integration.notConfiguredReason
              : alreadyConnected
                ? "Already connected. Manage it in the connector list above."
                : null;
            return (
              <li key={integration.id} className="rounded-lg border px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-xs font-medium">{integration.displayName}</span>
                      <span
                        className={
                          integration.configured
                            ? "text-[11px] text-muted-foreground"
                            : "text-[11px] text-destructive"
                        }
                        data-testid={`integration-status-${integration.id}`}
                      >
                        {statusLabel(integration)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {integration.summary}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      Reaches: {integration.reaches}
                    </p>
                    <EnvVarList integration={integration} />
                    <CliLine integration={integration} />
                    {integration.mcp && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        Tools:{" "}
                        <span className="font-mono">{integration.mcp.toolPrefix}&lt;tool&gt;</span> —
                        discovered on connect.
                      </p>
                    )}
                  </div>
                  {integration.mcp && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 text-xs"
                      disabled={!canConnect || alreadyConnected || connecting === integration.id}
                      aria-describedby={
                        disabledReason ? `integration-reason-${integration.id}` : undefined
                      }
                      onClick={() => void connect(integration)}
                    >
                      {connecting === integration.id ? "Connecting…" : "Connect"}
                    </Button>
                  )}
                </div>

                {disabledReason && integration.mcp && (
                  <p
                    id={`integration-reason-${integration.id}`}
                    className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground"
                  >
                    Connect is unavailable: {disabledReason}
                  </p>
                )}

                {result?.id === integration.id && (
                  <p
                    role="status"
                    className={
                      result.ok
                        ? "mt-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground"
                        : "mt-1.5 rounded-md border border-destructive px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive"
                    }
                  >
                    {result.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
