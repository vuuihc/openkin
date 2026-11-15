/**
 * What `?focus=` means, resolved against the inbox as it is at this render.
 *
 * The push notification carries the id of one item, and landing on it means
 * three things at once: ring it, put it on screen, and let the keys act on it.
 * `missing` is the fourth outcome and it is the one that used to be silent —
 * handled on another device, expired, or simply outside the loaded window all
 * drew an ordinary inbox with no explanation, which reads as a broken link
 * rather than as an answer about that one item.
 *
 * A pure function because the page cannot be tested here (the tree has no DOM
 * environment by design) and because the four outcomes are the whole contract:
 * the component only has to draw them.
 */
export type InboxFocus =
  | { kind: "none" }
  | { kind: "approval"; id: string; idx: number }
  | { kind: "question"; id: string }
  | { kind: "missing"; id: string };

export function resolveInboxFocus(
  focusId: string | null,
  approvals: readonly { id: string }[],
  questions: readonly { id: string }[],
): InboxFocus {
  if (!focusId) return { kind: "none" };
  const idx = approvals.findIndex((a) => a.id === focusId);
  if (idx >= 0) return { kind: "approval", id: focusId, idx };
  if (questions.some((q) => q.id === focusId)) return { kind: "question", id: focusId };
  return { kind: "missing", id: focusId };
}

/** The id a landed deep link named, or `null` when there is nothing to land on. */
export function focusedId(focus: InboxFocus): string | null {
  return focus.kind === "approval" || focus.kind === "question" ? focus.id : null;
}
