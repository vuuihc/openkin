/**
 * Where the reader was on a project cover.
 *
 * The cover is a scroll container that unmounts when a conversation opens, so
 * "return to where I was" (KIN-PROJECT-001, step 6) needs the position kept
 * outside React. sessionStorage, not localStorage: this is one tab's place in
 * one visit, not a preference to carry to the next launch. A browser that
 * refuses storage (private mode, blocked site data) must not take the page
 * with it, so both sides are guarded.
 */

const KEY = "kin_project_scroll:";

function key(id: string): string {
  return `${KEY}${id}`;
}

export function readProjectScroll(id: string): number {
  if (!id) return 0;
  try {
    const raw = window.sessionStorage.getItem(key(id));
    const top = raw === null ? 0 : Number(raw);
    return Number.isFinite(top) && top > 0 ? top : 0;
  } catch {
    return 0;
  }
}

export function writeProjectScroll(id: string, top: number): void {
  if (!id || !Number.isFinite(top)) return;
  try {
    window.sessionStorage.setItem(key(id), String(Math.max(0, Math.round(top))));
  } catch {
    // See the file note: a storage failure is not a page failure.
  }
}
