/**
 * The conversation a cold start should reopen.
 *
 * Keep-alive covers switching inside the app; this is the one that survives a
 * quit. Only the id is stored — the conversation itself is re-read from the
 * daemon, so a task that was deleted elsewhere falls back like any other
 * missing one (the detail page says so, and the id is dropped on the 404).
 */
const KEY = "kin.lastConversation";

export function rememberLastConversation(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Private mode or a full quota: resuming is best-effort, not a feature
    // that may break the conversation the reader is in.
  }
}

export function lastConversation(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Forget the stored id, or only if it still names `id`. */
export function forgetLastConversation(id?: string): void {
  try {
    if (id && lastConversation() !== id) return;
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}
