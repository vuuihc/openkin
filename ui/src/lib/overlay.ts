/**
 * Which full-bleed overlay the task page has open, if any.
 *
 * There are three — the workspace panel, the pull request panel, and the publish
 * sheet — and they all render as `absolute inset-0` at the same z-index, so "two
 * open" is not a layout this page has. Three entry points used to keep that
 * invariant by hand, each remembering to close the other one first, and the
 * fourth (opening a file from the transcript) did not: it turned the files panel
 * on and left the pull request panel on underneath it. One value makes the
 * invariant structural instead of remembered.
 *
 * The publish sheet is reached from the workspace panel's header, so opening it
 * closes that panel rather than floating over it. What sits behind the sheet is
 * the session, which is what the person is publishing.
 */
export type Overlay = "files" | "pr" | "publish" | null;

export type OverlayName = Exclude<Overlay, null>;

/**
 * The overlay to show after `name` is asked for: the one already open closes,
 * the other one is replaced.
 */
export function toggleOverlay(current: Overlay, name: OverlayName): Overlay {
  return current === name ? null : name;
}
