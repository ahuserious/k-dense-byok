import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as integrations from "@/lib/integrations";
import { IntegrationsSection } from "@/components/integrations/integrations-section";

afterEach(() => vi.restoreAllMocks());

/** The Modal row reads its CLI detail from a second route; stub it by default. */
function stubModalCli(
  overrides: Partial<integrations.ModalCliState> = {},
): void {
  vi.spyOn(integrations, "getModalCliState").mockResolvedValue({
    cli: null,
    profile: { ok: false, code: "NOT_CONFIGURED", detail: null, stdout: null },
    ...overrides,
  });
}

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
    disabled: false,
    enabled: false,
    toolDiscovery: "on-connect",
  },
});

const MODAL_ROW = status({
  id: "modal",
  displayName: "Modal",
  kind: "compute",
  configured: true,
  envVars: [{ name: "MODAL_TOKEN_ID", purpose: "Modal token id.", present: true }],
  reaches: "Submits and monitors Modal jobs.",
  // The listing route reports presence only; the version arrives with the CLI
  // detail, which is why it is null here.
  cli: { binary: "modal", found: false, path: null, version: null },
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
    stubModalCli();
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([MODAL_ROW]);
    render(<IntegrationsSection />);
    expect(
      await screen.findByText(/CLI: not found — modal is not on this machine's PATH/),
    ).toBeInTheDocument();
    // A compute integration has no Connect action to disable in the first place.
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("renders the Modal workspace the configured tokens bill to", async () => {
    stubModalCli({
      cli: { binary: "modal", found: true, path: "/usr/local/bin/modal", version: "1.4.2" },
      profile: { ok: true, code: null, detail: null, stdout: "workspace: acme-research" },
    });
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([MODAL_ROW]);
    render(<IntegrationsSection />);
    // Row 50's second half: which workspace a job bills to, on screen.
    await waitFor(() =>
      expect(screen.getByTestId("modal-workspace")).toHaveTextContent("workspace: acme-research"),
    );
    // The fresher reading also supplies the version the listing route omits.
    expect(screen.getByText(/CLI: found at \/usr\/local\/bin\/modal \(1\.4\.2\)/)).toBeInTheDocument();
  });

  it("states WHY the workspace is unavailable instead of rendering an empty line", async () => {
    stubModalCli({
      profile: {
        ok: false,
        code: "NOT_CONFIGURED",
        detail: "Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.",
        stdout: null,
      },
    });
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([MODAL_ROW]);
    render(<IntegrationsSection />);
    await waitFor(() =>
      expect(screen.getByTestId("modal-workspace")).toHaveTextContent(
        "unavailable — Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.",
      ),
    );
  });

  it("a disabled connector says so and does not offer a live Connect", async () => {
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([
      {
        ...INFRANODUS_UNCONFIGURED,
        configured: true,
        missingEnvVars: [],
        notConfiguredReason: null,
        envVars: [
          { name: "INFRANODUS_API_KEY", purpose: "InfraNodus API key.", present: true },
        ],
        // Disabling MOVES the entry out of mcp.json, so registered is false while
        // the connector very much exists.
        mcp: {
          serverName: "infranodus",
          toolPrefix: "mcp__infranodus__",
          registered: false,
          disabled: true,
          enabled: false,
          toolDiscovery: "on-connect",
        },
      },
    ]);
    const registerSpy = vi.spyOn(integrations, "registerIntegration");

    render(<IntegrationsSection />);

    expect(await screen.findByTestId("integration-status-infranodus")).toHaveTextContent(
      "Configured · connected but disabled",
    );
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    expect(
      screen.getByText(/InfraNodus is already configured but disabled\. Enable it in the connector list above\./),
    ).toBeInTheDocument();
    await userEvent.click(connect);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("names the next action when the register request never completes", async () => {
    vi.spyOn(integrations, "getIntegrations").mockResolvedValue([
      {
        ...INFRANODUS_UNCONFIGURED,
        configured: true,
        missingEnvVars: [],
        notConfiguredReason: null,
      },
    ]);
    vi.spyOn(integrations, "registerIntegration").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    render(<IntegrationsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));

    // Without the catch the spinner would clear and the button would return to
    // "Connect" with nothing said, on an unhandled rejection.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connect failed. Check that the backend is reachable, then try again.",
    );
  });
});
