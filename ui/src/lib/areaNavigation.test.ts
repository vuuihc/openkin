import { describe, expect, it } from "vitest";
import { AREA_IDS } from "./areas";
import {
  SETTINGS_TAB_IDS,
  areaById,
  coldStartPhoneParent,
  normalizeSettingsTab,
  resolveArea,
  resolveAreaRoute,
  showsAreaTabs,
  type LocationLike,
} from "./areaNavigation";

// KIN-CONTINUE-003 / ux-unification-story-map.md: one route/parent table for
// the four areas. The source contract is the story map's "已有或新增 URL" table
// (lines 22-34) and the tab rule (line 44); these tests are its executable
// form. N1 is pure logic — no router, storage, window or i18n here.

/** Split a URL the way `window.location` would, hash discarded. */
function loc(url: string): LocationLike {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1
    ? { pathname: withoutHash, search: "" }
    : { pathname: withoutHash.slice(0, query), search: withoutHash.slice(query) };
}

/**
 * Every URL the story map assigns to an area.
 *
 * Parameterized rather than one test per path: the point is coverage of the
 * whole table, and a row added to `resolveAreaRoute` without an owner should
 * show up here as a new entry, not as a new test file.
 */
const STORY_ROUTES: Array<[url: string, area: string]> = [
  ["/", "conversations"],
  ["/sessions", "conversations"],
  ["/sessions?search=needle&status=pending&scope=archived", "conversations"],
  ["/new?cwd=%2FUsers%2Fowner%2Fproject", "conversations"],
  ["/inbox?focus=appr-1", "conversations"],
  ["/approvals?focus=question-1", "conversations"],
  ["/tasks/task-1", "conversations"],
  ["/tasks/task-1?focus=appr-1", "conversations"],
  ["/agent-sessions/session-1", "conversations"],
  ["/projects", "projects"],
  ["/projects/project-1", "projects"],
  ["/routines", "routines"],
  ["/routines?device=dev-1", "routines"],
  ["/machines/dev-1/tasks/task-9", "routines"],
  ["/machines/dev%2F1/tasks/task%2D9", "routines"],
  ["/settings", "settings"],
  ["/settings?tab=general", "settings"],
  ["/settings?tab=agents", "settings"],
  ["/settings?tab=providers", "settings"],
  ["/settings?tab=routing", "settings"],
  ["/settings?tab=advanced", "settings"],
  ["/settings?tab=operations", "settings"],
  ["/settings?tab=remote", "settings"],
  ["/settings?tab=notifications", "settings"],
  ["/agents", "settings"],
  ["/usage", "settings"],
  // React Router ignores one trailing slash, so the resolver must too.
  ["/sessions/", "conversations"],
];

describe("resolveArea", () => {
  it("resolves every story-map route into its owning area", () => {
    for (const [url, area] of STORY_ROUTES) {
      expect({ url, area: resolveArea(loc(url)) }).toEqual({ url, area });
    }
    // No path may resolve to an area that is not in the one table.
    for (const [url] of STORY_ROUTES) {
      expect({ url, known: AREA_IDS.includes(resolveArea(loc(url)) as never) }).toEqual({
        url,
        known: true,
      });
    }
  });

  // The reason this module exists: an unknown destination is not a
  // conversation. Silently classifying it as one is how a typo becomes a chat.
  it("rejects unknown, tray, incomplete and malformed dynamic paths without throwing", () => {
    const rejected = [
      "/tray",
      "/unknown",
      "/tasks",
      "/tasks/",
      "/agent-sessions",
      "/agent-sessions/",
      "/machines/dev-1/tasks",
      "/machines/dev-1/tasks/",
      "/machines//tasks/task-1",
      "/tasks/%E0%A4%A",
      "/projects/%",
      "/projects/a/b",
      "sessions",
      "",
    ];
    for (const url of rejected) {
      const location = loc(url);
      expect({ url, area: resolveArea(location) }).toEqual({ url, area: null });
      expect({ url, route: resolveAreaRoute(location) }).toEqual({ url, route: null });
      expect({ url, tabs: showsAreaTabs(location) }).toEqual({ url, tabs: false });
      expect({ url, parent: coldStartPhoneParent(location) }).toEqual({ url, parent: null });
    }
  });

  it("lets query and hash ride along without breaking pathname resolution", () => {
    expect(resolveArea({ pathname: "/tasks/task-1", search: "?focus=appr-1#card" })).toBe(
      "conversations",
    );
    expect(resolveArea({ pathname: "/tasks/task-1#card", search: "?focus=appr-1" })).toBe(
      "conversations",
    );
    expect(
      resolveAreaRoute({ pathname: "/tasks/task-1#card", search: "?focus=appr-1" }),
    ).toMatchObject({ name: "conversations.task", id: "task-1", focus: "appr-1" });
  });

  it("decodes a dynamic segment exactly once", () => {
    expect(resolveAreaRoute(loc("/projects/a%252Fb"))?.id).toBe("a%2Fb");
    // An escaped slash is part of the id; an unescaped one is a second segment
    // and is rejected above.
    expect(resolveAreaRoute(loc("/projects/a%2Fb"))?.id).toBe("a/b");
    expect(resolveAreaRoute(loc("/machines/dev%201/tasks/task%2D9"))).toMatchObject({
      device: "dev 1",
      id: "task-9",
    });
  });
});

describe("coldStartPhoneParent", () => {
  it("cold-start conversation and imported-session links fall back to the conversation root without losing focus or cwd", () => {
    // A task keeps its own focus; the synthesized parent is the bare collection.
    expect(resolveAreaRoute(loc("/tasks/task-1?focus=appr-1"))?.focus).toBe("appr-1");
    expect(coldStartPhoneParent(loc("/tasks/task-1?focus=appr-1"))).toBe("/sessions");
    expect(coldStartPhoneParent(loc("/agent-sessions/session-1"))).toBe("/sessions");

    // A draft keeps the cwd in the route it was given; the parent is the list.
    const draft = resolveAreaRoute(loc("/new?cwd=%2FUsers%2Fowner%2Fproject"));
    expect(draft?.cwd).toBe("/Users/owner/project");
    expect(coldStartPhoneParent(loc("/new?cwd=%2FUsers%2Fowner%2Fproject"))).toBe("/sessions");

    // The inbox and approvals hand their focus to the pending-resolution
    // destination, encoded once and not dropped.
    expect(coldStartPhoneParent(loc("/inbox?focus=appr-1"))).toBe("/sessions?focus=appr-1");
    expect(coldStartPhoneParent(loc("/approvals?focus=question-1"))).toBe(
      "/sessions?focus=question-1",
    );
    expect(coldStartPhoneParent(loc("/inbox?focus=a%26b"))).toBe("/sessions?focus=a%26b");
    expect(coldStartPhoneParent(loc("/inbox"))).toBe("/sessions");
    expect(coldStartPhoneParent(loc("/approvals"))).toBe("/sessions");

    // Roots synthesize nothing.
    expect(coldStartPhoneParent(loc("/"))).toBeNull();
    expect(coldStartPhoneParent(loc("/sessions?search=x"))).toBeNull();
  });

  it("cold-start project cover and remote routine run return to their exact area roots", () => {
    expect(coldStartPhoneParent(loc("/projects"))).toBeNull();
    expect(coldStartPhoneParent(loc("/projects/project-1"))).toBe("/projects");
    // The old project `?tab=` is cleared, never revived as a conversation list.
    expect(coldStartPhoneParent(loc("/projects/project-1?tab=chats"))).toBe("/projects");
    expect(coldStartPhoneParent(loc("/routines"))).toBeNull();
    expect(coldStartPhoneParent(loc("/machines/dev-1/tasks/task-9"))).toBe(
      "/routines?device=dev-1",
    );
  });

  it("cold-start machine task keeps its original device and settings sections return to general", () => {
    // The device in the path wins over one in the query; unrelated parameters
    // survive; focus is not invented on the routines list.
    expect(
      coldStartPhoneParent(loc("/machines/dev-1/tasks/task-9?device=dev-2&foo=bar&focus=appr-1")),
    ).toBe("/routines?device=dev-1&foo=bar");
    // The decoded device is encoded once, not twice.
    expect(coldStartPhoneParent(loc("/machines/dev%2F1/tasks/task-9"))).toBe(
      "/routines?device=dev%2F1",
    );

    for (const section of ["agents", "providers", "routing", "advanced", "operations"]) {
      expect(coldStartPhoneParent(loc(`/settings?tab=${section}`))).toBe("/settings");
    }
    // General settings is a root; retired and invalid ids normalize to it.
    expect(coldStartPhoneParent(loc("/settings"))).toBeNull();
    expect(coldStartPhoneParent(loc("/settings?tab=general"))).toBeNull();
    expect(coldStartPhoneParent(loc("/settings?tab=remote"))).toBeNull();
    expect(coldStartPhoneParent(loc("/settings?tab=notifications"))).toBeNull();
    expect(coldStartPhoneParent(loc("/settings?tab=nonsense"))).toBeNull();
  });

  it("legacy operations links name operations without implementing their redirect", () => {
    for (const url of ["/agents", "/usage"]) {
      expect(resolveAreaRoute(loc(url))).toMatchObject({
        area: "settings",
        name: "settings.operations",
        tab: "operations",
        root: false,
      });
      expect(coldStartPhoneParent(loc(url))).toBe("/settings?tab=operations");
      // The redirect is N2's; this slice only describes the destination.
      expect(showsAreaTabs(loc(url))).toBe(false);
    }
  });

  it("origin is not fabricated for task, import and draft routes", () => {
    // A cold start has no in-app entry behind it. Parameters that might name a
    // project or a machine are not promoted to a parent; a later navigation
    // layer supplies a real origin from history evidence.
    expect(coldStartPhoneParent(loc("/tasks/task-1?focus=appr-1&utm=push"))).toBe("/sessions");
    expect(coldStartPhoneParent(loc("/agent-sessions/session-1?from=project-1"))).toBe("/sessions");
    expect(coldStartPhoneParent(loc("/new?cwd=%2Froot&machine=node-1&model=opus"))).toBe(
      "/sessions",
    );
  });
});

describe("showsAreaTabs", () => {
  it("only the four roots and general settings show phone area tabs", () => {
    const shown = [
      "/",
      "/sessions",
      "/sessions?search=x&status=pending&scope=archived",
      "/sessions/",
      "/projects",
      "/routines",
      "/routines?device=dev-1",
      "/settings",
      "/settings?tab=general",
      // Query order and unrelated parameters do not change the answer.
      "/settings?foo=1&tab=general",
      "/settings?tab=general&foo=1",
      // A retired id resolves to general, which is the root.
      "/settings?tab=remote",
    ];
    for (const url of shown) {
      expect({ url, tabs: showsAreaTabs(loc(url)) }).toEqual({ url, tabs: true });
    }

    const hidden = [
      "/new",
      "/tasks/task-1",
      "/tasks/task-1?focus=appr-1",
      "/agent-sessions/session-1",
      "/inbox",
      "/inbox?focus=appr-1",
      "/approvals",
      "/projects/project-1",
      "/machines/dev-1/tasks/task-9",
      "/settings?tab=agents",
      "/settings?tab=providers",
      "/settings?tab=routing",
      "/settings?tab=advanced",
      "/settings?tab=operations",
      "/agents",
      "/usage",
      "/tray",
      "/unknown",
    ];
    for (const url of hidden) {
      expect({ url, tabs: showsAreaTabs(loc(url)) }).toEqual({ url, tabs: false });
    }
  });
});

describe("normalizeSettingsTab", () => {
  it("settings tab normalization keeps valid ids and retires invalid or deleted ids", () => {
    expect(SETTINGS_TAB_IDS).toEqual([
      "general",
      "agents",
      "providers",
      "routing",
      "advanced",
      "operations",
    ]);
    for (const id of SETTINGS_TAB_IDS) {
      expect({ id, tab: normalizeSettingsTab(id) }).toEqual({ id, tab: id });
    }
    for (const missing of [null, undefined, ""]) {
      expect(normalizeSettingsTab(missing)).toBe("general");
    }
    // Deleted panels and typos must not quietly reappear.
    for (const retired of ["remote", "notifications", "unknown", "GENERAL"]) {
      expect({ retired, tab: normalizeSettingsTab(retired) }).toEqual({
        retired,
        tab: "general",
      });
    }
  });

  it("keeps local agents distinct from the operations panel", () => {
    expect(normalizeSettingsTab("agents")).toBe("agents");
    expect(normalizeSettingsTab("agents")).not.toBe("operations");
    expect(resolveAreaRoute(loc("/settings?tab=agents"))).toMatchObject({
      name: "settings.section",
      tab: "agents",
    });
    expect(resolveAreaRoute(loc("/settings?tab=operations"))).toMatchObject({
      name: "settings.section",
      tab: "operations",
    });
  });
});

describe("table access", () => {
  it("exposes areaById without a second copy of the table", () => {
    expect(areaById("routines").root).toBe("/routines");
    expect(areaById("settings").icon).toBe("settings");
  });
});
