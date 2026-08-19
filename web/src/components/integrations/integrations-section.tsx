"use client";

/**
 * Settings ▸ Connectors → "Known integrations" (matrix rows 48, 49, 50).
 *
 * Mounted into the existing connectors panel, not a new tab. Dense unadorned
 * rows, secondary text in --muted-foreground, no chrome that does not carry
 * information — the same idiom as the connector rows above it.
 *
 * Every state here is designed rather than defaulted: loading, error,
 * configured, not-configured, connected, connected-but-disabled. A row that
 * cannot act renders its action DISABLED with the reason visible next to it
 * (§6.7), never live. State is never carried by opacity or colour alone — each
 * row states its status in words, and the Connect control's focus indicator is a
 * full-opacity ring plus a --foreground outline rather than a dimmed ring.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getIntegrations,
  getModalCliState,
  registerIntegration,
  type IntegrationCliStatus,
  type IntegrationStatus,
  type ModalCliState,
} from "@/lib/integrations";

/**
 * The focus indicator for this section's own controls.
 *
 * The shared primitive focuses with `ring-ring/50` — the token at HALF alpha,
 * which composites to about 1.5:1 against the panel in light mode, under the 3:1
 * §6.6 requires for a focus indicator. This overrides the alpha to full and adds
 * a --foreground outline, which is the part that actually carries the ratio.
 * Tokens only; no literal is introduced, and no `ui/*` primitive is forked (§6.3)
 * — this is a className on lane F12's own element.
 */
const FOCUS_INDICATOR =
  "focus-visible:ring-ring focus-visible:outline-solid focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-foreground";

/** The short status word each row states in text, so colour is never the only signal. */
function statusLabel(integration: IntegrationStatus): string {
  if (!integration.configured) return "Not configured";
  if (!integration.mcp) return "Configured";
  // Disabling MOVES the entry out of mcp.json, so `registered` alone cannot tell
  // "switched off" from "never connected". Say which one it is.
  if (integration.mcp.disabled && integration.mcp.registered) {
    return "Connected · listed in both the enabled and disabled lists";
  }
  if (integration.mcp.disabled) return "Configured · connected but disabled";
  if (!integration.mcp.registered) return "Configured · not connected";
  return "Connected";
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

function cliLineText(cli: IntegrationCliStatus): string {
  if (!cli.found) {
    return `CLI: not found — ${cli.binary} is not on this machine's PATH. The features above do not depend on it.`;
  }
  return `CLI: found at ${cli.path}${cli.version ? ` (${cli.version})` : ""}`;
}

function CliLine({ cli }: { cli: IntegrationCliStatus | null }) {
  if (!cli) return null;
  return <p className="mt-1.5 text-[11px] text-muted-foreground">{cliLineText(cli)}</p>;
}

/**
 * The Modal row's CLI detail: installation AND the workspace the configured
 * tokens bill to. Read from GET /integrations/modal/cli, which is a separate
 * request because both readings spawn a process and the listing must not.
 *
 * The workspace has an honest unavailable state for every way it can be missing
 * — backend unreachable, Modal unconfigured, program not installed, CLI failed —
 * and the reason is always on screen rather than an empty line.
 */
function ModalCliDetail({ listedCli }: { listedCli: IntegrationCliStatus | null }) {
  const [state, setState] = useState<ModalCliState | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getModalCliState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cli = state?.cli ?? listedCli;
  let workspace: string;
  if (unreachable) {
    workspace = "unavailable — the backend could not be reached.";
  } else if (state === null) {
    workspace = "reading…";
  } else if (state.profile.ok && state.profile.stdout) {
    workspace = state.profile.stdout;
  } else {
    workspace = `unavailable — ${state.profile.detail ?? "the Modal CLI returned nothing to report."}`;
  }

  return (
    <>
      <CliLine cli={cli} />
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        Workspace:{" "}
        <span
          className="font-mono whitespace-pre-wrap"
          data-testid="modal-workspace"
        >
          {workspace}
        </span>
      </p>
    </>
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
      } catch {
        // registerIntegration turns every HTTP status into a result, so reaching
        // here means the request never completed. Without this the spinner would
        // clear and the button would return to "Connect" with no explanation.
        setResult({
          id: integration.id,
          ok: false,
          text: "Connect failed. Check that the backend is reachable, then try again.",
        });
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
            const alreadyConnected = integration.mcp?.registered === true;
            const mcpDisabled = integration.mcp?.disabled === true;
            const canConnect =
              Boolean(integration.mcp) &&
              integration.configured &&
              !alreadyConnected &&
              !mcpDisabled;
            const disabledReason = !integration.configured
              ? integration.notConfiguredReason
              : mcpDisabled
                ? `${integration.displayName} is already configured but disabled. Enable it in the connector list above.`
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
                    {integration.id === "modal" ? (
                      <ModalCliDetail listedCli={integration.cli ?? null} />
                    ) : (
                      <CliLine cli={integration.cli ?? null} />
                    )}
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
                      className={`shrink-0 text-xs ${FOCUS_INDICATOR}`}
                      disabled={!canConnect || connecting === integration.id}
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
