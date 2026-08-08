export const SCIENTIFIC_DAG_STUDIO_FLAG =
  "NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO" as const;

export function isScientificDagStudioEnabled(
  value = process.env.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO,
): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export const STUDIO_DESIGN_TOKENS = {
  fonts: {
    hero:
      "'0xProto Nerd Font', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    nav: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    cta: "'FiraCode Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    figure:
      "'Tinos Nerd Font', Tinos, Georgia, 'Times New Roman', ui-serif, serif",
    annotation:
      "'Terminess Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    code: "'FiraCode Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  colors: {
    backdrop: "#050607",
    canvas: "#090b0d",
    surface: "#0c0f12",
    line: "#1c2126",
    lineStrong: "#2a3138",
    text: "#eef2f4",
    textMuted: "#aebcc3",
    textDim: "#7f8e96",
    textFaint: "#46525a",
    accent: "#2fd4ec",
    accentBright: "#8af0fb",
    blue: "#1f7fd1",
    blueBright: "#7fc4f0",
    accentDeep: "#1595b8",
    highlight: "#ffe14d",
  },
} as const;

export const STUDIO_CSS_VARIABLES = {
  "--fhero": STUDIO_DESIGN_TOKENS.fonts.hero,
  "--fnav": STUDIO_DESIGN_TOKENS.fonts.nav,
  "--fcta": STUDIO_DESIGN_TOKENS.fonts.cta,
  "--ffig": STUDIO_DESIGN_TOKENS.fonts.figure,
  "--fann": STUDIO_DESIGN_TOKENS.fonts.annotation,
  "--studio-font-code": STUDIO_DESIGN_TOKENS.fonts.code,
  "--studio-backdrop": STUDIO_DESIGN_TOKENS.colors.backdrop,
  "--studio-canvas": STUDIO_DESIGN_TOKENS.colors.canvas,
  "--studio-surface": STUDIO_DESIGN_TOKENS.colors.surface,
  "--studio-line": STUDIO_DESIGN_TOKENS.colors.line,
  "--studio-line-strong": STUDIO_DESIGN_TOKENS.colors.lineStrong,
  "--studio-text": STUDIO_DESIGN_TOKENS.colors.text,
  "--studio-text-muted": STUDIO_DESIGN_TOKENS.colors.textMuted,
  "--studio-text-dim": STUDIO_DESIGN_TOKENS.colors.textDim,
  "--studio-text-faint": STUDIO_DESIGN_TOKENS.colors.textFaint,
  "--studio-accent": STUDIO_DESIGN_TOKENS.colors.accent,
  "--studio-accent-bright": STUDIO_DESIGN_TOKENS.colors.accentBright,
  "--studio-blue": STUDIO_DESIGN_TOKENS.colors.blue,
  "--studio-blue-bright": STUDIO_DESIGN_TOKENS.colors.blueBright,
  "--studio-accent-deep": STUDIO_DESIGN_TOKENS.colors.accentDeep,
  "--studio-highlight": STUDIO_DESIGN_TOKENS.colors.highlight,
} as const;
