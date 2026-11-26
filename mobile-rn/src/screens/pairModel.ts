/**
 * KIN-MOBILE-001 R2b — the pairing screen's view-model.
 *
 * Pure and DOM-free: it names the strings the screen may render and decides
 * whether the one primary action is enabled. The screen keeps the typed link
 * itself, so a failure never asks the caller to drop it.
 *
 * The reason codes come from R2a's auth core (`mobile-rn/src/auth/pairing.ts`);
 * this module is the only place that maps them to catalogue keys.
 */

import type { AppState, PairingReason } from "../auth/pairing";

export type PairView = {
  headingKey: "pairing.title";
  /** The reason sentence; null on a fresh entry. */
  bodyKey: string | null;
  actionKey: "pairing.submit" | "pairing.connecting";
  /** False while a submit is in flight, and while nothing is typed. */
  canSubmit: boolean;
  /** null means stay on the pairing screen. */
  landing: "/list" | null;
};

/** `none` is a fresh entry, not a failure, so it has no sentence of its own. */
const REASON_KEYS: Record<PairingReason, string | null> = {
  none: null,
  expired: "pairing.expired",
  rejected: "pairing.rejected",
  unreachable: "pairing.unreachable",
};

export function pairView(
  state: AppState,
  opts: { busy: boolean; typed: string },
): PairView {
  return {
    headingKey: "pairing.title",
    bodyKey: REASON_KEYS[state.reason],
    actionKey: opts.busy ? "pairing.connecting" : "pairing.submit",
    canSubmit: !opts.busy && opts.typed.trim() !== "",
    landing: state.route === "list" ? "/list" : null,
  };
}

/** The boot decision: where the first frame starts. */
export function bootHref(
  state: AppState,
): "/pair" | "/pair?reason=expired" | "/list" {
  if (state.route === "list") return "/list";
  // An expired token is not a fresh entry: carry the reason so the pairing
  // screen renders its sentence on the first frame instead of a bare form.
  return state.reason === "expired" ? "/pair?reason=expired" : "/pair";
}
