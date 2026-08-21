import fs from "node:fs";
import path from "node:path";

import { expect, test } from "../../fixtures";

/**
 * Lane F4 (matrix row 10) — the Lean 4 proof renderer in a REAL browser,
 * against the running app's own compiled stylesheet, in both themes.
 *
 * WHY EVERY ITEM HERE IS DECLARED THIN, said plainly rather than hidden:
 * Gate U for row 10 needs a Playwright item that drives the control through a
 * REAL USER PATH — Node palette ▸ Lean 4 → inspector → proof rendered. Neither
 * the node palette nor the node inspector exists in this tree at base
 * `f98da86`: `WORKFLOW_NODE_KINDS` already contains `"lean4"` and
 * `nodeKindLabel` already returns `"Lean 4"`, but nothing in the app imports
 * either of them, and `PaletteSection` is a COLOUR palette in the brand-system
 * dialog. Both surfaces are lane F6's (Team C). A user path that does not exist
 * cannot be driven, and inventing one would be the false claim the completeness
 * bar exists to catch. So these items prove what they actually prove — that the
 * renderer's real markup is legible, accessible and contrast-compliant under
 * the app's real tokens — and Gate U for row 10 is reported NOT DONE, pending
 * F6's inspector wiring. Dest Console apply is clone-root INTEGRATION.md §2
 * (not F6 palette / inspector). See `interfaces/F4-lean4.md` and
 * `reports/F4-evidence.md` for the U/B/D table.
 *
 * The markup is not hand-written: `lean4-proof-artifact.fixture.html` is the
 * REAL `<Lean4ProofArtifact>` render, emitted and equality-checked by
 * `web/src/components/lean4/lean4-proof-artifact.test.tsx`, so it cannot drift
 * from the component.
 */

// Playwright resolves specs relative to the repo root, the same convention
// `e2e/template-source.ts` uses for its source read.
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  "e2e/wave-f/f4/lean4-proof-artifact.fixture.html",
);
const MATHLIB_REVISION = "4d1f6e2a9c3b8705ef2213a4c65d90bb17e4f0aa";
const MATHLIB_TREE = "9b7c05e1d24f38a6be0913cc74d5f28a6e11b3d0";

async function mountRenderer(page: import("@playwright/test").Page, theme: "light" | "dark") {
  const markup = fs.readFileSync(FIXTURE_PATH, "utf-8");
  await page.evaluate(
    ({ html, dark }) => {
      document.documentElement.classList.toggle("dark", dark);
      const existing = document.getElementById("f4-lean4-harness");
      existing?.remove();
      const host = document.createElement("div");
      host.id = "f4-lean4-harness";
      // Fixed position over the live app so the screenshot is the renderer
      // itself, on the app's real background, at a realistic inspector width.
      host.setAttribute(
        "style",
        "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;" +
          "justify-content:center;padding:24px;overflow:auto;background:var(--background)",
      );
      const frame = document.createElement("div");
      frame.setAttribute("style", "width:520px;max-width:100%");
      frame.innerHTML = html;
      host.appendChild(frame);
      document.body.appendChild(host);
    },
    { html: markup, dark: theme === "dark" },
  );
  return page.getByRole("region", { name: "Lean 4 proof" });
}

test.describe("thin lane-F4 renderer inventory — excluded from the substantive count", () => {
  test("renders the mathlib revision and tree verbatim under the app's own tokens", async ({
    workspacePage,
  }) => {
    for (const theme of ["light", "dark"] as const) {
      const region = await mountRenderer(workspacePage, theme);
      await expect(region).toBeVisible();
      await expect(region.getByText("Verified")).toBeVisible();
      // Row 10 asks for the proof artifact WITH its mathlib revision/tree
      // provenance. Both are rendered in full, not abbreviated.
      await expect(region.getByText(MATHLIB_REVISION, { exact: true })).toBeVisible();
      await expect(region.getByText(MATHLIB_TREE, { exact: true })).toBeVisible();
      await expect(region.getByText("leanprover/lean4:v4.19.0")).toBeVisible();
      await expect(
        region.getByText("workflow_artifacts/dag-workflows/lean/wrun_f4proof/exec_lean_1/Proof.lean"),
      ).toBeVisible();

      // Every colour must resolve through a token: an unresolved custom
      // property renders as transparent or as the initial colour, which is the
      // failure mode a screenshot alone would not catch.
      const resolved = await region.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
      });
      expect(resolved.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(resolved.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(resolved.border).not.toBe("rgba(0, 0, 0, 0)");

      // #40: Inter is NOT vendored. `fontFamily` reports the declared chain,
      // not the face that actually painted, so the availability of each family
      // is probed rather than assumed.
      const fonts = await region.evaluate((element) => {
        const declared = getComputedStyle(element).fontFamily;
        // `document.fonts.check` answers "can this be rendered", which is true
        // for every family because of fallback. Width comparison against a
        // family that provably does not exist is the only honest probe.
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        const sample = "Mathlib revision 4d1f6e2a9c3b";
        const widthWith = (family: string) => {
          context.font = `16px ${family}, sans-serif`;
          return Math.round(context.measureText(sample).width * 100) / 100;
        };
        const absent = widthWith('"__f4_definitely_absent__"');
        return {
          declared,
          interResolves: widthWith("Inter") !== absent,
          fallbackWidth: absent,
          interWidth: widthWith("Inter"),
        };
      });
      console.log(`F4_FONT ${theme} ${JSON.stringify(fonts)}`);

      // Gate D evidence: a screenshot from THIS live preview, not a mock.
      const screenshotDirectory = process.env.F4_SCREENSHOT_DIR;
      if (screenshotDirectory) {
        fs.mkdirSync(screenshotDirectory, { recursive: true });
        await region.screenshot({
          path: path.join(screenshotDirectory, `lean4-proof-artifact-${theme}.png`),
        });
      }
    }
  });

  test("keeps text and focus contrast above their floors in light and dark", async ({
    workspacePage,
  }) => {
    const measurements: Record<string, Record<string, number>> = {};
    for (const theme of ["light", "dark"] as const) {
      const region = await mountRenderer(workspacePage, theme);
      await expect(region).toBeVisible();
      // Focus is driven from the keyboard so `:focus-visible` actually matches;
      // a programmatic `.focus()` does not, and would measure the wrong ring.
      await region.getByLabel("Proof source for execution exec_lean_1").focus();
      await workspacePage.keyboard.press("Shift+Tab");
      await expect(region.getByRole("button", { name: "Verification log" })).toBeFocused();

      const measured = await region.evaluate((element) => {
        // Computed colours arrive as `lab()`/`oklab()` in this engine, not
        // `rgb()`. Painting each one on a 1x1 canvas is the only conversion
        // that is correct for every CSS Color 4 form the tokens produce.
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d")!;
        function sample(color: string): [number, number, number, number] {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = "#000000";
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
          return [red, green, blue, alpha / 255];
        }
        function luminance([red, green, blue]: number[]): number {
          const [r, g, b] = [red, green, blue].map((value) => {
            const channel = value / 255;
            return channel <= 0.03928
              ? channel / 12.92
              : Math.pow((channel + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        /** Composite a translucent foreground over its background before measuring. */
        function contrast(foregroundColor: string, backgroundColor: string): number {
          const background = sample(backgroundColor);
          const foreground = sample(foregroundColor);
          const composited = [0, 1, 2].map((index) =>
            foreground[index] * foreground[3] + background[index] * (1 - foreground[3])
          );
          const lighter = Math.max(luminance(composited), luminance(background));
          const darker = Math.min(luminance(composited), luminance(background));
          return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
        }

        const card = getComputedStyle(element).backgroundColor;
        const heading = element.querySelector("h3")!;
        const label = element.querySelector("dt")!;
        const code = element.querySelector("code")!;
        const summary = element.querySelector("p")!;
        const focused = document.activeElement as HTMLElement;
        const focusedStyle = getComputedStyle(focused);
        return {
          heading: contrast(getComputedStyle(heading).color, card),
          mutedLabel: contrast(getComputedStyle(label).color, card),
          mutedSummary: contrast(getComputedStyle(summary).color, card),
          codeValue: contrast(getComputedStyle(code).color, card),
          focusedControlText: contrast(focusedStyle.color, card),
          focusedControlOutline: contrast(focusedStyle.outlineColor, card),
        };
      });
      measurements[theme] = measured;
      // Logged BEFORE the assertions so a failure still reports every number.
      console.log(`F4_CONTRAST ${theme} ${JSON.stringify(measured)}`);

      // WCAG AA for normal text.
      expect(measured.heading, `${theme} heading`).toBeGreaterThanOrEqual(4.5);
      expect(measured.mutedLabel, `${theme} muted label`).toBeGreaterThanOrEqual(4.5);
      expect(measured.mutedSummary, `${theme} muted summary`).toBeGreaterThanOrEqual(4.5);
      expect(measured.codeValue, `${theme} code value`).toBeGreaterThanOrEqual(4.5);
      expect(measured.focusedControlText, `${theme} focused control text`)
        .toBeGreaterThanOrEqual(4.5);
      // Non-text UI: the focus indicator itself.
      expect(measured.focusedControlOutline, `${theme} focus outline`).toBeGreaterThanOrEqual(3);
    }
    // The numbers ARE the evidence, so they go into the run log verbatim.
    console.log(`F4_CONTRAST_ALL ${JSON.stringify(measurements)}`);
  });

  test("reaches the source controls and the proof region by keyboard with a visible focus ring", async ({
    workspacePage,
  }) => {
    const region = await mountRenderer(workspacePage, "dark");
    await expect(region).toBeVisible();

    // Walk backwards from the proof region so every arrival is keyboard-driven
    // and `:focus-visible` matches, which programmatic focus does not trigger.
    const proofRegion = region.getByLabel("Proof source for execution exec_lean_1");
    await proofRegion.focus();
    await workspacePage.keyboard.press("Shift+Tab");
    const logButton = region.getByRole("button", { name: "Verification log" });
    await expect(logButton).toBeFocused();
    await workspacePage.keyboard.press("Shift+Tab");
    const proofButton = region.getByRole("button", { name: "Proof source" });
    await expect(proofButton).toBeFocused();

    const indicator = await proofButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });
    // A real, drawn indicator — not opacity, not colour alone.
    expect(indicator.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(indicator.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(indicator.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
    console.log(`F4_FOCUS_RING ${JSON.stringify(indicator)}`);
    const screenshotDirectory = process.env.F4_SCREENSHOT_DIR;
    if (screenshotDirectory) {
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      await region.screenshot({
        path: path.join(screenshotDirectory, "lean4-proof-artifact-dark-focus-ring.png"),
      });
    }

    // Forwards again: the tab order is the reading order.
    await workspacePage.keyboard.press("Tab");
    await expect(logButton).toBeFocused();
    await workspacePage.keyboard.press("Tab");
    await expect(proofRegion).toBeFocused();
  });
});
