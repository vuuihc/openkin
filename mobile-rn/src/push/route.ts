/**
 * KIN-MOBILE-001 §8 / R7 — the routing policy for a tapped push.
 *
 * The node sends `{"aps":{…},"kin":{"kind","id","url"}}`
 * (`internal/apns/apns.go`, `payloadWith`). `url` is a web-console link; for a
 * waiting approval or question it names both the conversation and the card
 * (`internal/notify/notify.go`, `pendingLink`). This module answers one
 * question — where does that tap land — and nothing else: no notification
 * module, no navigation, no network. `toHref` turns the answer into the
 * expo-router href the caller pushes.
 *
 * `seen` is the caller's durable delivery record (AGENTS.md rule 14): calling
 * it claims the key and reports whether an earlier tap already claimed it. The
 * policy asks exactly once, before choosing a destination, so two taps of the
 * same banner reduce to one route.
 */

export type PushRoute =
  | {
      kind: "thread";
      taskId: string;
      focus?: { approvalId?: string; questionId?: string };
    }
  | { kind: "list" }
  | { kind: "ignore"; reason: string };

export type PushContext = {
  /** The Hub this phone is paired with now; null before pairing. */
  pairedOrigin: string | null;
  /** Claim `key`; true when an earlier tap already claimed it. */
  seen: (key: string) => boolean;
};

type Kin = { kind: string; id: string; url: string };

type TrustedLink = { taskId: string | null; focus: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hand-narrow the payload; `null` means malformed. */
function readKin(payload: unknown): Kin | null {
  if (!isRecord(payload)) return null;
  const kin = payload["kin"];
  if (!isRecord(kin)) return null;

  const kind = kin["kind"];
  if (typeof kind !== "string" || kind === "") return null;

  const id = kin["id"];
  if (id !== undefined && typeof id !== "string") return null;

  const url = kin["url"];
  if (url !== undefined && typeof url !== "string") return null;

  return { kind, id: id ?? "", url: url ?? "" };
}

/**
 * The conversation and card a node link names, or null when the link points
 * anywhere but the paired Hub. Relative links (a node with no base URL set)
 * resolve against the Hub, which cannot change the origin. Hermes' `URL` takes
 * no base argument, so the join is explicit.
 */
function readLink(raw: string, pairedOrigin: string): TrustedLink | null {
  if (raw === "") return null;

  let base: URL;
  try {
    base = new URL(pairedOrigin);
  } catch {
    return null;
  }
  // A push link is a web-console link; a `file:`/`kin:` origin is not a node.
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    try {
      url = new URL(`${base.origin}${raw}`);
    } catch {
      return null;
    }
  }
  if (url.origin !== base.origin) return null;

  const match = /\/tasks\/([^/]+)\/?$/.exec(url.pathname);
  let taskId: string | null = null;
  if (match) {
    try {
      const decoded = decodeURIComponent(match[1]);
      taskId = decoded === "" ? null : decoded;
    } catch {
      taskId = null;
    }
  }

  const focus = url.searchParams.get("focus");
  return { taskId, focus: focus === null || focus === "" ? null : focus };
}

export function routeForPush(payload: unknown, ctx: PushContext): PushRoute {
  if (ctx.pairedOrigin === null) {
    return { kind: "ignore", reason: "unpaired" };
  }

  const kin = readKin(payload);
  if (kin === null) return { kind: "list" };

  // An id-less payload cannot be claimed, so it is routed every time; every
  // kind in `notify.go` carries one.
  if (kin.id !== "" && ctx.seen(`${kin.kind}:${kin.id}`)) {
    return { kind: "ignore", reason: "duplicate" };
  }

  const link = readLink(kin.url, ctx.pairedOrigin);

  switch (kin.kind) {
    case "approval":
    case "question": {
      // The id names the waiting card, not the conversation; only the link
      // can name the conversation.
      if (link === null || link.taskId === null) return { kind: "list" };
      const taskId = link.taskId;
      const focusId = kin.id !== "" ? kin.id : link.focus;
      if (focusId === null) return { kind: "thread", taskId };
      return kin.kind === "approval"
        ? { kind: "thread", taskId, focus: { approvalId: focusId } }
        : { kind: "thread", taskId, focus: { questionId: focusId } };
    }

    case "task":
    case "quota": {
      // For these kinds the id is the conversation itself; the link is only a
      // fallback for a payload that left it out.
      const taskId = kin.id !== "" ? kin.id : link?.taskId ?? "";
      return taskId === "" ? { kind: "list" } : { kind: "thread", taskId };
    }

    case "worker": {
      // The id names the worker; the conversation comes from the link.
      const taskId = link?.taskId ?? "";
      return taskId === "" ? { kind: "list" } : { kind: "thread", taskId };
    }

    case "routine": {
      // A noteworthy routine report carries a task and links /tasks/<id>; a
      // one-shot failure links /routines and its id is the routine, which RN
      // has no surface for.
      const taskId = link?.taskId ?? "";
      return taskId === "" ? { kind: "list" } : { kind: "thread", taskId };
    }

    default:
      // A kind this build does not know is a safe list landing, never a throw.
      return { kind: "list" };
  }
}

/**
 * The expo-router href for a route, or null when the tap must not navigate.
 * `focus` is the same query parameter the web console reads
 * (`ui/src/App.machineTaskRedirect.test.ts:99-103`), so the thread screen can
 * reveal the waiting card without learning a second name.
 */
export function toHref(route: PushRoute): string | null {
  switch (route.kind) {
    case "thread": {
      const focus = route.focus?.approvalId ?? route.focus?.questionId;
      const base = `/thread/${encodeURIComponent(route.taskId)}`;
      return focus === undefined || focus === ""
        ? base
        : `${base}?focus=${encodeURIComponent(focus)}`;
    }
    case "list":
      return "/list";
    case "ignore":
      return null;
  }
}
