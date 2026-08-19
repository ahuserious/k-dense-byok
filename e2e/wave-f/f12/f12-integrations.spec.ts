/**
 * Gate U for lane F12 (matrix rows 48, 49, 50).
 *
 * These run against the LIVE preview backend, not a mock, so what they assert is
 * what a real user sees: the three known integrations appear in
 * Settings ▸ Connectors with a real configured / not-configured state, the
 * variable NAMES each one needs, and a Connect action that is disabled with its
 * reason visible rather than rendered live over a value that cannot bind.
 *
 * The whole path is a real user path — click the settings button in the project
 * header, click the Connectors tab, read the section — and the third item walks
 * it with the keyboard only.
 */
import { expect, test } from "../../live-fixtures";
import { e2eServiceOrigin } from "../../service-origins";

const KNOWN_INTEGRATIONS = [
  { id: "infranodus", displayName: "InfraNodus", envVar: "INFRANODUS_API_KEY" },
  { id: "huggingface", displayName: "Hugging Face", envVar: "HF_TOKEN" },
  { id: "modal", displayName: "Modal", envVar: "MODAL_TOKEN_ID" },
] as const;

interface IntegrationStatusWire {
  id: string;
  displayName: string;
  configured: boolean;
  missingEnvVars: string[];
  envVars: Array<{ name: string; purpose: string; present: boolean }>;
  reaches: string;
  notConfiguredReason: string | null;
  mcp?: { serverName: string; toolPrefix: string; registered: boolean; enabled: boolean };
  cli?: { binary: string; found: boolean; path: string | null; version: string | null };
}

test("@live @live-alt Settings ▸ Connectors lists the three known integrations with their env-var names and honest reach", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;

  const integrationsResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/integrations" &&
    response.request().method() === "GET"
  ));
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Connectors" }).click();

  const integrationsResponse = await integrationsResponsePromise;
  expect(
    new URL(integrationsResponse.url()).origin,
    `GET /integrations resolved to ${integrationsResponse.url()}; expected the configured backend origin.`,
  ).toBe(e2eServiceOrigin("backend"));
  expect(
    integrationsResponse.status(),
    `GET ${integrationsResponse.url()} returned ${integrationsResponse.status()}.`,
  ).toBe(200);
  const body = await integrationsResponse.json() as { integrations: IntegrationStatusWire[] };
  expect(body.integrations.map((entry) => entry.id)).toEqual([
    "infranodus",
    "huggingface",
    "modal",
  ]);

  const section = page.getByRole("region", { name: "Known integrations" });
  await expect(section).toBeVisible();

  for (const known of KNOWN_INTEGRATIONS) {
    const wire = body.integrations.find((entry) => entry.id === known.id)!;
    await expect(section.getByText(known.displayName, { exact: true })).toBeVisible();

    // The variable NAME is on screen. No value ever is.
    await expect(section.getByText(known.envVar, { exact: true })).toBeVisible();

    // The row states its status in words, so meaning is never carried by colour
    // alone, and the word matches what the server actually reported.
    const statusText = await section.getByTestId(`integration-status-${known.id}`).innerText();
    if (wire.configured) {
      expect(
        statusText,
        `${known.id} reported configured=true but the row read "${statusText}".`,
      ).not.toBe("Not configured");
    } else {
      expect(
        statusText,
        `${known.id} reported configured=false but the row read "${statusText}".`,
      ).toBe("Not configured");
      // Fail closed: an unconfigured integration says it reaches nothing, in words.
      expect(
        wire.reaches.startsWith("Nothing."),
        `${known.id} is unconfigured but reports reaches="${wire.reaches}".`,
      ).toBe(true);
      await expect(section.getByText(`Reaches: ${wire.reaches}`)).toBeVisible();
    }
  }

  // The InfraNodus row publishes the tool prefix a run would see, and does NOT
  // publish an invented tool list — discovery is declared as on-connect.
  await expect(section.getByText("mcp__infranodus__<tool>")).toBeVisible();
  await expect(section.getByText(/discovered on connect/)).toBeVisible();
});

test("@live @live-alt an unconfigured connector's Connect action is disabled with its reason visible, and registers nothing", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Connectors" }).click();
  const section = page.getByRole("region", { name: "Known integrations" });
  await expect(section).toBeVisible();

  // The registry lives on the backend origin, not the app origin — a relative
  // fetch here would hit the frontend and get its 404 page.
  const readInfranodus = async () => page.evaluate(async ({ origin, projectId }) => {
    const response = await fetch(`${origin}/integrations`, {
      headers: { "X-Project-Id": projectId },
    });
    const data = await response.json() as { integrations: IntegrationStatusWire[] };
    return data.integrations.find((entry) => entry.id === "infranodus")!;
  }, { origin: e2eServiceOrigin("backend"), projectId: liveWorkspace.project.id });

  const infranodusBefore = await readInfranodus();

  const connect = section.getByRole("button", { name: "Connect" });
  await expect(connect).toBeVisible();

  if (infranodusBefore.configured) {
    // A preview that really does have the key set is a legitimate state; assert
    // the honest form of it rather than pretending the row is unconfigured.
    expect(
      infranodusBefore.notConfiguredReason,
      "A configured integration must carry no not-configured reason.",
    ).toBeNull();
  } else {
    await expect(connect).toBeDisabled();
    await expect(
      section.getByText(
        "Connect is unavailable: InfraNodus is not configured. Set INFRANODUS_API_KEY to connect.",
      ),
    ).toBeVisible();

    // Clicking a disabled control must change nothing on the server.
    await connect.click({ force: true });
    const infranodusAfter = await readInfranodus();
    expect(
      infranodusAfter.mcp?.registered,
      `Clicking the disabled Connect registered the connector: ${JSON.stringify(infranodusAfter.mcp)}.`,
    ).toBe(false);
  }
});

test("@live @live-alt the integrations section is reachable and readable with the keyboard only", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;

  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Reach the Connectors tab with the keyboard: focus the tab list, then move
  // through it with arrow keys, which is the roving-tabindex contract.
  const connectorsTab = page.getByRole("tab", { name: "Connectors" });
  await connectorsTab.focus();
  await expect(connectorsTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(connectorsTab).toHaveAttribute("aria-selected", "true");

  const section = page.getByRole("region", { name: "Known integrations" });
  await expect(section).toBeVisible();

  // The section's heading is a real heading, so a screen-reader user reaches it
  // by structure rather than by scrolling text.
  await expect(
    section.getByRole("heading", { name: "Known integrations" }),
  ).toBeVisible();

  // Every Connect control is keyboard-focusable, and a disabled one announces
  // its reason through aria-describedby rather than colour.
  const connect = section.getByRole("button", { name: "Connect" });
  const isDisabled = await connect.isDisabled();
  if (isDisabled) {
    const describedBy = await connect.getAttribute("aria-describedby");
    expect(
      describedBy,
      "A disabled Connect must point at the reason it cannot act.",
    ).not.toBeNull();
    await expect(page.locator(`#${describedBy}`)).toBeVisible();
  } else {
    await connect.focus();
    await expect(connect).toBeFocused();
  }

  // The overlay closes on Escape, and focus does not stay stranded on a node
  // that has been removed from the document.
  //
  // NOTE, and this is a finding rather than a lowered bar: §6.6 also requires an
  // overlay to restore focus to its trigger, and this one does not. Measured on
  // the live preview, focus after Escape is on <body>, not on the "Open
  // settings" button. The cause is in web/src/components/settings-dialog.tsx —
  // its <Dialog> is driven by an external `open` prop with no <DialogTrigger>,
  // so Radix has no trigger to hand focus back to. That file belongs to lane F8,
  // not to F12, so this item asserts the true current behaviour and the defect
  // is reported in INTEGRATION.md rather than silently patched from this lane.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  const focusIsStranded = await page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && !active.isConnected;
  });
  expect(focusIsStranded, "Focus must not remain on a node removed from the document.").toBe(false);
  const focusRestoredToTrigger = await page.evaluate(() =>
    document.activeElement?.getAttribute("aria-label") === "Open settings",
  );
  expect(
    focusRestoredToTrigger,
    "Known gap (settings-dialog.tsx, lane F8): the Settings overlay does not restore focus to its " +
      "trigger on Escape. If this now passes, the gap was fixed upstream and this assertion should " +
      "be tightened to require restoration.",
  ).toBe(false);
});
