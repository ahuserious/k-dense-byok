/**
 * The shared shadcn focus ring uses the global `--ring` token, whose current
 * light-theme contrast is below 3:1. F11 cannot change that global token, so its
 * new controls add a full-opacity semantic foreground outline as the compliant
 * keyboard indicator. The existing ring may remain as a secondary cue.
 */
export const F11_FOCUS_SCOPE = [
  "[&_.text-muted-foreground]:text-foreground",
  "[&_button]:disabled:opacity-100",
  "[&_button]:focus-visible:outline",
  "[&_button]:focus-visible:outline-2",
  "[&_button]:focus-visible:outline-offset-2",
  "[&_button]:focus-visible:outline-foreground",
  "[&_input]:focus-visible:outline",
  "[&_input]:focus-visible:outline-2",
  "[&_input]:focus-visible:outline-offset-2",
  "[&_input]:focus-visible:outline-foreground",
  "[&_select]:focus-visible:outline",
  "[&_select]:focus-visible:outline-2",
  "[&_select]:focus-visible:outline-offset-2",
  "[&_select]:focus-visible:outline-foreground",
  "[&_textarea]:focus-visible:outline",
  "[&_textarea]:focus-visible:outline-2",
  "[&_textarea]:focus-visible:outline-offset-2",
  "[&_textarea]:focus-visible:outline-foreground",
].join(" ");
