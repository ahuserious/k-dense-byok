import type { Page } from "@playwright/test";

import {
  createTypedWorkflowFromTemplate,
  expect,
  selectWorkspaceTab,
  test,
} from "./fixtures";
import { SCIENTIFIC_TEMPLATES, WORKSPACE_TABS } from "./inventory";

test.describe("workspace navigation consequences", () => {
  for (const tabName of WORKSPACE_TABS) {
    test(`${tabName} becomes the current workspace surface`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, tabName);
      const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
      await expect(navigation.getByRole("button", { name: tabName, exact: true }))
        .toHaveAttribute("aria-current", "page");
    });
  }

  test("retired workspace labels stay absent from navigation", async ({ workspacePage }) => {
    const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
    for (const retiredLabel of [
      "Archon",
      "DAG Workflows",
      "DAG Pipelines",
      "Typed builder",
      "DAG Builder agent",
    ] as const) {
      await expect(navigation).not.toContainText(retiredLabel);
    }
  });
});

test.describe("scientific skill catalogue", () => {
  test("renders the renamed skill without the retired Archon name", async ({ workspacePage }) => {
    await workspacePage.getByRole("button", { name: "Open settings" }).click();
    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Skills" }).click();
    await expect(settings.getByText("scientific-dag-studio", { exact: true })).toBeVisible();
    await expect(settings).not.toContainText(/archon/i);
  });
});

test.describe("scientific template structure and close control", () => {
  for (const template of SCIENTIFIC_TEMPLATES) {
    test(`${template.id} creates its own graph and Close details returns to the registry`, async ({
      workspacePage,
    }) => {
      const { details, rawDefinition, workflowName } = await createTypedWorkflowFromTemplate(
        workspacePage,
        template.id,
      );
      expect(workflowName).toBe(template.name);

      const rawText = await rawDefinition.textContent();
      expect(rawText).not.toBeNull();
      const definition = JSON.parse(rawText ?? "") as {
        id: string;
        graph: {
          id: string;
          name: string;
          nodes: Array<{ kind: string; name?: string; goal?: string; prompt?: string }>;
        };
      };
      expect(definition.id).toBe(template.id);
      expect(definition.graph.id).toBe(template.id);
      expect(definition.graph.name).toBe(template.name);
      expect(definition.graph.nodes.map((node) => node.kind)).toEqual(template.nodeKinds);
      expect(JSON.stringify(definition.graph.nodes)).toContain(template.nodeText);

      await details.getByRole("button", { name: "Close details" }).click();
      await expect(details).toBeHidden();
      await expect(workspacePage.getByRole("list", { name: "Scientific pipeline workflows" }))
        .toBeVisible();
    });
  }
});

test.describe("workspace surfaces never scroll the document sideways", () => {
  for (const tabName of WORKSPACE_TABS) {
    test(`${tabName} fits its pane at 1280x720`, async ({ workspacePage }) => {
      await workspacePage.setViewportSize({ width: 1280, height: 720 });
      await selectWorkspaceTab(workspacePage, tabName);

      const metrics = await workspacePage.evaluate((view) => {
        const surface = document.querySelector<HTMLElement>(
          `[data-workspace-surface]:not([aria-hidden="true"])`,
        );
        return {
          view,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          surfaceScrollWidth: surface?.scrollWidth ?? null,
          surfaceClientWidth: surface?.clientWidth ?? null,
        };
      }, tabName);

      expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
      if (metrics.surfaceScrollWidth !== null) {
        // The surface wrapper is overflow-hidden, so content wider than it is
        // unreachable rather than scrollable — it must never happen.
        expect(metrics.surfaceScrollWidth).toBe(metrics.surfaceClientWidth);
      }
    });
  }
});

test.describe("keyboard affordances", () => {
  test("the project-picker entry control shows a focus ring the card does not clip, then hands focus to the workspace nav", async ({
    workspacePage,
  }) => {
    // The mocks live on this page, so returning to "/" re-renders the picker.
    await workspacePage.goto("/");
    await expect(workspacePage.getByRole("heading", { name: "Choose a project" })).toBeVisible();
    const entryControl = workspacePage.getByRole("button", { name: "Open project E2E Project" });
    await expect(entryControl).toBeVisible();

    const cardBoxShadow = () =>
      entryControl.evaluate(
        (node) => window.getComputedStyle(node.parentElement as HTMLElement).boxShadow,
      );

    const blurred = await cardBoxShadow();
    expect(blurred).not.toContain("0px 0px 0px 3px");

    // Only real keyboard traversal sets :focus-visible.
    for (let press = 0; press < 40; press += 1) {
      await workspacePage.keyboard.press("Tab");
      if (await entryControl.evaluate((node) => document.activeElement === node)) break;
    }
    await expect(entryControl).toBeFocused();
    expect(await entryControl.evaluate((node) => node.matches(":focus-visible"))).toBe(true);

    // The card animates the ring in, so poll rather than sample once. A 3px
    // spread on the CARD is the assertion: the same ring on the overlay button
    // is clipped away by the card's overflow-hidden.
    await expect.poll(cardBoxShadow).toContain("0px 0px 0px 3px");

    // ...and the ring is drawn in the foreground colour. The shared ring/50
    // grey measured 1.55:1 against the page background, below the 3:1 a focus
    // indicator owes; the global --ring token is left alone for everyone else.
    const ringColor = await entryControl.evaluate((node) => {
      const card = node.parentElement as HTMLElement;
      const shadow = window.getComputedStyle(card).boxShadow;
      const foreground = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--foreground")
        .trim();
      return { shadow, foreground };
    });
    expect(ringColor.shadow).not.toContain("oklab(0.708");
    expect(ringColor.foreground).not.toBe("");

    // Entering the project used to leave document.activeElement on <body>: the
    // card unmounts with the overview and the keyboard user restarts from the
    // top of the document. Focus must land inside the workspace navigation.
    await workspacePage.keyboard.press("Enter");
    const navigation = workspacePage.getByRole("navigation", { name: "Project workspace" });
    await expect(navigation).toBeVisible();
    await expect
      .poll(() =>
        workspacePage.evaluate(() => {
          const active = document.activeElement;
          const nav = document.querySelector('nav[aria-label="Project workspace"]');
          return {
            insideNav: Boolean(nav && active && active !== document.body && nav.contains(active)),
            tag: active?.tagName ?? null,
            label: active?.textContent?.trim() ?? null,
          };
        }),
      )
      .toEqual({ insideNav: true, tag: "BUTTON", label: "Chat" });
  });

  /**
   * The shared fixtures answer `/credentials` with a configured OpenRouter key,
   * so the default model is available and Submit is NOT blocked — a test that
   * merely branches on the live state would take the enabled path and assert
   * nothing about the blocked one. Overriding that single response (Playwright
   * matches the most recently registered route first) makes the blocked state
   * deterministic instead. `delayMs` keeps the response in flight long enough
   * for the transient "checking" window to be real and observable.
   */
  async function withNoConfiguredProvider(page: Page, delayMs = 0): Promise<void> {
    await page.route("**/credentials", async (route) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ openrouter: { set: false } }),
      });
    });
  }

  async function reopenWorkspace(page: Page): Promise<void> {
    await page.goto("/");
    await page.getByRole("button", { name: "Open project E2E Project" }).click();
    await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
    await selectWorkspaceTab(page, "Chat");
  }

  test("the chat Submit control explains itself whenever it refuses to send", async ({
    workspacePage,
  }) => {
    await withNoConfiguredProvider(workspacePage);
    await reopenWorkspace(workspacePage);

    const submit = workspacePage
      .getByRole("button", { name: "Submit", exact: true })
      .first();
    await expect(submit).toBeVisible();

    const hint = workspacePage.getByTestId("composer-submit-blocked-hint").first();
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText("Connect a provider in Settings to send");
    await expect(submit).toHaveAttribute(
      "aria-describedby",
      (await hint.getAttribute("id")) ?? "",
    );
    // The reason reaches a pointer user through the control's own tooltip; a
    // native `title` alongside it stacked a second, near-duplicate bubble.
    expect(await submit.getAttribute("title")).toBeNull();
    // The whole point of aria-disabled over `disabled`: a keyboard user can
    // still land on the control and hear why it will not send.
    await submit.focus();
    await expect(submit).toBeFocused();

    // ...and they must be able to SEE that they landed on it. Only real
    // keyboard traversal sets :focus-visible, so leave and come back.
    await workspacePage.keyboard.press("Shift+Tab");
    await workspacePage.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    expect(await submit.evaluate((node) => node.matches(":focus-visible"))).toBe(true);

    // `aria-disabled:opacity-50` used to composite the box-shadow along with
    // the button, so the ring below rendered at half strength — 2.05:1, and
    // with no provider connected aria-disabled is the only state that exists.
    // The blocked look is carried by colour now, so opacity stays 1.
    const submitRing = () =>
      submit.evaluate((node) => {
        const style = window.getComputedStyle(node);
        return `${style.opacity} ${style.boxShadow}`;
      });
    // The control transitions its ring in, so poll rather than sample once.
    await expect.poll(submitRing).toContain("0px 0px 0px 3px");
    const settled = await submitRing();
    expect(settled.startsWith("1 ")).toBe(true);
    expect(settled).not.toContain("oklab(0.708");
  });

  test("the blocked-Submit hint never flashes the transient provider check", async ({
    workspacePage,
  }) => {
    // Record every text the hint ever renders, from first paint. Provider
    // status is "checking" until /credentials answers, and rendering the amber
    // box for that state flashed a warning and shifted the composer down on
    // every chat load. The half-second delay makes that window unmissable.
    await workspacePage.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __submitHintTexts: string[] }).__submitHintTexts = seen;
      const record = () => {
        for (const node of document.querySelectorAll(
          '[data-testid="composer-submit-blocked-hint"]',
        )) {
          const text = (node.textContent ?? "").trim();
          if (text && seen[seen.length - 1] !== text) seen.push(text);
        }
      };
      new MutationObserver(record).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await withNoConfiguredProvider(workspacePage, 500);
    await reopenWorkspace(workspacePage);

    // The settled reason still arrives...
    const hint = workspacePage.getByTestId("composer-submit-blocked-hint").first();
    await expect(hint).toHaveText("Connect a provider in Settings to send");

    // ...and it is the only thing the hint ever said.
    const texts = await workspacePage.evaluate(
      () => (window as unknown as { __submitHintTexts: string[] }).__submitHintTexts,
    );
    expect(texts).toEqual(["Connect a provider in Settings to send"]);
  });
});

test.describe("thin inventory smoke — excluded from the substantive count", () => {
  const surfaceAssertions = [
    { tab: "Chat", placeholder: "Ask Kady anything… (@ for files, + for data / compute / skills)" },
    { tab: "Workflows", placeholder: "Search workflows..." },
    { tab: "Scientific Pipelines", role: "heading" as const, name: "Scientific Pipelines" },
    { tab: "Builder", title: "DAG Builder" },
    { tab: "Console", role: "button" as const, name: "DAG Runs" },
    { tab: "Raindrop", role: "heading" as const, name: "Raindrop" },
  ] as const;

  for (const surface of surfaceAssertions) {
    test(`${surface.tab} exposes its primary control`, async ({ workspacePage }) => {
      await selectWorkspaceTab(workspacePage, surface.tab);
      const target = "placeholder" in surface
        ? workspacePage.getByPlaceholder(surface.placeholder)
        : "title" in surface
          ? workspacePage.getByTitle(surface.title)
          : workspacePage.getByRole(surface.role, { name: new RegExp(surface.name, "i") });
      await expect(target.first()).toBeVisible();
    });
  }
});
