import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as integrations from "@/lib/integrations";
import { IntegrationsSection } from "@/components/integrations/integrations-section";

afterEach(() => vi.restoreAllMocks());

function status(
  overrides: Partial<integrations.IntegrationStatus> &
    Pick<integrations.IntegrationStatus, "id">,
): integrations.IntegrationStatus {
  return {
    displayName: overrides.id,
    summary: "",
    kind: "http",
    configured: false,
    missingEnvVars: [],
    envVars: [],
    reaches: "Nothing.",
    notConfiguredReason: null,
    ...overrides,
  };
}

const INFRANODUS_UNCONFIGURED = status({
  id: "infranodus",
  displayName: "InfraNodus",
  kind: "mcp",
  configured: false,
  missingEnvVars: ["INFRANODUS_API_KEY"],
  envVars: [{ name: "INFRANODUS_API_KEY", purpose: "InfraNodus API key.", present: false }],
  reaches: "Nothing. No connector entry is written.",
  notConfiguredReason: "InfraNodus is not configured. Set INFRANODUS_API_KEY to connect.",
  mcp: {
    serverName: "infranodus",
    toolPrefix: "mcp__infranodus__",
    registered: false,
    enabled: false,
    toolDiscovery: "on-connect",
  },
});

describe("IntegrationsSection", () => {
  it("names the env var and disables Connect with a visible reason when unconfigured", async () => {
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([INFRANODUS_UNCONFIGURED]);
    const registerSpy = vi.spyOn(integrations, "registerIntegration");

    render(<IntegrationsSection />);

    expect(await screen.findByText("InfraNodus")).toBeInTheDocument();
    // The status is stated in words, not carried by colour alone.
    expect(screen.getByTestId("integration-status-infranodus")).toHaveTextContent(
      "Not configured",
    );
    // The variable NAME is shown; no value is ever rendered.
    expect(screen.getByText("INFRANODUS_API_KEY")).toBeInTheDocument();
    expect(screen.getByText(/not set/)).toBeInTheDocument();
    expect(
      screen.getByText(/Connect is unavailable: InfraNodus is not configured/),
    ).toBeInTheDocument();

    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    await userEvent.click(connect);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("registers a configured connector and reports the tool prefix a run will see", async () => {
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([
      {
        ...INFRANODUS_UNCONFIGURED,
        configured: true,
        missingEnvVars: [],
        notConfiguredReason: null,
        envVars: [
          { name: "INFRANODUS_API_KEY", purpose: "InfraNodus API key.", present: true },
        ],
      },
    ]);
    const registerSpy = vi
      .spyOn(integrations, "registerIntegration")
      .mockResolvedValue({ ok: true, serverName: "infranodus", toolPrefix: "mcp__infranodus__" });

    render(<IntegrationsSection />);
    const connect = await screen.findByRole("button", { name: "Connect" });
    expect(connect).toBeEnabled();
    await userEvent.click(connect);

    await waitFor(() => expect(registerSpy).toHaveBeenCalledWith("infranodus"));
    expect(
      await screen.findByText(/Its tools appear to a run as mcp__infranodus__<tool>/),
    ).toBeInTheDocument();
  });

  it("degrades to an error state instead of throwing on a malformed response (#62)", async () => {
    vi.spyOn(integrations, "getIntegrations").mockRejectedValue(
      new Error("The integrations response was not in the expected shape."),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The integrations response was not in the expected shape.",
    );
  });

  it("reports a missing CLI as an honest state that gates nothing", async () => {
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([
      status({
        id: "modal",
        displayName: "Modal",
        kind: "compute",
        configured: true,
        envVars: [{ name: "MODAL_TOKEN_ID", purpose: "Modal token id.", present: true }],
        reaches: "Submits and monitors Modal jobs.",
        cli: { binary: "modal", found: false, path: null, version: null },
      }),
    ]);
    render(<IntegrationsSection />);
    expect(
      await screen.findByText(/CLI: not found — modal is not on this machine's PATH/),
    ).toBeInTheDocument();
    // A compute integration has no Connect action to disable in the first place.
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});
