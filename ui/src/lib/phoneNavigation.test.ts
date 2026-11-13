// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Location, NavigateFunction } from "react-router-dom";
import {
  bindPhoneHistoryEntry,
  phonePush,
  rememberListUrl,
  resetPhoneNavigation,
} from "./phoneNavigation";

/**
 * The phone's "the list is already my parent" evidence.
 *
 * A marker in location state alone is not enough: it can be copied onto a
 * later entry, and it can be left over from a previous document (an OAuth
 * round trip, a reload). The marker is minted for one push, bound to the
 * entry key React Router actually created, and checked against the list
 * evidence of this document. A bare `idx` is never the decision by itself.
 */

type Call = [unknown, unknown];
type Entry = { url: string; state?: Record<string, unknown> };

function recorder(): { calls: Call[]; navigate: NavigateFunction } {
  const calls: Call[] = [];
  const navigate = ((to: unknown, options?: unknown) => calls.push([to, options])) as NavigateFunction;
  return { calls, navigate };
}

function at(
  pathname: string,
  options: { search?: string; state?: unknown; key?: string } = {},
): Pick<Location, "pathname" | "search" | "state"> & { key: string } {
  return {
    pathname,
    search: options.search ?? "",
    state: options.state ?? null,
    key: options.key ?? `entry-${pathname}`,
  };
}

function seed(...entries: Entry[]): void {
  window.history.replaceState({ idx: 0, key: "entry-0", ...entries[0]?.state }, "", entries[0]!.url);
  entries.slice(1).forEach((entry, index) => {
    window.history.pushState(
      { idx: index + 1, key: `entry-${index + 1}`, ...entry.state },
      "",
      entry.url,
    );
  });
}

function markerOf(call: Call): Record<string, unknown> {
  const options = call[1] as { state?: Record<string, unknown> } | undefined;
  const marker = options?.state?.kinListParent;
  expect(marker).toBeTruthy();
  return marker as Record<string, unknown>;
}

beforeEach(() => {
  resetPhoneNavigation();
  window.history.replaceState({ idx: 0 }, "", "/");
  sessionStorage.clear();
});

describe("the list as a phone screen's parent", () => {
  it("stamps a destination pushed from the list and recognises it afterwards", () => {
    seed({ url: "/sessions?search=alpha" });
    rememberListUrl("/sessions?search=alpha");
    const { calls, navigate } = recorder();

    // The list pushes a project: the project keeps the list underneath.
    phonePush(navigate, at("/sessions", { search: "?search=alpha", key: "list-entry" }), "/projects/p1", {
      phone: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("/projects/p1");
    expect(calls[0]![1]).toMatchObject({ replace: undefined });
    const state = (calls[0]![1] as { state: Record<string, unknown> }).state;

    // The shell's location subscription binds the marker to the real entry.
    bindPhoneHistoryEntry(at("/projects/p1", { state, key: "project-entry" }));

    // From that project, pushing a conversation replaces it instead of
    // stacking the list a second time.
    phonePush(navigate, at("/projects/p1", { state, key: "project-entry" }), "/tasks/t1", {
      phone: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe("/tasks/t1");
    expect(calls[1]![1]).toMatchObject({ replace: true });
  });

  it("returns to the existing list by popping instead of stacking a second one", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/projects/p1", { phone: true });
    const state = (calls[0]![1] as { state: Record<string, unknown> }).state;
    bindPhoneHistoryEntry(at("/projects/p1", { state, key: "project-entry" }));

    // The command palette's Chats row from the project: the list is already
    // below, so one pop returns to it. Replacing the project with a list copy
    // would leave [list, list].
    phonePush(navigate, at("/projects/p1", { state, key: "project-entry" }), "/sessions", {
      phone: true,
    });
    expect(calls[1]).toEqual([-1, undefined]);
  });

  it("accepts a bound marker only while the entry really sits above the list", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/projects/p1", { phone: true });
    const state = (calls[0]![1] as { state: Record<string, unknown> }).state;
    // The router's real push: the document moves, the entry gets its stack
    // index, and the shell binds the marker to the key it was pushed for.
    window.history.pushState({ idx: 1, key: "project-entry", ...state }, "", "/projects/p1");
    bindPhoneHistoryEntry(at("/projects/p1", { state, key: "project-entry" }));

    phonePush(navigate, at("/projects/p1", { state, key: "project-entry" }), "/tasks/t1", {
      phone: true,
    });
    // Index 1 is directly above the list at index 0, so the list is the
    // parent and the destination replaces this screen rather than stacking a
    // second list under it.
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe("/tasks/t1");
    expect(calls[1]![1]).toMatchObject({ replace: true });
  });

  it("replaces a same-view list push instead of stacking the list on itself", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/sessions?search=beta", {
      phone: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("/sessions?search=beta");
    expect(calls[0]![1]).toMatchObject({ replace: true });
    expect((calls[0]![1] as { state?: unknown }).state).toBeUndefined();
  });

  it("keeps ordinary history on the Mac", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/tasks/t1", { phone: false });
    expect(calls).toEqual([["/tasks/t1", undefined]]);
  });

  it("synthesizes the list under a cold project with no list evidence", () => {
    seed({ url: "/projects/p1" });
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/projects/p1", { key: "cold-entry" }), "/tasks/t1", { phone: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe("/sessions");
    expect(calls[0]![1]).toMatchObject({ replace: true });
    expect(calls[1]![0]).toBe("/tasks/t1");
    expect(markerOf(calls[1]!)).toBeTruthy();
  });
});

describe("evidence that must not be trusted", () => {
  it("refuses a marker left over from a previous document", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();
    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/projects/p1", { phone: true });
    const stale = (calls[0]![1] as { state: Record<string, unknown> }).state;

    // A full-page navigation (OAuth, reload) starts a new document. The
    // sessionStorage list and the history entry's state both survive it.
    resetPhoneNavigation();
    seed({ url: "/sessions" }, { url: "/projects/p1", state: stale });
    rememberListUrl("/sessions");

    phonePush(navigate, at("/projects/p1", { state: stale, key: "project-entry" }), "/tasks/t1", {
      phone: true,
    });
    // The stale marker did not count: the list is synthesized again.
    expect(calls[1]![0]).toBe("/sessions");
    expect(calls[1]![1]).toMatchObject({ replace: true });
    expect(calls[2]![0]).toBe("/tasks/t1");
  });

  it("refuses a marker copied onto a different entry in the same document", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    const { calls, navigate } = recorder();
    phonePush(navigate, at("/sessions", { key: "list-entry" }), "/projects/p1", { phone: true });
    const state = (calls[0]![1] as { state: Record<string, unknown> }).state;
    bindPhoneHistoryEntry(at("/projects/p1", { state, key: "project-entry" }));

    // Another entry copies the state (a raw push that forwards `location.state`).
    phonePush(navigate, at("/projects/p1", { state, key: "some-other-entry" }), "/tasks/t1", {
      phone: true,
    });
    expect(calls[1]![0]).toBe("/sessions");
    expect(calls[1]![1]).toMatchObject({ replace: true });
  });

  it("accepts the same-entry replace that erased the marker, in this document", () => {
    seed({ url: "/sessions" });
    rememberListUrl("/sessions");
    window.history.pushState({ idx: 1, key: "cold" }, "", "/projects/p1");
    // setSearchParams(..., { replace: true }): same entry position, new state.
    window.history.replaceState({ idx: 1, key: "rewritten" }, "", "/projects/p1?tab=x");
    const { calls, navigate } = recorder();

    phonePush(
      navigate,
      at("/projects/p1", { search: "?tab=x", key: "rewritten" }),
      "/tasks/t1",
      { phone: true },
    );
    expect(calls[0]![0]).toBe("/tasks/t1");
    expect(calls[0]![1]).toMatchObject({ replace: true });
  });

  it("does not trust a bare index when the stored list came from another document", () => {
    seed({ url: "/sessions" }, { url: "/projects/p1" });
    rememberListUrl("/sessions");
    // New document: the module's nonce changes, sessionStorage's does not.
    const staleHtml = sessionStorage.getItem("kin.listNonce");
    expect(staleHtml).toBeTruthy();
    // Simulate the reload without clearing storage: only the nonce is stale.
    resetPhoneNavigation();
    seed({ url: "/sessions" }, { url: "/projects/p1" });
    sessionStorage.setItem("kin.listUrl", "/sessions");
    sessionStorage.setItem("kin.listIdx", "0");
    sessionStorage.setItem("kin.listNonce", String(staleHtml));
    const { calls, navigate } = recorder();

    phonePush(navigate, at("/projects/p1", { key: "project-entry" }), "/tasks/t1", { phone: true });
    expect(calls[0]![0]).toBe("/sessions");
    expect(calls[0]![1]).toMatchObject({ replace: true });
    expect(calls[1]![0]).toBe("/tasks/t1");
  });
});
