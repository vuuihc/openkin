/**
 * Whether the caret is inside a conversation transcript, not merely whether a
 * transcript exists in the document.
 *
 * Every open task keeps its pane mounted so switching does not reload it, and
 * the panes live in the document before the routes do. Asking the document for
 * "the" pane therefore answers about whichever pane was mounted first — often
 * a hidden one — and ⌘F pressed inside a visible transcript would be taken by
 * the list search while the transcript's own find bar never opened. The
 * focused element knows which pane it is in; that is the only pane that
 * matters.
 */
export function focusInsideConversationPane(): boolean {
  const focused = document.activeElement;
  return focused instanceof Element && Boolean(focused.closest("[data-conversation-pane]"));
}

/**
 * Put the caret in the sidebar's one conversation search box.
 *
 * Mac keeps its only list in the sidebar, so "go to the list search" from
 * anywhere in the shell — ⌘F, Escape out of a conversation — means this field.
 * Returns false where no such field exists (phone width, the K panel), so the
 * caller can decide what leaving means there instead of guessing.
 */
export function focusSessionSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>("[data-session-search]");
  if (!input) return false;
  input.focus({ preventScroll: true });
  input.select();
  return true;
}
