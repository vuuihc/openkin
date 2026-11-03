/**
 * The node's notification event, as the desktop shell receives it.
 *
 * After KIN-NOTIFY-001 the node fans every event out through one pipeline and
 * the shell only displays it. That makes this module the shell's whole policy:
 * validate what arrived, decide whether the reader is already looking at it,
 * and turn its link into a console path. Keeping it free of Electron is what
 * lets the policy be tested without a running app.
 */

export const NOTIFY_KINDS = [
  "approval",
  "question",
  "task",
  "quota",
  "routine",
  "worker",
  "test",
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyEvent = {
  kind: NotifyKind;
  id: string;
  url: string;
  title: string;
  body: string;
  task_id?: string;
  /**
   * The state this event names when one target has several (quota waiting →
   * resumed, task running → done). It is part of the dedupe identity: the
   * second state is news, and the banner it supersedes has a stable collapse
   * id on Apple's side instead.
   */
  status?: string;
};

const MAX_TITLE = 200;
const MAX_BODY = 600;

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Parse a `notify` bus message's data. Unknown kinds are dropped, not displayed:
 * a future node must not be able to make this shell show arbitrary text.
 */
export function parseNotifyEvent(data: unknown): NotifyEvent | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(NOTIFY_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const status =
    typeof raw.status === "string" && raw.status ? raw.status.slice(0, 40) : "";
  return {
    kind: kind as NotifyKind,
    id,
    url: typeof raw.url === "string" ? raw.url : "",
    title: clip(raw.title, MAX_TITLE),
    body: clip(raw.body, MAX_BODY),
    task_id: typeof raw.task_id === "string" && raw.task_id ? raw.task_id : undefined,
    ...(status ? { status } : {}),
  };
}

/**
 * The key one event is deduped by. Same kind, target, and state is the same
 * banner. A quota waiting → resumed pair is two events even though Apple
 * replaces one banner slot for both.
 */
export function notifyKey(ev: NotifyEvent): string {
  return `${ev.kind}:${ev.id}` + (ev.status ? `:${ev.status}` : "");
}

/**
 * Remember which events were already shown, so a rebroadcast is silent.
 *
 * Bounded on purpose: a long-lived shell sees an event for every task that
 * ends, and an unbounded set is a memory leak that looks like a feature. The
 * oldest key is evicted first; forgetting it can at worst re-show one old
 * banner, while dropping the bound would keep every id forever.
 */
export class NotifyDeduper {
  static readonly MAX_SEEN = 512;

  private seen = new Map<string, true>();

  /** Returns true when this event has not been seen before. */
  remember(ev: NotifyEvent): boolean {
    const key = notifyKey(ev);
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    if (this.seen.size > NotifyDeduper.MAX_SEEN) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  forget(kind: NotifyKind, id: string): void {
    const prefix = `${kind}:${id}`;
    for (const key of [...this.seen.keys()]) {
      if (key === prefix || key.startsWith(prefix + ":")) this.seen.delete(key);
    }
  }
}

/**
 * Whether the reader needs a banner. Being in front is not enough to suppress
 * one: only looking at the same task is. That is the rule the shell already
 * applied to finished tasks, now applied to every kind the node sends.
 */
export function shouldAnnounceNotify(
  ev: NotifyEvent,
  view: { focused: boolean; viewingTaskId: string | null },
): boolean {
  if (!view.focused) return true;
  return !(ev.task_id && view.viewingTaskId === ev.task_id);
}

/** Approve / Deny belong on an approval; every other kind only opens. */
export function notifyHasDecisionActions(kind: NotifyKind): boolean {
  return kind === "approval";
}

const KNOWN_PATHS = new Set(["/", "/inbox", "/routines", "/settings"]);
const TASK_PATH = /^\/tasks\/[A-Za-z0-9_-]+\/?$/;

/**
 * Turn the event's link into a path this window may open.
 *
 * The node writes absolute links from `ui.base_url`, which can be the Hub URL
 * even when this shell is served the console from localhost. The shell only
 * ever passes a path to `mainWindow.show`, so the host is dropped rather than
 * compared: whatever origin the link names, only a known console route is
 * opened, and `javascript:`, `file:`, or a third-party path becomes the inbox.
 */
export function safeNotifyPath(url: string, origin?: string): string {
  if (!url.trim()) return "/inbox";
  let base: URL | null = null;
  if (origin) {
    try {
      base = new URL(origin);
    } catch {
      base = null;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(url, base ?? "http://kin.local");
  } catch {
    return "/inbox";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "/inbox";
  const path = parsed.pathname;
  if (!KNOWN_PATHS.has(path) && !TASK_PATH.test(path)) return "/inbox";
  return path + parsed.search;
}

/** A bus message as the shell sees it. */
export type NotifyMessage = { kind: string; data: unknown };

/** Anything that can display a parsed event; `Notifier` is the real one. */
export type NotifySink = { onNotify(ev: NotifyEvent): void };

/**
 * Route a bus message to the sink. Returns true when it was a notification.
 *
 * This is the seam between the WebSocket and the notifier: the node's desktop
 * channel is the bus itself, so no APNs credential, device row, or provider
 * response is involved in reaching this Mac.
 */
export function routeNotifyMessage(msg: NotifyMessage, sink: NotifySink): boolean {
  if (msg.kind !== "notify") return false;
  const ev = parseNotifyEvent(msg.data);
  if (!ev) return false;
  sink.onNotify(ev);
  return true;
}
