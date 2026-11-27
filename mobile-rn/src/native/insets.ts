/**
 * KIN-MOBILE-001 R4/R7 — the phone's safe-area arithmetic, with no React.
 *
 * The conversation is the only surface that has to sit between the status bar
 * and the home indicator on every device, so its two paddings are computed
 * here instead of being hard-coded in the stylesheet. Keeping the formulas
 * pure lets the numbers be pinned without a renderer; the view applies them.
 */

/**
 * The header's top padding. A notched iPhone reports `top` 59, and the header
 * should sit just below that area: 8pt of air keeps the back control off the
 * status bar. A device reporting no inset gets a compact 12pt header rather
 * than reserving a notch it does not have.
 */
export function headerTopInset(insetTop: number): number {
  return insetTop > 0 ? insetTop + 8 : 12;
}

/**
 * The header row's own height, without the status-bar air above it. The
 * stylesheet's `minHeight` and the list's spacer both read this one number, so
 * the bar and the space reserved for it cannot drift apart.
 */
export const HEADER_ROW_HEIGHT = 56;

/**
 * The header's total height: its row plus the air above it. The transcript's
 * first content is a spacer of exactly this height, so the bar can float over
 * the scroller while no turn ever starts underneath it.
 */
export function headerTotalHeight(insetTop: number): number {
  return HEADER_ROW_HEIGHT + headerTopInset(insetTop);
}

/**
 * The composer's bottom padding. The home indicator is 34pt tall; 8pt above
 * it keeps Send and the input clear of the bar. No inset means the composer
 * keeps the 24pt it has always had, so a device without a bar does not gain a
 * new gap.
 */
export function composerBottomInset(insetBottom: number): number {
  return insetBottom > 0 ? insetBottom + 8 : 24;
}
