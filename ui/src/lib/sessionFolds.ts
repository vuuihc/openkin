/**
 * Which project groups the conversation list has folded.
 *
 * The list has one fold state per place, not per shell: the same project folded
 * in the Mac sidebar is folded in the phone page, and a reload keeps it. The
 * key carries the device because the same cwd can be a heading under two
 * machines, and folding one must not fold the other. What a group nobody has
 * folded yet does is `sessionListFolds.ts`'s rule: only the project holding
 * the newest conversation opens, and imported groups stay folded until
 * someone opens them.
 */
const KEY = "kin_session_folds";

export function readSessionFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean" && k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember one group's open state. The list re-reads the map on its own tick,
 *  so this function has no listener of its own. */
export function setSessionFold(stateKey: string, open: boolean): void {
  try {
    const folds = readSessionFolds();
    folds[stateKey] = open;
    localStorage.setItem(KEY, JSON.stringify(folds));
  } catch {
    // A private window or a full quota loses the preference, not the list.
  }
}
