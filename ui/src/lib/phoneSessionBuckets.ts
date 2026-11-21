/**
 * The phone's conversation list, grouped the way the reference groups it.
 *
 * This screen used to be machine → time sections, which made the list a
 * chronological log. The question people actually open it with is "what was I
 * doing in this project", so the project is the heading and time is demoted to
 * each row's trailing label. The machine is the level above: the same project
 * worked on two machines is two histories, so each gets its own heading
 * instead of one fold that mixes them, and a row that does not run here still
 * carries its machine glyph when the heading is off screen.
 *
 * Pure functions over (tasks, sessions): no clock, no storage, no DOM, so the
 * ordering rules are testable without rendering the page.
 */
import { type AgentSession, type Task } from "../api/client";
import { displayAgentSessionTitle } from "./agentSessionTitle";
import { displayUserPrompt } from "./attachments";
import type { Machine } from "./devices";
import { applyTaskOrder } from "./taskOrder";

/** Rows with no cwd at all still need one bucket; it sorts last. */
export const UNASSIGNED_PROJECT = "__unassigned__";

/** The synthetic leading bucket pinned task rows live in. */
export const PINNED_BUCKET = "__pinned__";

/**
 * The synthetic trailing bucket each machine's imported sessions live in.
 *
 * An import is not a project: it has no status, pin or archive state, and
 * giving it a project heading would invent one. One bucket per machine, drawn
 * after that machine's projects and folded by default. The NUL keeps the key
 * out of the cwd namespace.
 */
export const IMPORTED_BUCKET_PREFIX = "imported\u0000";

export function isImportedBucket(key: string): boolean {
  return key.startsWith(IMPORTED_BUCKET_PREFIX);
}

/**
 * Whether a bucket is drawn folded.
 *
 * Searching force-opens every bucket: a matching row folded away reads as
 * "nothing found", and a click meant to open it would only change state the
 * query is ignoring. Projects keep their folds in the stored `collapsed` set,
 * the way the sidebar stores them; an imported group is folded until the
 * reader opens it, so its fold is the absence of an entry in `openImported` —
 * the opposite sense, which is why the two cannot share one set.
 */
export function isBucketCollapsed(options: {
  imported: boolean;
  stateKey: string;
  searching: boolean;
  collapsed: ReadonlySet<string>;
  openImported: ReadonlySet<string>;
}): boolean {
  if (options.searching) return false;
  return options.imported
    ? !options.openImported.has(options.stateKey)
    : options.collapsed.has(options.stateKey);
}

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
  /** The machine the row runs on, as the daemon reports it. Absent when the row
   *  names none, which is this machine. */
  deviceId?: string;
  task?: Task;
  session?: AgentSession;
};

export type PhoneProjectBucket = {
  key: string;
  label: string;
  /** The project's cwd; empty for the pinned and imported buckets, which are
   *  not places on a machine. For a project record with several roots this is
   *  the record's first root, the one the heading is keyed by. */
  cwd: string;
  /** Every root that files under this heading. A folder no record claims is
   *  its own one root; a record's roots travel together so archiving and
   *  restoring the heading act on all of them, never on half of it. */
  roots?: string[];
  rows: PhoneSessionRow[];
  lastActivityAt: number;
  /** Earliest task or session creation in the bucket, for the "date created"
   *  project order. */
  createdAt: number;
  /** A task in this bucket is still running or waiting, so the project sorts
   *  above idle ones in the "active first" order. */
  hasActiveTask: boolean;
  /** The machine this copy belongs to, set by `groupProjectBucketsByDevice`.
   *  Empty means this machine: a seeded local project record and the pinned
   *  bucket are not machine facts. */
  deviceId?: string;
};

/**
 * A project record, as the list's rules need it.
 *
 * `/api/projects` is the authority for a project's identity and name; a cwd is
 * only one of its addresses. The caller adapts the API type to this shape, so
 * this module stays free of the record's other fields and its endpoint.
 */
export type PhoneProjectRecord = {
  id: string;
  name: string;
  /** The record's roots, first one first. The first readable root is the
   *  heading's key, so the key does not depend on which root has rows. */
  roots: readonly string[];
};

/** The one heading a row files under, and the roots that heading covers. */
type BucketIdentity = {
  key: string;
  label: string;
  cwd: string;
  roots: string[];
  /** True when a local project record set the key and roots, rather than the
   *  cwd standing for itself. */
  merged: boolean;
};

/** One machine's projects, the phone list's top level. */
export type PhoneDeviceGroup = {
  id: string;
  /** The machine's own label; empty when the list has not named it. */
  label: string;
  isSelf: boolean;
  online: boolean;
  buckets: PhoneProjectBucket[];
  lastActivityAt: number;
  count: number;
};

export type PhoneBucketCopy = {
  untitled: string;
  noProject: string;
  /** The heading of one machine's imported sessions; the count is drawn
   *  separately, so a filtered list still says how many there really are. */
  imported: string;
};

function normCwd(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectKeyOf(cwd: string | undefined): string {
  return normCwd(cwd) || UNASSIGNED_PROJECT;
}

/** The bucket a cwd files under. Exported so a project with no loaded row can
 *  still be placed under the heading it belongs to. */
export function bucketKeyFor(cwd: string | undefined): string {
  return projectKeyOf(cwd);
}

/** Statuses that are over. A task in any other state keeps its project warm. */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

function isActiveStatus(status: string | undefined): boolean {
  return Boolean(status) && !TERMINAL_STATUSES.has(status!);
}

/** The two statuses that mean a task is waiting on the person. */
const NEEDS_YOU_STATUSES = new Set(["waiting_approval", "waiting_input"]);

/**
 * How much a row wants the reader, low first: needs you, still running, settled.
 *
 * A row that stops work outranks a row that merely finished later, which is the
 * order the reference groups by (rsi/UX-AUDIT.md risk 3). Imported sessions
 * carry no status and read as settled. This is the task-status vocabulary the
 * rest of this module already uses, not a second one: `taskCardStatus` is about
 * how a status is drawn, so it stays out of an ordering rule.
 */
function attentionRank(status: string | undefined): number {
  if (status && NEEDS_YOU_STATUSES.has(status)) return 0;
  if (isActiveStatus(status)) return 1;
  return 2;
}

/** Take the earliest non-zero timestamp, so a bucket remembers when its project
 *  was first seen, not when its newest chat ran. */
function rememberCreated(bucket: PhoneProjectBucket, at: number | undefined): void {
  if (!at || at <= 0) return;
  if (bucket.createdAt === 0 || at < bucket.createdAt) bucket.createdAt = at;
}

function tailOf(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

/**
 * A bucket's heading: the project record's name, else the folder's.
 *
 * A whitespace-only name is no name, so it falls through like a missing
 * record. `cwd` is the heading's own address — the record's first root when a
 * record claims it — so the folder fallback names the place the heading opens.
 * The record is still consulted for a remote row's name: the Hub's records
 * describe paths, and the person named that path the same way everywhere.
 */
function headingFor(
  cwd: string | undefined,
  record: PhoneProjectRecord | undefined,
  noProject: string,
): string {
  return (record?.name ?? "").trim() || tailOf(cwd) || noProject;
}

/**
 * The identity one conversation has across the two feeds.
 *
 * Kin's task row and the imported provider session row describe the same
 * conversation when they name the same machine and the same provider-side ref:
 * the task stores the ref its turns ran with, the imported row stores the ref
 * its catalog entry has. The title is deliberately not part of it — titles are
 * rewritten from the first message and drift, while the ref stays put. An
 * empty device means this machine on both sides, the same reading the row's
 * `remote` flag uses.
 */
function conversationKey(
  deviceId: string | undefined | null,
  ref: string | undefined | null,
  selfDeviceId: string,
): string | null {
  const value = (ref ?? "").trim();
  if (!value) return null;
  const device = (deviceId ?? "").trim() || selfDeviceId.trim();
  return `${device}\u0000${value}`;
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
   *  "stop showing me this", and a list that keeps showing it is not a list.
   *
   *  It is a *local* preference: the stored list has no device column, and the
   *  Hub's project records describe this machine's filesystem. Applying it to a
   *  remote machine's copy of the same path would archive a project on a
   *  machine the person never touched, so each row is filtered only when it
   *  runs here. */
  archivedCwds: readonly string[] = [],
  /** "archived" is the other side of the same rule: a scope that shows only
   *  what was put away, so it can be restored without leaving the list. It is
   *  this machine's archive, for the same reason. */
  scope: PhoneBucketScope = "active",
  /** The `/api/projects` record that claims a cwd, when one does.
   *
   *  The record is the project's own identity and name; a folder is only one
   *  of its addresses. A record can claim several roots, and the person reads
   *  that as one project: every root files under one heading keyed by the
   *  record's first root. The caller supplies the lookup so this module stays
   *  free of the record type and its API; with no lookup every cwd is its own
   *  project. */
  projectFor: (cwd: string | undefined) => PhoneProjectRecord | undefined = () => undefined,
  /** A bucket's manual order, keyed the way the list stores it. It replaces
   *  the attention/recency rule inside that bucket whole: a status change or a
   *  new message must not undo a move the person made. Imported sessions have
   *  no manual order — they are an index, not a project. */
  orders: Readonly<Record<string, readonly string[]>> | undefined = undefined,
  /** This browser's renames, keyed by task id. The caller reads storage; this
   *  module only composes the row, so the function stays pure and the search
   *  below inherits the override through `row.title`. Imported sessions have
   *  no task id and keep the title their agent index gave them. */
  localTitles: Readonly<Record<string, string>> = {},
): PhoneProjectBucket[] {
  const archived = new Set(archivedCwds.map(archivedKeyOf));
  const selfId = selfDeviceId.trim();
  const deviceOf = (id: string | undefined | null): string => (id ?? "").trim() || selfId;
  // A row with no device is this machine's. An explicit device is only this
  // machine's when the machine list proves it is: with no self id (the device
  // list or the version read failed) every named machine is remote, and the
  // safe mistake is to disable a local write, never to point one at the wrong
  // filesystem.
  const localDevice = (device: string): boolean => !device || (selfId !== "" && device === selfId);
  /**
   * The heading a row files under.
   *
   * A project record can name several roots, and the person reads that as one
   * project: every root lands in one bucket keyed by the record's *first*
   * root. The key is deliberately not "the root with the rows" — that would
   * move the heading, and with it the stored manual order and the archive
   * entry, whenever activity crossed roots. A cwd no record claims keeps its
   * own key, so every single-root project's key stays byte-identical to the
   * one its stored order, pin and archive entries already use.
   *
   * The record claims only rows that run on this machine: it describes this
   * machine's filesystem, and a remote machine's `/work/alpha` is not the same
   * directory. A remote row still borrows the record's *name* — a person names
   * the path, not the machine — but keeps its own key and one root, so two
   * remote roots never merge into one heading.
   */
  const identityOf = (cwd: string | undefined, device: string): BucketIdentity => {
    const record = projectFor(cwd);
    const roots: string[] = [];
    const rootKeys = new Set<string>();
    for (const root of record?.roots ?? []) {
      const rootKey = bucketKeyFor(root);
      if (rootKey === UNASSIGNED_PROJECT || rootKeys.has(rootKey)) continue;
      rootKeys.add(rootKey);
      roots.push(root);
    }
    const merged = localDevice(device) && roots.length > 0;
    const primary = merged ? roots[0] : undefined;
    const key = primary !== undefined ? projectKeyOf(primary) : projectKeyOf(cwd);
    if (key === UNASSIGNED_PROJECT) {
      return { key, label: copy.noProject, cwd: "", roots: [], merged: false };
    }
    return {
      key,
      label: headingFor(primary ?? cwd, record, copy.noProject),
      cwd: primary ?? cwd ?? "",
      roots: merged ? [...roots] : [cwd ?? ""],
      merged,
    };
  };
  const keepProject = (identity: BucketIdentity, device: string): boolean => {
    // One project, one archive entry: the heading is put away through its
    // first root, which is the entry `archivedCwdFor` finds and Restore
    // clears. A stale entry left on another root cannot hide half a heading
    // while its first root is still filed.
    const isArchived = localDevice(device) && archived.has(projectKeyOf(identity.cwd));
    return scope === "archived" ? isArchived : !isArchived;
  };
  /**
   * The bucket a row files under.
   *
   * In the archived scope a copy that runs on another machine needs its own
   * identity. A conversation can be archived on its own on the machine that ran
   * it, and that row then shows up here even though this machine's project is
   * not archived. Sharing the cwd key would let the remote row stand in for the
   * local project: its heading would borrow the local archive entry, and its
   * Restore button would unarchive a project on a machine the person is not
   * looking at. Outside the archived scope the copies are split by machine
   * before display, so the shared key is only a grouping detail there.
   */
  const bucketKey = (identity: BucketIdentity, device: string): string => {
    if (scope !== "archived" || localDevice(device)) return identity.key;
    return `${identity.key}\u0000device:${device}`;
  };
  const byKey = new Map<string, PhoneProjectBucket>();
  // The conversations already spoken for by a task row in this feed. An
  // imported row whose identity is in here is the same conversation; the task
  // is the row that carries status, pinning and archiving, so the import is
  // the copy that goes. It is built from the tasks that are rows — a task
  // filtered out of this scope leaves no duplicate behind.
  const claimed = new Set<string>();

  const bucketFor = (identity: BucketIdentity, device: string): PhoneProjectBucket => {
    const key = bucketKey(identity, device);
    const found = byKey.get(key);
    if (found) {
      // The local record is the heading's authority even when a remote copy of
      // the same path happened to create the bucket first. Its roots travel
      // with it so archive and restore act on the whole record.
      if (identity.merged) {
        found.label = identity.label;
        found.cwd = identity.cwd;
        found.roots = identity.roots;
      }
      return found;
    }
    const made: PhoneProjectBucket = {
      key,
      label: identity.label,
      cwd: identity.cwd,
      roots: identity.roots,
      rows: [],
      lastActivityAt: 0,
      createdAt: 0,
      hasActiveTask: false,
    };
    byKey.set(key, made);
    return made;
  };

  for (const task of tasks) {
    // A conversation is archived on its own, so it answers to its own flag
    // first: in the list it is gone even though its project is still filed,
    // and in the archive view it is present even though its project is not.
    // The project's archive is a local preference, so a remote task answers to
    // its own flag but never to this machine's project archive.
    const device = (task.executing_device_id ?? "").trim();
    const rowDevice = deviceOf(device);
    const filed = identityOf(task.cwd, rowDevice);
    if (task.archived_at ? scope !== "archived" : !keepProject(filed, rowDevice)) {
      continue;
    }
    const at = taskActivityAt(task);
    const bucket = bucketFor(filed, rowDevice);
    rememberCreated(bucket, task.created_at);
    if (isActiveStatus(task.status)) bucket.hasActiveTask = true;
    const identity = conversationKey(task.session_ref_device_id, task.session_ref, selfDeviceId);
    if (identity) claimed.add(identity);
    bucket.rows.push({
      key: task.id,
      at,
      title:
        localTitles[task.id] ||
        task.title.trim() ||
        displayUserPrompt(task.prompt) ||
        copy.untitled,
      agentId: task.agent || "kin",
      status: task.status,
      remote: Boolean(device) && device !== selfDeviceId,
      deviceId: device,
      task,
    });
    if (at > bucket.lastActivityAt) bucket.lastActivityAt = at;
  }

  for (const session of sessions) {
    const rawDevice = (session.device_id ?? "").trim();
    const device = deviceOf(rawDevice);
    if (!keepProject(identityOf(session.cwd, device), device)) continue;
    const identity = conversationKey(session.device_id, session.external_ref, selfDeviceId);
    if (identity && claimed.has(identity)) continue;
    const at = session.updated_at ?? 0;
    const key = IMPORTED_BUCKET_PREFIX + device;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: copy.imported,
        cwd: "",
        rows: [],
        lastActivityAt: 0,
        createdAt: 0,
        hasActiveTask: false,
      };
      byKey.set(key, bucket);
    }
    rememberCreated(bucket, session.first_seen_at);
    bucket.rows.push({
      key: session.id,
      at,
      title: displayAgentSessionTitle(session, copy.untitled),
      agentId: session.agent_id,
      remote: Boolean(device) && device !== selfDeviceId,
      deviceId: device,
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
      const filed = identityOf(cwd, "");
      // A record is one project: its archived entry is the first root's, so a
      // stale entry on a second root neither draws a heading of its own nor
      // resurrects a record the person has not put away.
      if (filed.merged && !archived.has(filed.key)) continue;
      const key = filed.merged ? filed.key : archivedKeyOf(cwd);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        label: filed.merged
          ? filed.label
          : key === UNASSIGNED_PROJECT
            ? copy.noProject
            : headingFor(cwd, projectFor(cwd), copy.noProject),
        cwd: filed.merged ? filed.cwd : key === UNASSIGNED_PROJECT ? "" : cwd,
        roots: filed.merged ? filed.roots : key === UNASSIGNED_PROJECT ? [] : [cwd],
        rows: [],
        lastActivityAt: 0,
        createdAt: 0,
        hasActiveTask: false,
      });
    }
  }

  // Inside a project the order answers "what needs me?" before "what did I last
  // touch?": a row that stops work (waiting for an approval or an answer) goes
  // above a row still running, which goes above one that merely finished later.
  // Recency and then key keep the order deterministic inside a rank.
  for (const bucket of byKey.values()) {
    bucket.rows.sort(
      (a, b) =>
        attentionRank(a.status) - attentionRank(b.status) ||
        b.at - a.at ||
        a.key.localeCompare(b.key),
    );
    if (orders && !isImportedBucket(bucket.key)) {
      bucket.rows = applyTaskOrder(bucket.rows, orders[bucket.key]);
    }
  }

  return (
    [...byKey.values()]
      // Outside the archived scope a heading with no rows is noise; inside it,
      // an empty heading is the whole point.
      .filter((bucket) => scope === "archived" || bucket.rows.length > 0)
      .sort((a, b) => {
        // Imports sit at the end of their machine's list, after every project:
        // they are the part a person goes looking for, not the daily surface.
        const aImported = isImportedBucket(a.key);
        const bImported = isImportedBucket(b.key);
        if (aImported !== bImported) return aImported ? 1 : -1;
        // The no-project bucket is a catch-all, not a project: it goes last even
        // when its newest row is the newest thing on the screen.
        const aUnassigned = a.key === UNASSIGNED_PROJECT;
        const bUnassigned = b.key === UNASSIGNED_PROJECT;
        if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1;
        if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        return a.label.localeCompare(b.label);
      })
  );
}

/**
 * The machine name a pinned row has to carry on its own face.
 *
 * Every other row sits under a machine heading, which is where the reader
 * learns where it runs. Pinning lifts the row out of that heading into the
 * page's leading section, so a remote pinned conversation would otherwise be
 * a row that looks local — the generic "remote" glyph says someone else runs
 * it but not who, and "who" is the question a pin is often about. A local row
 * keeps its empty answer: this machine needs no label.
 */
export function pinnedRowDeviceName(
  bucketKey: string,
  row: PhoneSessionRow,
  machines: readonly Machine[],
): string {
  if (bucketKey !== PINNED_BUCKET || !row.remote) return "";
  const id = (row.deviceId ?? "").trim();
  // The machine list can lag the row (a device that just went offline still
  // names itself on its tasks). The id is the fallback: it is what the heading
  // would have shown for an unknown machine.
  return machines.find((machine) => machine.id === id)?.label || id;
}

/**
 * Lift the flat project buckets into the phone list's three levels:
 * machine → project → conversation.
 *
 * `phoneProjectBuckets` deliberately stays flat: search, pins and archived
 * restore all ask questions about projects, and answering them per machine
 * would mean three copies of every rule. The machine is added here, from the
 * device each row already names, so the same project worked on two machines
 * gets one heading under each instead of merging two histories into one fold.
 *
 * A bucket with no rows (an archived project whose chats are older than the
 * loaded page) has no device of its own; it belongs to this machine, which is
 * the one holding the archive preference. Pinned rows are the page's own
 * section and are left out here — a pin is not a place on a machine.
 *
 * The two options separate the phone page from the Mac sidebar, which share
 * this function but not their reading of a machine. `order: "activity"` is the
 * phone's answer — what was used last leads, and this machine only breaks a
 * tie. `includeEmptyDevices` gives a machine that has never run anything its
 * own heading, which the phone needs because that heading is the only place
 * from which a chat can be started on that machine. Both default to today's
 * sidebar behaviour, so the column is unchanged.
 */
export function groupProjectBucketsByDevice(
  buckets: readonly PhoneProjectBucket[],
  machines: readonly Machine[],
  selfDeviceId: string,
  {
    order = "sidebar",
    includeEmptyDevices = false,
  }: { order?: "sidebar" | "activity"; includeEmptyDevices?: boolean } = {},
): PhoneDeviceGroup[] {
  const selfId = selfDeviceId.trim();
  const known = new Map(machines.map((machine) => [machine.id, machine]));
  const byDevice = new Map<string, PhoneProjectBucket[]>();

  for (const bucket of buckets) {
    if (bucket.key === PINNED_BUCKET) continue;
    if (bucket.rows.length === 0) {
      pushBucket(byDevice, selfId, { ...bucket, deviceId: selfId });
      continue;
    }
    const rowsByDevice = new Map<string, PhoneSessionRow[]>();
    for (const row of bucket.rows) {
      // A row that names this machine is already home; only an id that differs
      // is another device. An empty self id (the list has not loaded) keeps
      // every local row in the empty group rather than inventing one.
      const id = row.deviceId && row.deviceId !== selfId ? row.deviceId : selfId;
      const rows = rowsByDevice.get(id);
      if (rows) rows.push(row);
      else rowsByDevice.set(id, [row]);
    }
    for (const [id, rows] of rowsByDevice) {
      pushBucket(byDevice, id, {
        ...bucket,
        rows,
        deviceId: id,
        lastActivityAt: Math.max(0, ...rows.map((row) => row.at)),
      });
    }
  }

  const groups: PhoneDeviceGroup[] = [];
  for (const [id, deviceBuckets] of byDevice) {
    // Splitting a bucket by device changes when each copy was last touched: a
    // project with an old local conversation and a new remote one arrives in
    // the global order by the remote time, so the local copy has to be put
    // back where its own newest row says it belongs.
    deviceBuckets.sort((a, b) => {
      // The imported group is the machine's trailing shelf, not a project in
      // its recency order.
      const aImported = isImportedBucket(a.key);
      const bImported = isImportedBucket(b.key);
      if (aImported !== bImported) return aImported ? 1 : -1;
      return b.lastActivityAt - a.lastActivityAt || a.label.localeCompare(b.label);
    });
    const machine = known.get(id);
    let lastActivityAt = 0;
    for (const bucket of deviceBuckets) {
      if (bucket.lastActivityAt > lastActivityAt) lastActivityAt = bucket.lastActivityAt;
    }
    groups.push({
      id,
      label: machine?.label || id,
      isSelf: id === selfId,
      online: machine ? machine.online : false,
      buckets: deviceBuckets,
      lastActivityAt,
      count: deviceBuckets.reduce((n, bucket) => n + bucket.rows.length, 0),
    });
  }

  if (includeEmptyDevices) {
    // A machine with no conversations still needs a heading on the phone: the
    // heading is where its "new chat" action lives, and a machine that just
    // joined would otherwise be invisible until someone found it in the
    // composer's picker. This machine is keyed the way its rows were keyed, so
    // an empty list cannot produce a second "this machine" heading.
    for (const machine of machines) {
      const id = machine.isSelf ? selfId : machine.id;
      if (byDevice.has(id)) continue;
      groups.push({
        id,
        label: machine.label || id,
        isSelf: id === selfId,
        online: machine.online,
        buckets: [],
        lastActivityAt: 0,
        count: 0,
      });
    }
  }

  if (order === "activity") {
    // The phone's order: the machine used most recently leads. This machine is
    // a tie-break, not a permanent first row — a laptop that has not been
    // touched for a week should not sit above the one used an hour ago.
    groups.sort((a, b) => {
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return groups;
  }

  // The sidebar's order, unchanged: this machine first, then the machines that
  // can take work now, most recently busy first.
  groups.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.label.localeCompare(b.label);
  });
  return groups;
}

function pushBucket(
  byDevice: Map<string, PhoneProjectBucket[]>,
  id: string,
  bucket: PhoneProjectBucket,
): void {
  const found = byDevice.get(id);
  if (found) found.push(bucket);
  else byDevice.set(id, [bucket]);
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
  /** The pinned section is its own bucket for ordering purposes, so a drag
   *  there is stored and applied under `PINNED_BUCKET`. */
  orders: Readonly<Record<string, readonly string[]>> | undefined = undefined,
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
    // An already-empty bucket is a project heading seeded from the project
    // record, not a bucket whose rows all moved to Pinned; dropping it would
    // hide a project that has no conversation in the loaded page.
    if (rows.length === 0 && bucket.rows.length > 0) return [];
    return rows.length === bucket.rows.length ? [bucket] : [{ ...bucket, rows }];
  });
  if (pinned.length === 0) return rest;
  return [
    {
      key: PINNED_BUCKET,
      label,
      cwd: "",
      rows: applyTaskOrder(pinned, orders?.[PINNED_BUCKET]),
      lastActivityAt: Math.max(0, ...pinned.map((row) => row.at)),
      createdAt: 0,
      hasActiveTask: false,
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
    const rows = headingMatches
      ? bucket.rows
      : bucket.rows.filter((row) => rowMatches(row, needle));
    if (rows.length > 0) out.push({ ...bucket, rows });
  }
  return out;
}
