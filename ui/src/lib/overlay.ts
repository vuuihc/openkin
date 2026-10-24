/**
 * Which full-bleed overlay the task page has open, if any.
 *
 * There are two — the workspace panel and the pull request panel — and both
 * render as `absolute inset-0` at the same z-index, so "both open" is not a
 * layout this page has. Three entry points used to keep that invariant by hand,
 * each remembering to close the other one first, and the fourth (opening a file
 * from the transcript) did not: it turned the files panel on and left the pull
 * request panel on underneath it. One value makes the invariant structural
 * instead of remembered.
 */
export type Overlay = "files" | "pr" | null;

export type OverlayName = Exclude<Overlay, null>;

/**
 * The overlay to show after `name` is asked for: the one already open closes,
 * the other one is replaced.
 */
export function toggleOverlay(current: Overlay, name: OverlayName): Overlay {
  return current === name ? null : name;
}
