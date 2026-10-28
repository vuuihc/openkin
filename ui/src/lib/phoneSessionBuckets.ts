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

export function phoneProjectBuckets(
  tasks: readonly Task[],
  sessions: readonly AgentSession[],
  selfDeviceId: string,
  copy: PhoneBucketCopy,
  /** Cwds the sidebar has archived. Their rows are dropped here for the same
   *  reason the sidebar drops them: archiving a project is how a person says
   *  "stop showing me this", and a list that keeps showing it is not a list. */
  archivedCwds: readonly string[] = [],
): PhoneProjectBucket[] {
  // The sidebar files the no-cwd group under its own sentinel, so its archive
  // entry has to answer to this module's key as well — otherwise archiving
  // "no project" in the drawer empties the drawer and leaves this page alone.
  const archived = new Set(
    archivedCwds.map((cwd) => {
      const key = normCwd(cwd);
      return key === SIDEBAR_ROOT_PROJECT || key === "" ? UNASSIGNED_PROJECT : key;
    }),
  );
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
    if (archived.has(projectKeyOf(task.cwd))) continue;
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
    if (archived.has(projectKeyOf(session.cwd))) continue;
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

  for (const bucket of byKey.values()) {
    bucket.rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  }

  return [...byKey.values()]
    .filter((bucket) => bucket.rows.length > 0)
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

/** Case-insensitive match over what the row and its heading actually say. */
export function filterProjectBuckets(
  buckets: readonly PhoneProjectBucket[],
  query: string,
): PhoneProjectBucket[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...buckets];
  const out: PhoneProjectBucket[] = [];
  for (const bucket of buckets) {
    const headingMatches = bucket.label.toLowerCase().includes(needle);
    const rows = headingMatches
      ? bucket.rows
      : bucket.rows.filter(
          (row) =>
            row.title.toLowerCase().includes(needle) ||
            row.agentId.toLowerCase().includes(needle),
        );
    if (rows.length > 0) out.push({ ...bucket, rows });
  }
  return out;
}
