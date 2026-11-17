/**
 * One project's conversations, as rows.
 *
 * The project screen answers "what have I been doing here", so its list is the
 * project's Kin tasks plus the imported agent sessions recorded under the same
 * roots — the same two sources the phone list merges, narrowed to one project.
 * The rows keep the phone list's shape (`PhoneSessionRow`) on purpose: a row
 * that opens a session from the list and a row that opens the same session
 * from its project must name it, time it and mark it the same way.
 *
 * Sorting is by the row's own clock (`taskActivityAt` for a task,
 * `updated_at` for an imported session), newest first, with the key as the tie
 * break so the order is stable across renders. The limit is applied after the
 * merge: asking each source for the page size would let one source crowd the
 * other out of a list that is supposed to be chronological.
 */
import { type AgentSession, type Project, type Task } from "../api/client";
import { displayAgentSessionTitle } from "./agentSessionTitle";
import { taskActivityAt, type PhoneSessionRow } from "./phoneSessionBuckets";
import { taskDisplayTitle } from "./taskTitle";
import { getLocalTaskTitles } from "./taskTitles";

export type ProjectChatRow = PhoneSessionRow;

/**
 * A project's roots, trimmed and without blanks.
 *
 * The loader asks sessions for each root and the panel points "new chat" at the
 * first one; if each trimmed on its own, a root stored as `" /work/alpha "`
 * would be fetched under one spelling and opened under another, and the new
 * chat would land outside the project it was started from.
 */
export function projectRoots(project: Pick<Project, "roots"> | null): string[] {
  return (project?.roots ?? []).map((root) => root.trim()).filter(Boolean);
}

/**
 * Where the cover's "new chat" goes.
 *
 * One root: straight to the draft with that cwd, so the chat lands in the
 * project it was started from. More than one: the draft's own device/project
 * picker, because guessing the first root is how a chat lands outside the
 * project (KIN-PROJECT-001 D4). No root: nowhere to go, and the button must
 * not look usable.
 */
export type ProjectNewChatTarget =
  { kind: "cwd"; href: string } | { kind: "picker"; href: string } | { kind: "no-root" };

export function projectNewChatTarget(project: Pick<Project, "roots"> | null): ProjectNewChatTarget {
  const roots = projectRoots(project);
  if (roots.length === 0) return { kind: "no-root" };
  if (roots.length > 1) return { kind: "picker", href: "/new" };
  return { kind: "cwd", href: `/new?cwd=${encodeURIComponent(roots[0])}` };
}

/**
 * The merged rows, newest first.
 *
 * A task's name comes from `taskDisplayTitle`, so the cover's recent row draws
 * the same name as the list and the conversation header: a local rename
 * (`taskTitles.ts`) first, then the task's own title, then its prompt, then
 * the cover's generic `untitled`. `localTitles` is a parameter with the whole
 * map's shape rather than a storage read inside the loop, so the row builder
 * is a pure function of what it was handed; the default is the store at the
 * moment the rows are built, which is what the cover wants on open.
 */
export function projectChatRows(
  tasks: readonly Task[],
  sessions: readonly AgentSession[],
  copy: { untitled: string },
  selfDeviceId: string,
  limit = 100,
  localTitles: Record<string, string> = getLocalTaskTitles(),
): ProjectChatRow[] {
  const rows = new Map<string, ProjectChatRow>();

  for (const task of tasks) {
    const device = (task.executing_device_id ?? "").trim();
    rows.set(`task:${task.id}`, {
      key: task.id,
      at: taskActivityAt(task),
      title: taskDisplayTitle(task, localTitles) || copy.untitled,
      agentId: task.agent || "kin",
      status: task.status,
      remote: Boolean(device) && device !== selfDeviceId,
      task,
    });
  }

  for (const session of sessions) {
    const device = (session.device_id ?? "").trim();
    // The same imported session answers for each root the project owns, so the
    // caller may hand it over more than once; the id is what makes it one row.
    rows.set(`session:${session.id}`, {
      key: session.id,
      at: session.updated_at ?? 0,
      title: displayAgentSessionTitle(session, copy.untitled),
      agentId: session.agent_id,
      remote: Boolean(device) && device !== selfDeviceId,
      session,
    });
  }

  return [...rows.values()]
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/** The two feeds the project screen merges, as callables so the loader is testable. */
export interface ProjectChatsFeed {
  tasks: () => Promise<readonly Task[]>;
  sessions: (root: string) => Promise<readonly AgentSession[]>;
}

export interface ProjectChatsOutcome {
  /** Which project these rows answer for; the screen drops them when it moves. */
  projectId: string;
  rows: ProjectChatRow[];
  /**
   * When the newest imported session was first indexed, if there is one. The
   * cover's "last import" line answers a different question from the newest
   * conversation: a session can be re-read without being the most recent chat.
   */
  lastImportAt: number | null;
  /** At least one root failed, so the list is real but may be missing sessions. */
  partial: boolean;
  /** The task read failed; there is no list to show. */
  error: string | null;
}

/** The newest `first_seen_at` across the imported sessions, or null. */
export function latestImportAt(sessions: readonly AgentSession[]): number | null {
  let latest: number | null = null;
  for (const session of sessions) {
    const at = session.first_seen_at ?? 0;
    if (at > 0 && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Reads one project's two feeds and returns the merged rows.
 *
 * The task feed is the list's spine: if it fails, the tab says so instead of
 * showing a session-only list that looks complete. Each root's session read is
 * independent — one unreachable root leaves the other roots' sessions and the
 * tasks on screen and sets `partial`, because a half list that claims to be
 * whole is worse than one that admits it.
 *
 * `isCurrent` is checked after every await. Rows read for project A must never
 * land while project B is on screen, and that is exactly what a slower A
 * response would otherwise do. A superseded read returns `null` and writes
 * nothing.
 */
export async function loadProjectChats(args: {
  projectId: string;
  roots: readonly string[];
  feed: ProjectChatsFeed;
  copy: { untitled: string; loadFailed: string };
  selfDeviceId: string;
  limit?: number;
  /** The local rename map; omitted, the rows read the store when they are built. */
  localTitles?: Record<string, string>;
  isCurrent?: () => boolean;
}): Promise<ProjectChatsOutcome | null> {
  const current = () => (args.isCurrent ? args.isCurrent() : true);
  let tasks: readonly Task[];
  try {
    tasks = await args.feed.tasks();
  } catch (e) {
    if (!current()) return null;
    return {
      projectId: args.projectId,
      rows: [],
      lastImportAt: null,
      partial: false,
      error: e instanceof Error && e.message ? e.message : args.copy.loadFailed,
    };
  }
  if (!current()) return null;
  const settled = await Promise.allSettled(args.roots.map((root) => args.feed.sessions(root)));
  if (!current()) return null;
  const sessions = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  try {
    return {
      projectId: args.projectId,
      rows: projectChatRows(
        tasks,
        sessions,
        args.copy,
        args.selfDeviceId,
        args.limit,
        args.localTitles,
      ),
      lastImportAt: latestImportAt(sessions),
      partial: settled.some((result) => result.status === "rejected"),
      error: null,
    };
  } catch {
    // A row the console cannot shape is not a list. The retry box is honest;
    // a tab that renders half the rows and throws on the rest is not.
    return {
      projectId: args.projectId,
      rows: [],
      lastImportAt: null,
      partial: false,
      error: args.copy.loadFailed,
    };
  }
}
