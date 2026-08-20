import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D-1 regression guard: the shared shadcn primitives (ui/button, ui/tabs, …)
 * paint the focus ring as `ring-ring/50`, i.e. the `--ring` token composited
 * src-over at alpha 0.5 onto `--background`. WCAG 1.4.11 requires the painted
 * indicator to reach 3:1 against the adjacent surface. This test recomputes
 * that composite from the CSS custom properties in globals.css for BOTH theme
 * blocks, so the token's lightness cannot silently regress. The arithmetic
 * was validated byte-exactly against painted-pixel measurements in
 * F12-evidence.md (old light 0.708 -> #d0d0d0 = 1.54:1, old dark
 * 0.556 -> #3f3f3f = 1.88:1).
 */

// Alpha applied by the primitives (`focus-visible:ring-ring/50`).
const RING_ALPHA = 0.5;
const WCAG_NON_TEXT_MINIMUM = 3;

type Rgb = [number, number, number];

function oklchToSrgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((v) => {
    const clamped = Math.min(Math.max(v, 0), 1);
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

/** Browsers composite box-shadow in gamma-encoded sRGB, on 8-bit channels. */
function compositeSrcOver(source: Rgb, alpha: number, destination: Rgb): Rgb {
  return source.map((channel, i) => channel * alpha + destination[i] * (1 - alpha)) as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const byte = Math.round(channel * 255) / 255;
    return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function readGlobalsCss(): string {
  const webRoot = fs.existsSync(path.resolve(process.cwd(), "src/app"))
    ? process.cwd()
    : path.resolve(process.cwd(), "web");
  return fs.readFileSync(path.join(webRoot, "src/app/globals.css"), "utf-8");
}

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector "${selector}" present in globals.css`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

function parseOklchToken(block: string, token: string): Rgb {
  const match = block.match(
    new RegExp(`${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`),
  );
  expect(match, `${token} declared as an opaque oklch() value`).not.toBeNull();
  const [lightness, chroma, hue] = match!.slice(1).map(Number);
  return oklchToSrgb(lightness, chroma, hue);
}

describe("focus ring contrast (D-1)", () => {
  const css = readGlobalsCss();
  const themes = [
    { name: "light", block: extractBlock(css, ":root") },
    { name: "dark", block: extractBlock(css, ".dark") },
  ];

  for (const theme of themes) {
    it(`${theme.name}: --ring composited at ${RING_ALPHA} over --background meets ${WCAG_NON_TEXT_MINIMUM}:1`, () => {
      const ring = parseOklchToken(theme.block, "--ring");
      const background = parseOklchToken(theme.block, "--background");
      const painted = compositeSrcOver(ring, RING_ALPHA, background);
      const ratio = contrastRatio(painted, background);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MINIMUM);
    });
  }
});
