/**
 * The last cover a reader saw, per project.
 *
 * The cover is the screen someone opens after a few days away, often on a
 * laptop that has just lost its network. The daemon cannot answer then, and an
 * empty cover is a worse answer than a slightly old one: the contract asks for
 * the cached name and path offline, and for the overview to keep its last
 * content instead of falling back to a skeleton (KIN-PROJECT-001 steps 1–3).
 *
 * This is a convenience, not a source of truth. Everything cached here is
 * re-read from the daemon when it can be, and the truth stays in the project
 * record, the pulse and the conversation feeds. Storage is per-browser (it
 * never leaves this device), so a miss is normal — private windows and cleared
 * site data both make `sessionStorage` throw or come back empty, and the cover
 * must render correctly without it.
 */
import type { Project, ProjectPulse, Routine } from "../api/client";
import type { ProjectChatRow } from "./projectChats";

export type ProjectCoverCache = {
  project: Project;
  pulse: ProjectPulse | null;
  routines: Routine[];
  /** A read succeeded, so "no routines" is an answer and not a gap. */
  routinesLoaded: boolean;
  latest: ProjectChatRow | null;
  lastImportAt: number | null;
  /** A read succeeded, so "no conversations" is an answer and not a gap. */
  activityLoaded: boolean;
  /** When the cached project record was last read from the daemon. */
  savedAt: number;
};

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // A blocked storage accessor throws rather than returning undefined.
    return null;
  }
}

function key(projectId: string): string {
  return `kin_project_cover:${projectId}`;
}

export function readProjectCover(
  projectId: string,
  storage: Store | null = store(),
): ProjectCoverCache | null {
  if (!projectId || !storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key(projectId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectCoverCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const project = parsed.project;
    if (!project || typeof project.id !== "string" || project.id !== projectId) return null;
    const routines = Array.isArray(parsed.routines) ? parsed.routines : [];
    return {
      project,
      pulse: parsed.pulse ?? null,
      routines,
      // Older payloads did not carry the flag; their data is the evidence.
      routinesLoaded:
        typeof parsed.routinesLoaded === "boolean" ? parsed.routinesLoaded : routines.length > 0,
      latest: parsed.latest ?? null,
      lastImportAt:
        typeof parsed.lastImportAt === "number" && parsed.lastImportAt > 0
          ? parsed.lastImportAt
          : null,
      activityLoaded:
        typeof parsed.activityLoaded === "boolean"
          ? parsed.activityLoaded
          : Boolean(parsed.latest || parsed.lastImportAt),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeProjectCover(
  projectId: string,
  cover: ProjectCoverCache,
  storage: Store | null = store(),
): void {
  if (!projectId || !storage) return;
  try {
    storage.setItem(key(projectId), JSON.stringify(cover));
  } catch {
    // Full or blocked storage is not the cover's problem.
  }
}

export function clearProjectCover(projectId: string, storage: Store | null = store()): void {
  if (!projectId || !storage) return;
  try {
    storage.removeItem(key(projectId));
  } catch {
    // Ignore: a stale entry costs one stale first paint, nothing more.
  }
}
