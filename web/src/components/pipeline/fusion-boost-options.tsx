// danbot-byok — web/src/components/pipeline/fusion-boost-options.tsx
//
// Row 25's control surface: a "Fusion boost" master toggle plus one checkbox
// per stage.
//
// THE POINT OF THIS COMPONENT IS THE DISABLED CHECKBOXES, not the enabled ones.
// Two of row 25's four stages (elevation-to-DAG, hypothesis) need node kinds
// that do not exist in this tree — they are lane F5's work. §6.7 says a control
// that cannot act is rendered disabled with a visible reason, never rendered
// live, and §3 Gate B says shipping a live-looking control over a dropped value
// is "the single failure mode this wave exists to stop repeating". So those two
// render as real, visible, focusable-in-reading-order checkboxes that are
// disabled and CARRY THEIR REASON ON SCREEN — not hidden, and not live.
//
// The reason string is not written here: it travels with the stage in
// `FUSION_BOOST_STAGES`, so the control and its explanation cannot drift apart.
//
// §6.6: `disabled` is not expressed by opacity alone — the reason is printed as
// text beneath the label, and `aria-describedby` binds it to the input so a
// screen reader reaches it too.

"use client";

import { useId } from "react";

import {
  FUSION_BOOST_STAGES,
  type FusionBoostConfig,
  type FusionBoostStageId,
} from "@/lib/fusion-boost";

export function FusionBoostOptions({
  config,
  onChange,
  disabled = false,
  disabledReason,
}: {
  config: FusionBoostConfig;
  onChange: (next: FusionBoostConfig) => void;
  /** Set when there is no loaded document to apply a boost to. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const groupId = useId();

  const setStage = (stageId: FusionBoostStageId, checked: boolean) => {
    onChange({ ...config, stages: { ...config.stages, [stageId]: checked } });
  };

  return (
    <fieldset
      data-testid="fusion-boost-options"
      className="rounded-md border px-2.5 py-2"
      aria-describedby={disabled && disabledReason ? `${groupId}-blocked` : undefined}
    >
      <legend className="px-1 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Fusion boost
      </legend>

      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          data-testid="fusion-boost-enabled"
          checked={config.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...config, enabled: event.target.checked })}
          className="size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        />
        <span className="font-medium">Run a fusion panel at the selected stages</span>
      </label>

      {disabled && disabledReason && (
        <p id={`${groupId}-blocked`} className="mt-1 text-[10px] text-muted-foreground">
          {disabledReason}
        </p>
      )}

      <ul className="mt-1.5 flex flex-col gap-1.5">
        {FUSION_BOOST_STAGES.map((stage) => {
          const stageDisabled = disabled || !stage.available || !config.enabled;
          const reasonId = `${groupId}-${stage.id}-reason`;
          // Precedence matters: the "landing in lane F5" reason must win over
          // "turn the master toggle on", because it is the one the author
          // cannot act on and the one review is checking for.
          const reason = !stage.available
            ? stage.unavailableReason
            : disabled
              ? disabledReason
              : !config.enabled
                ? "Turn on fusion boost to choose stages."
                : undefined;

          return (
            <li key={stage.id}>
              <label className="flex items-start gap-2 text-[11px]">
                <input
                  type="checkbox"
                  data-testid={`fusion-boost-stage-${stage.id}`}
                  checked={config.stages[stage.id] === true}
                  disabled={stageDisabled}
                  aria-describedby={reason ? reasonId : undefined}
                  onChange={(event) => setStage(stage.id, event.target.checked)}
                  className="mt-0.5 size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                />
                <span className="min-w-0">
                  <span className="font-medium">{stage.label}</span>
                  <span className="block text-muted-foreground">{stage.description}</span>
                  {reason && (
                    <span
                      id={reasonId}
                      data-testid={`fusion-boost-reason-${stage.id}`}
                      className="block text-muted-foreground"
                    >
                      Unavailable: {reason}
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
