// danbot-byok overlay — CanvasChatPopout (DISABLED)
//
// Chat for the workflow builder now lives in Kady's far-right collapsible chat rail
// (the "popup chat moved to a slidable vertical tab on the far right"), which is a real
// KADY Pi chat with a model selector and force-loaded skills. The old in-canvas Archon
// pop-out would be a redundant SECOND chat sitting on top of the rail, so we disable it.
//
// We keep the component (a null render) rather than ripping out apply-debrand.sh's
// WorkflowBuilder import + mount, so the overlay stays a simple file-replace and the
// builder still compiles. Rendering null means nothing shows inside the canvas.

interface CanvasChatPopoutProps {
  /** Retained for call-site compatibility with the WorkflowBuilder mount; unused. */
  selectedProjectId: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function CanvasChatPopout(_props: CanvasChatPopoutProps): null {
  return null;
}
