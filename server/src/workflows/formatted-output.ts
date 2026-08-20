export const FORMATTED_OUTPUT_STYLES = [
  "markdown",
  "json",
  "methods",
  "latex",
] as const;

export type FormattedOutputStyle = (typeof FORMATTED_OUTPUT_STYLES)[number];

export interface FormattedOutputValidation {
  ok: boolean;
  reason?: string;
}

export function validateFormattedOutput(
  style: FormattedOutputStyle,
  text: string,
): FormattedOutputValidation {
  const body = text.trim();
  if (body.length === 0) {
    return { ok: false, reason: "Formatted output was empty." };
  }
  switch (style) {
    case "json": {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed === null || typeof parsed !== "object") {
          return { ok: false, reason: "JSON style requires an object or array." };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: "JSON style requires parseable JSON." };
      }
    }
    case "markdown":
      return /^#{1,6}\s+\S/m.test(body)
        ? { ok: true }
        : { ok: false, reason: "Markdown style requires at least one heading." };
    case "methods":
      return /(?:^|\n)#{1,3}\s*methods\b/i.test(body) || /^\s*methods\s*$/im.test(body)
        ? { ok: true }
        : { ok: false, reason: "Methods style requires a Methods section." };
    case "latex":
      return /\\(begin|section|documentclass)\b/.test(body)
        ? { ok: true }
        : { ok: false, reason: "LaTeX style requires a \\section, \\begin, or \\documentclass." };
    default: {
      const _exhaustive: never = style;
      return { ok: false, reason: `Unhandled formatted-output style ${String(_exhaustive)}.` };
    }
  }
}

export function formattedOutputConstraint(style: FormattedOutputStyle): string {
  switch (style) {
    case "json":
      return "Return only a JSON object. No markdown fences.";
    case "markdown":
      return "Return Markdown that includes at least one ATX heading.";
    case "methods":
      return "Return a Methods section headed 'Methods' describing the procedure.";
    case "latex":
      return "Return a LaTeX fragment that includes \\section or \\begin.";
    default: {
      const _exhaustive: never = style;
      return `Unhandled style ${String(_exhaustive)}.`;
    }
  }
}
