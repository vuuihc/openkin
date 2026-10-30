/**
 * The phone's conversation list, grouped the way the reference groups it.
 *
 * This screen used to be machine → time sections, which made the list a
 * chronological log. The question people actually open it with is "what was I
 * doing in this project", so the project is the heading and time is demoted to
 * each row's trailing label. Machines survive as a glyph on the rows that do
 * not run here — a phone has no room for a second heading level, and "remote"
 * is a property of a session, not a place you browse.
 *
 * Pure functions over (tasks, sessions): no clock, no storage, no DOM, so the
 * ordering rules are testable without rendering the page.
 */
import { type AgentSession, type Task } from "../api/client";
import { displayAgentSessionTitle } from "./agentSessionTitle";
import { displayUserPrompt } from "./attachments";

/** Rows with no cwd at all still need one bucket; it sorts last. */
export const UNASSIGNED_PROJECT = "__unassigned__";

/** The synthetic leading bucket pinned task rows live in. */
export const PINNED_BUCKET = "__pinned__";

/** The desktop sidebar files its no-cwd group under this name, not this one. */
const SIDEBAR_ROOT_PROJECT = "__root__";

export type PhoneSessionRow = {
  key: string;
  /** The row's own clock: when it last did something, not when it was opened. */
  at: number;
  title: string;
  agentId: string;
  /** Task status; imported agent sessions have none. */
  status?: string;
  /** Running on another machine, so the row can carry the machine glyph. */
  remote: boolean;
  task?: Task;
  session?: AgentSession;
};

export type PhoneProjectBucket = {
  key: string;
  label: string;
  rows: PhoneSessionRow[];
  lastActivityAt: number;
};

export type PhoneBucketCopy = {
  untitled: string;
  noProject: string;
};

function normCwd(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectKeyOf(cwd: string | undefined): string {
  return normCwd(cwd) || UNASSIGNED_PROJECT;
}

function tailOf(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

/** Same clock the sidebar sorts by: a finished task reads by when it finished. */
export function taskActivityAt(task: Task): number {
  return task.finished_at ?? task.started_at ?? task.created_at ?? 0;
}

/** Which projects the list is about: the ones in use, or the ones put away. */
export type PhoneBucketScope = "active" | "archived";

/**
 * The bucket key an archive entry answers to.
 *
 * The sidebar files the no-cwd group under its own sentinel, so its archive
 * entry has to answer to this module's key as well — otherwise archiving "no
 * project" in the drawer empties the drawer and leaves this page alone.
 */
function archivedKeyOf(cwd: string): string {
  const key = normCwd(cwd);
  return key === SIDEBAR_ROOT_PROJECT || key === "" ? UNASSIGNED_PROJECT : key;
}

export function phoneProjectBuckets(
  tasks: readonly Task[],
  sessions: readonly AgentSession[],
  selfDeviceId: string,
  copy: PhoneBucketCopy,
  /** Cwds the sidebar has archived. Their rows are dropped here for the same
   *  reason the sidebar drops them: archiving a project is how a person says
   *  "stop showing me this", and a list that keeps showing it is not a list. */
  archivedCwds: readonly string[] = [],
  /** "archived" is the other side of the same rule: a scope that shows only
   *  what was put away, so it can be restored without opening the drawer. */
  scope: PhoneBucketScope = "active",
): PhoneProjectBucket[] {
  const archived = new Set(archivedCwds.map(archivedKeyOf));
  const keepProject = (cwd: string | undefined): boolean => {
    const isArchived = archived.has(projectKeyOf(cwd));
    return scope === "archived" ? isArchived : !isArchived;
  };
  const byKey = new Map<string, PhoneProjectBucket>();

  const bucketFor = (cwd: string | undefined, session?: AgentSession): PhoneProjectBucket => {
    const key = projectKeyOf(cwd);
    const found = byKey.get(key);
    if (found) return found;
    const label =
      key === UNASSIGNED_PROJECT
        ? copy.noProject
        : session?.project_label?.trim() || tailOf(cwd) || copy.noProject;
    const made: PhoneProjectBucket = { key, label, rows: [], lastActivityAt: 0 };
    byKey.set(key, made);
    return made;
  };

  for (const task of tasks) {
    // A conversation is archived on its own, so it answers to its own flag
    // first: in the list it is gone even though its project is still filed,
    // and in the archive view it is present even though its project is not.
    if (task.archived_at ? scope !== "archived" : !keepProject(task.cwd)) continue;
    const at = taskActivityAt(task);
    const bucket = bucketFor(task.cwd);
    const device = (task.executing_device_id ?? "").trim();
    bucket.rows.push({
      key: task.id,
      at,
      title: task.title.trim() || displayUserPrompt(task.prompt) || copy.untitled,
      agentId: task.agent || "kin",
      status: task.status,
      remote: Boolean(device) && device !== selfDeviceId,
      task,
    });
    if (at > bucket.lastActivityAt) bucket.lastActivityAt = at;
  }

  for (const session of sessions) {
    if (!keepProject(session.cwd)) continue;
    const at = session.updated_at ?? 0;
    const bucket = bucketFor(session.cwd, session);
    const device = (session.device_id ?? "").trim();
    bucket.rows.push({
      key: session.id,
      at,
      title: displayAgentSessionTitle(session, copy.untitled),
      agentId: session.agent_id,
      remote: Boolean(device) && device !== selfDeviceId,
      session,
    });
    if (at > bucket.lastActivityAt) bucket.lastActivityAt = at;
  }

  // In the archived scope the stored list is the source of truth, not the
  // loaded rows: archiving is how a project you are done with is put away, so
  // its newest chat is often older than the hundred-row page. A project with
  // no rows still gets its heading — that heading is where Restore lives.
  if (scope === "archived") {
    for (const cwd of archivedCwds) {
      const key = archivedKeyOf(cwd);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        label: key === UNASSIGNED_PROJECT ? copy.noProject : tailOf(cwd) || copy.noProject,
        rows: [],
        lastActivityAt: 0,
      });
    }
  }

  for (const bucket of byKey.values()) {
    bucket.rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  }

  return [...byKey.values()]
    // Outside the archived scope a heading with no rows is noise; inside it,
    // an empty heading is the whole point.
    .filter((bucket) => scope === "archived" || bucket.rows.length > 0)
    .sort((a, b) => {
      // The no-project bucket is a catch-all, not a project: it goes last even
      // when its newest row is the newest thing on the screen.
      const aUnassigned = a.key === UNASSIGNED_PROJECT;
      const bUnassigned = b.key === UNASSIGNED_PROJECT;
      if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1;
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return a.label.localeCompare(b.label);
    });
}

/**
 * The stored archive entry a bucket came from, so the archived view can
 * restore it. Bucketing maps the sidebar's no-cwd sentinel onto this module's
 * key; restoring has to walk the same mapping backwards, or "restore" on the
 * no-project bucket would silently do nothing.
 */
export function archivedCwdFor(
  bucketKey: string,
  archivedCwds: readonly string[],
): string | undefined {
  return archivedCwds.find((cwd) => {
    // An empty entry maps to the no-project bucket but is not a path anything
    // could put back: returning it would make Restore a silent no-op, which is
    // the failure this function exists to prevent.
    if (!cwd) return false;
    return archivedKeyOf(cwd) === bucketKey;
  });
}

/**
 * Lift pinned task rows into a leading bucket and out of their project
 * buckets — the same rule the reference's Pinned section uses, so a pinned
 * row is seen once, at the top, not twice.
 */
export function withPinnedBucket(
  buckets: readonly PhoneProjectBucket[],
  pinnedIds: ReadonlySet<string>,
  label: string,
): PhoneProjectBucket[] {
  const pinned: PhoneSessionRow[] = [];
  const rest = buckets.flatMap((bucket) => {
    const rows = bucket.rows.filter((row) => {
      if (row.task && pinnedIds.has(row.task.id)) {
        pinned.push(row);
        return false;
      }
      return true;
    });
    if (rows.length === 0) return [];
    return rows.length === bucket.rows.length
      ? [bucket]
      : [{ ...bucket, rows }];
  });
  if (pinned.length === 0) return rest;
  return [
    {
      key: PINNED_BUCKET,
      label,
      rows: pinned,
      lastActivityAt: Math.max(0, ...pinned.map((row) => row.at)),
    },
    ...rest,
  ];
}

/**
 * Narrow already-loaded buckets to the search text.
 *
 * This runs twice per search: immediately over the rows the page already has
 * (so the list does not lag the keyboard), and again over the server's answer.
 * The second pass is why the predicate must never be *narrower* than the
 * daemon's `?q=`: a server row this filter cannot see would flash in and then
 * vanish, and if the request failed the page would say "no results" about a
 * conversation that exists. So the fields here are the daemon's own set —
 * title, prompt, cwd, agent, id for a task; title, cwd, agent id, external ref
 * for an imported session — plus the display title and the project heading.
 */
function rowMatches(row: PhoneSessionRow, needle: string): boolean {
  const fields = [
    row.title,
    row.agentId,
    row.task?.prompt,
    row.task?.cwd,
    row.task?.id,
    row.session?.title,
    row.session?.cwd,
    row.session?.agent_id,
    row.session?.external_ref,
  ];
  return fields.some((field) => Boolean(field) && field!.toLowerCase().includes(needle));
}

export function filterProjectBuckets(
  buckets: readonly PhoneProjectBucket[],
  query: string,
): PhoneProjectBucket[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...buckets];
  const out: PhoneProjectBucket[] = [];
  for (const bucket of buckets) {
    const headingMatches = bucket.label.toLowerCase().includes(needle);
    const rows = headingMatches ? bucket.rows : bucket.rows.filter((row) => rowMatches(row, needle));
    if (rows.length > 0) out.push({ ...bucket, rows });
  }
  return out;
}
