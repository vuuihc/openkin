/**
 * Which of the four areas owns a URL, what its phone cold-start parent is, and
 * whether the shell shows the area tabs.
 *
 * This is the executable form of two rows of the signed story map
 * (`docs/product/stories/ux-unification-story-map.md`): the route/parent table
 * and the rule that only area roots show the four tabs. N1 ships the contract;
 * N2/N3 wire it into the router and the shell. Nothing here navigates.
 *
 * Deliberately narrow: a `Location`-shaped `{ pathname, search }` in, plain
 * values out. No React, router, storage, history, `window` or i18n import — the
 * tests run in a plain Node process, and a resolver that can read the browser
 * is a resolver that can silently depend on where it happened to run.
 *
 * Unknown and malformed routes return `null`. Classifying them as Conversations
 * is how a typo becomes a chat; the story map says an unknown path is a safe
 * root *after* the auth gate, which is a later layer's decision to make, not
 * this resolver's.
 */
import { areaById, type AreaId } from "./areas";

export { areaById };
export type { AreaId };

/** The part of `Location` this contract reads. Hash is not an input. */
export type LocationLike = {
  pathname: string;
  search: string;
};

/**
 * Settings sections.
 *
 * The five current ids are exactly the ones `SettingsPrimitives.SettingsTabId`
 * already serves; `operations` is the future Agent-operations panel the signed
 * map adds. The component-local union cannot be imported here without pulling
 * React into a DOM-free module, so N2 replaces that union with this one. Until
 * then the two lists must agree on the current five.
 */
export const SETTINGS_TAB_IDS = [
  "general",
  "agents",
  "providers",
  "routing",
  "advanced",
  "operations",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export type AreaRouteName =
  | "conversations.collection"
  | "conversations.new"
  | "conversations.inbox"
  | "conversations.approvals"
  | "conversations.task"
  | "conversations.agentSession"
  | "projects.collection"
  | "projects.detail"
  | "routines.root"
  | "routines.machineTask"
  | "settings.root"
  | "settings.section"
  | "settings.operations";

/**
 * A resolved URL. One stable shape rather than a union per route: every field
 * is always present, and `null` says "this route does not carry one" — which is
 * what a shell wants when it forwards a focus or a device without asking which
 * route it is on.
 */
export type AreaRoute = {
  area: AreaId;
  name: AreaRouteName;
  /** Decoded dynamic segment: a task, session or project id. */
  id: string | null;
  /**
   * Decoded device: the `?device=` of the routines root, or the path segment of
   * a machine task.
   */
  device: string | null;
  /** Decoded `?focus=` on the routes that own one (inbox, approvals, task). */
  focus: string | null;
  /** Decoded `?cwd=` of the draft route. */
  cwd: string | null;
  /** The normalized settings tab; null outside settings. */
  tab: SettingsTabId | null;
  /**
   * True for the URLs that are an area root: `/`, `/sessions`, `/projects`,
   * `/routines`, `/settings`, and general settings. These synthesize no phone
   * parent and are the only URLs that show the area tabs.
   */
  root: boolean;
};

/**
 * Normalize a settings `?tab=` value.
 *
 * Deleted panels (`remote`, `notifications`) and unknown ids resolve to
 * general, so a retired section cannot quietly reappear. `agents` is the local
 * agents/roles section, never the Agent-operations panel.
 */
export function normalizeSettingsTab(value: string | null | undefined): SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value ?? "")
    ? (value as SettingsTabId)
    : "general";
}

/** `URLSearchParams` without a trailing hash being folded into the last value. */
function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.split("#", 1)[0]);
}

/**
 * Split a pathname into decoded-later segments.
 *
 * A query or hash appended to `pathname` (some callers pass a full URL tail) is
 * dropped rather than treated as part of a segment. One trailing slash is
 * ignored because React Router ignores it; an interior empty segment (`//`) is
 * malformed and rejected, as is a path that does not start at the root.
 */
function pathSegments(pathname: string): string[] | null {
  const path = pathname.split("#", 1)[0].split("?", 1)[0];
  if (!path.startsWith("/")) return null;
  if (path === "/") return [];
  const segments = path.slice(1).split("/");
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments.some((segment) => segment === "") ? null : segments;
}

/**
 * Decode one dynamic segment, once. A malformed escape is a rejected route,
 * not an exception in the navigation path.
 */
function decodeSegment(raw: string): string | null {
  try {
    const value = decodeURIComponent(raw);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function base(area: AreaId, name: AreaRouteName): AreaRoute {
  return {
    area,
    name,
    id: null,
    device: null,
    focus: null,
    cwd: null,
    tab: null,
    root: false,
  };
}

/**
 * The settings parent of a machine task: the routines list scoped to the device
 * in the path.
 *
 * The path device wins over a `device` in the query, and is encoded exactly
 * once through `URLSearchParams`. Other original parameters are preserved;
 * `focus` is not invented on the routines list (the story map only gives a
 * machine-task focus to the task itself).
 */
function machineTaskParent(location: LocationLike): string | null {
  const segments = pathSegments(location.pathname);
  if (!segments || segments.length !== 4) return null;
  const device = decodeSegment(segments[1]);
  if (!device) return null;
  const params = new URLSearchParams();
  params.set("device", device);
  for (const [key, value] of searchParams(location.search)) {
    if (key === "device" || key === "focus") continue;
    params.append(key, value);
  }
  return `/routines?${params.toString()}`;
}

/** Resolve a URL to its area, or `null` when no area owns it. */
export function resolveAreaRoute(location: LocationLike): AreaRoute | null {
  const segments = pathSegments(location.pathname);
  if (!segments) return null;
  const params = searchParams(location.search);
  const focus = params.get("focus") || null;

  if (segments.length === 0) {
    return { ...base("conversations", "conversations.collection"), root: true };
  }

  if (segments.length === 1) {
    switch (segments[0]) {
      case "sessions":
        return { ...base("conversations", "conversations.collection"), root: true };
      case "new":
        return { ...base("conversations", "conversations.new"), cwd: params.get("cwd") || null };
      case "inbox":
        return { ...base("conversations", "conversations.inbox"), focus };
      case "approvals":
        return { ...base("conversations", "conversations.approvals"), focus };
      case "projects":
        return { ...base("projects", "projects.collection"), root: true };
      case "routines":
        return {
          ...base("routines", "routines.root"),
          root: true,
          device: params.get("device") || null,
        };
      case "settings": {
        const tab = normalizeSettingsTab(params.get("tab"));
        return {
          ...base("settings", tab === "general" ? "settings.root" : "settings.section"),
          root: tab === "general",
          tab,
        };
      }
      // Legacy Agent-operations destinations. E4a redirects both to
      // `/settings?tab=operations`; naming the settings tab here lets the
      // shell describe the destination before the redirect lands.
      case "agents":
      case "usage":
        return { ...base("settings", "settings.operations"), tab: "operations" };
      default:
        return null;
    }
  }

  if (segments.length === 2) {
    const [head, segment] = segments;
    const id = decodeSegment(segment);
    if (!id) return null;
    if (head === "tasks") return { ...base("conversations", "conversations.task"), id, focus };
    if (head === "agent-sessions") {
      return { ...base("conversations", "conversations.agentSession"), id };
    }
    if (head === "projects") return { ...base("projects", "projects.detail"), id };
    return null;
  }

  if (segments.length === 4 && segments[0] === "machines" && segments[2] === "tasks") {
    const device = decodeSegment(segments[1]);
    const id = decodeSegment(segments[3]);
    if (!device || !id) return null;
    return { ...base("routines", "routines.machineTask"), id, device };
  }

  return null;
}

/** The area that owns a URL, or `null` for anything unknown or malformed. */
export function resolveArea(location: LocationLike): AreaId | null {
  return resolveAreaRoute(location)?.area ?? null;
}

/**
 * The parent a phone cold start should synthesize, or `null` when the URL is
 * already a root (or is not a route this contract owns).
 *
 * This is the no-origin fallback. Evidence of a real in-app origin — a project
 * cover a conversation was opened from, the settings section an imported
 * session came from — takes precedence in a later navigation layer. Nothing
 * here reads history or guesses an origin from query parameters.
 */
export function coldStartPhoneParent(location: LocationLike): string | null {
  const resolved = resolveAreaRoute(location);
  if (!resolved || resolved.root) return null;

  switch (resolved.name) {
    case "conversations.new":
    case "conversations.task":
    case "conversations.agentSession":
      return "/sessions";
    case "conversations.inbox":
    case "conversations.approvals":
      // Pending resolution owns the focus; until it names a task, the list is
      // the destination and the focus rides along. `encodeURIComponent` matches
      // `notificationRoute`'s existing encoding of the same value.
      return resolved.focus ? `/sessions?focus=${encodeURIComponent(resolved.focus)}` : "/sessions";
    case "projects.detail":
      return "/projects";
    case "routines.machineTask":
      return machineTaskParent(location);
    case "settings.section":
      return "/settings";
    case "settings.operations":
      return "/settings?tab=operations";
    default:
      return null;
  }
}

/**
 * Whether the shell shows the four area tabs at this URL.
 *
 * True only at the area roots and at general settings; query order and
 * unrelated preserved parameters do not change the answer. This describes the
 * intended shell contract — N1 mounts nothing.
 */
export function showsAreaTabs(location: LocationLike): boolean {
  return resolveAreaRoute(location)?.root === true;
}
