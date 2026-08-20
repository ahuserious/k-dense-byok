"use client";

/**
 * Reconciliation point for master-brief row 14.
 *
 * Row 14 requires a persistent per-provider subscription bar and requires it to
 * be "reconciled with the existing session-cost-pill.tsx so there are not two
 * cost widgets". The chosen reconciliation is CONTAINMENT, not replacement or
 * coexistence: the subscription bar is the single header widget, and the
 * project/session cost readout this file used to own is a segment inside it.
 *
 * Cost spent and subscription quota consumed are different quantities, so both
 * survive — but as two sections of one surface with one trigger, not as two
 * controls in the header. The division of labour is stated on screen:
 * "Project billable spend" is USD against the project cap, "Subscription usage"
 * is tokens the provider bills outside it.
 *
 * This module stays as a thin alias so `web/src/app/page.tsx:1017` — the app
 * shell's mount, in a file lane F8 does not own — keeps compiling unchanged.
 * The exported name and the prop shape are exactly what they were.
 */

export { SubscriptionBar as SessionCostPill } from "./subscription-bar";
export type { SubscriptionBarProps as SessionCostPillProps } from "./subscription-bar";
