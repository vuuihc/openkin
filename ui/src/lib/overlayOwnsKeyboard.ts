/**
 * True while a floating layer owns the keyboard.
 *
 * A shortcut belongs to the surface the reader can see. Panes stay mounted
 * behind tabs, and a menu or a sheet floats over the pane underneath without
 * unmounting it, so a key handler cannot decide from its own `active` prop
 * alone. The layers the app opens are these roles, plus the phone's sheets,
 * which are portaled out of their trigger and marked `data-sheet-layer`.
 *
 * Kept as a document query rather than a React context: the layers are opened
 * by components that have no common ancestor with the shortcut handlers (the
 * permission menu lives in the composer, the find bar in the transcript, the
 * run-config layer in a portal), and a context would have to be threaded
 * through every one of them to say the same thing.
 */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-sheet-layer]",
].join(", ");

/**
 * Whether the element is part of what is drawn.
 *
 * A role query alone is not enough. Ionic keeps a *closed* inline action sheet
 * in the DOM as a `role="dialog"` host (`display: none`), and a keep-alive
 * session pane is hidden with CSS/`aria-hidden` while a composer menu inside
 * it stays open in state. Either would make an overlay look permanently open:
 * below `md` every session would lose `j/k/a/d` and ⌘F, and switching tabs
 * would leave the visible pane's keys dead behind a menu in the hidden one.
 *
 * Walked from the element up, because `display: none` on any ancestor removes
 * the whole subtree from the page. `getComputedStyle` is what sees the
 * stylesheet rules (Tailwind's `hidden`, Ionic's overlay classes); the
 * attributes catch the same states before styles are applied, which is also
 * what lets jsdom tests exercise this without a layout engine.
 */
function rendered(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function overlayOwnsKeyboard(root: ParentNode = document): boolean {
  for (const element of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (rendered(element)) return true;
  }
  return false;
}
