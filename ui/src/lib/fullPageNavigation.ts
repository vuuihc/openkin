/**
 * A full-document navigation, named so the decision before it is testable.
 *
 * Relay connect is the one flow that replaces the whole document: the console
 * must boot from the new origin, so there is no router navigation and no way
 * back. What matters for the page is the step *before* the jump — whether other
 * drafts must be asked about first — and jsdom's `location.assign` is not
 * configurable, so tests need a seam at exactly one call. This is that seam;
 * nothing else about the jump is abstracted.
 */
export function leaveDocument(url: string): void {
  window.location.assign(url);
}
