import { describe, expect, it } from "vitest";
import {
  ROUTE_DEPTH,
  routeTransition,
  transitionMotion,
  type TransitionKind,
} from "./areaTransition";
import { resolveAreaRoute, type AreaRouteName, type LocationLike } from "./areaNavigation";

// S3: one surface settling, not a page reload. The kind is decided from the
// route table, not guessed from the URL: an area switch, a push into a detail,
// a pop back out, a detail-to-detail swap, or nothing at all when the content
// is drawn in place. These are plain values in, plain values out — no router,
// no window — for the same reason `areaNavigation` is: a classifier that can
// read the browser is a classifier that can depend on where it ran.

/** Split a URL the way `window.location` would, hash discarded. */
function loc(url: string): LocationLike {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1
    ? { pathname: withoutHash, search: "" }
    : { pathname: withoutHash.slice(0, query), search: withoutHash.slice(query) };
}

function kind(from: string, to: string): TransitionKind {
  return routeTransition(loc(from), loc(to));
}

describe("routeTransition", () => {
  it("classifies an area root switch as area", () => {
    expect(kind("/sessions", "/routines")).toBe("area");
    expect(kind("/projects", "/routines")).toBe("area");
    expect(kind("/routines", "/settings")).toBe("area");
  });

  it("classifies a root to detail move as push", () => {
    expect(kind("/sessions", "/tasks/t1")).toBe("push");
    expect(kind("/projects", "/projects/p1")).toBe("push");
    expect(kind("/routines", "/machines/dev-1/tasks/t1")).toBe("push");
  });

  it("classifies Back from a detail to its root as pop", () => {
    expect(kind("/tasks/t1", "/sessions")).toBe("pop");
    expect(kind("/projects/p1", "/projects")).toBe("pop");
    expect(kind("/machines/dev-1/tasks/t1", "/routines")).toBe("pop");
  });

  it("classifies detail to detail in the same area as swap", () => {
    expect(kind("/tasks/t1", "/tasks/t2")).toBe("swap");
    // Session tabs mix the two detail shapes; either way it is a content swap.
    expect(kind("/tasks/t1", "/agent-sessions/s1")).toBe("swap");
    expect(kind("/agent-sessions/s1", "/agent-sessions/s2")).toBe("swap");
  });

  it("treats settings sections as in place", () => {
    // `/settings?tab=agents` is a section of one page, not a pushed screen.
    expect(kind("/settings", "/settings?tab=agents")).toBe("none");
    expect(kind("/settings?tab=agents", "/settings?tab=providers")).toBe("none");
    expect(kind("/settings?tab=agents", "/settings")).toBe("none");
    expect(kind("/settings", "/agents")).toBe("none");
  });

  it("treats the draft as an in place surface", () => {
    // `/new` is the draft drawn in place; a push would lie about the product.
    expect(kind("/sessions", "/new")).toBe("none");
    expect(kind("/new", "/sessions")).toBe("none");
    expect(kind("/new", "/tasks/t1")).toBe("push");
  });

  it("treats inbox, approvals and the retired projects root as in place", () => {
    // Both redirect to `/sessions`; animating them would flash a direction the
    // reader never travelled.
    expect(kind("/sessions", "/inbox?focus=x")).toBe("none");
    expect(kind("/sessions", "/approvals?focus=q")).toBe("none");
    expect(kind("/inbox?focus=x", "/approvals?focus=q")).toBe("none");
    // KIN-CONTRACT-001: `/projects` redirects to the same collection.
    expect(kind("/sessions", "/projects")).toBe("none");
  });

  it("crosses areas from a detail as area", () => {
    expect(kind("/tasks/t1", "/routines")).toBe("area");
    expect(kind("/projects/p1", "/settings?tab=agents")).toBe("area");
  });

  it("ignores query and focus changes on the same route", () => {
    expect(kind("/tasks/t1", "/tasks/t1?focus=a1")).toBe("none");
    expect(kind("/tasks/t1?focus=a1", "/tasks/t1?focus=a2")).toBe("none");
    expect(kind("/sessions?search=needle&status=pending", "/sessions")).toBe("none");
    expect(kind("/routines?device=dev-1", "/routines?device=dev-2")).toBe("none");
  });

  it("returns none for an unknown route", () => {
    expect(kind("/nope", "/sessions")).toBe("none");
    expect(kind("/sessions", "/nope")).toBe("none");
    expect(kind("/nope", "/also-nope")).toBe("none");
    expect(kind("/tray", "/sessions")).toBe("none");
    // React Router ignores one trailing slash, so an address and its slashed
    // spelling are the same place and must not re-enter.
    expect(kind("/sessions", "/sessions/")).toBe("none");
  });

  it("every route name has a depth", () => {
    // One representative URL per row of the route table. A name added to
    // `resolveAreaRoute` without a depth here fails this test (and, because
    // the table is `Record<AreaRouteName, 0 | 1>`, fails to compile first).
    const urls = [
      "/sessions",
      "/new",
      "/inbox",
      "/approvals",
      "/tasks/t1",
      "/agent-sessions/s1",
      "/projects",
      "/projects/p1",
      "/routines",
      "/machines/dev-1/tasks/t1",
      "/settings",
      "/settings?tab=agents",
      "/agents",
    ];
    const names = new Set<AreaRouteName>();
    for (const url of urls) {
      const route = resolveAreaRoute(loc(url));
      expect({ url, route: route !== null }).toEqual({ url, route: true });
      if (route) names.add(route.name);
    }
    expect([...names].sort()).toEqual(Object.keys(ROUTE_DEPTH).sort());
    for (const depth of Object.values(ROUTE_DEPTH)) expect([0, 1]).toContain(depth);

    // The table itself, in the contract's words: the in-place surfaces are
    // depth 0, and only a detail page is pushed.
    expect(ROUTE_DEPTH).toEqual({
      "conversations.collection": 0,
      "conversations.new": 0,
      "conversations.inbox": 0,
      "conversations.approvals": 0,
      "conversations.task": 1,
      "conversations.agentSession": 1,
      "conversations.projectCover": 1,
      "routines.root": 0,
      "routines.machineTask": 1,
      "settings.root": 0,
      "settings.section": 0,
      "settings.operations": 0,
    });
  });
});

describe("transitionMotion", () => {
  it("reduced motion turns area push and pop into fade", () => {
    for (const motion of ["area", "push", "pop"] as const) {
      expect(transitionMotion(motion, false)).toBe(motion);
      expect(transitionMotion(motion, true)).toBe("fade");
    }
    // A swap and an in-place change stay silent for everyone: the content
    // changes, the page does not reload.
    expect(transitionMotion("none", false)).toBe("none");
    expect(transitionMotion("none", true)).toBe("none");
    expect(transitionMotion("swap", false)).toBe("none");
    expect(transitionMotion("swap", true)).toBe("none");
  });
});
