/**
 * The project each machine was last sent work in.
 *
 * The draft remembers the one place it is aimed at, which is enough while the
 * reader stays on one machine. Choosing another machine replaces that place;
 * coming back then needs this per-machine note, or the older place is lost and
 * the reader has to find the project again. Keyed by machine id, with the empty
 * id naming this machine — the same spelling the draft and the place picker use.
 *
 * Client-only and best-effort: a private window that refuses storage simply
 * forgets between visits, which is the behaviour before this file existed.
 */

const KEY = "kin_place_projects";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [machine, cwd] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof cwd === "string" && cwd.trim()) out[machine] = cwd;
    }
    return out;
  } catch {
    return {};
  }
}

/** The project this machine last worked in, or "" when none is remembered. */
export function rememberedProject(machineId: string): string {
  const map = read();
  // Own keys only: a stored machine id is untrusted input, and a prototype
  // key ("constructor", "toString") would otherwise hand back a function.
  return Object.hasOwn(map, machineId) ? map[machineId] ?? "" : "";
}

/** Remember where this machine works. An empty cwd forgets the entry. */
export function rememberProject(machineId: string, cwd: string): void {
  try {
    const map = read();
    const path = cwd.trim();
    if (path) map[machineId] = path;
    else delete map[machineId];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}
