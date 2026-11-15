// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Location, NavigateFunction } from "react-router-dom";
import { goBackToList, resolvePhoneBack } from "./phoneBack";
import { resetLeaveGuard, runGuardedNavigation, setLeaveGuard } from "./leaveGuard";
import { onGuardedLinkClick, phonePush, resetPhoneNavigation } from "./phoneNavigation";

/**
 * The phone's one back resolver (`ux-unification-story-map.md`, stack rules 4
 * and 5): an overlay closes first, then the page is asked, then the stack pops,
 * and only a cold detail falls back to the area root the signed table names. A
 * true root synthesizes nothing, so system Back leaves Kin.
 *
 * `leaveGuard.test.ts` owns the guard's own mechanics; this file asserts the
 * order the shell puts the layers in.
 */

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** A `NavigateFunction` that writes the same history shape React Router does,
 *  so `phonePush`'s index and marker evidence is real. */
function historyNavigate(to: unknown, options?: { replace?: boolean; state?: unknown }): void {
  if (typeof to === "number") {
    window.history.go(to);
    return;
  }
  const current = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  const idx = options?.replace ? current : current + 1;
  const state = {
    idx,
    key: `entry-${idx}-${Math.random().toString(36).slice(2)}`,
    usr: options?.state,
  };
  if (options?.replace) window.history.replaceState(state, "", to as string);
  else window.history.pushState(state, "", to as string);
}

/** The `location` React Router would hand `phonePush` at the current entry. */
function here(): Pick<Location, "pathname" | "search"> & { state?: unknown; key?: string } {
  const state = window.history.state as { usr?: unknown; key?: string } | null;
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    state: state?.usr,
    key: state?.key,
  };
}

beforeEach(() => {
  resetLeaveGuard();
  resetPhoneNavigation();
  document.body.innerHTML = "";
  window.history.replaceState({ idx: 0, key: "seed" }, "", "/");
  viewport(false);
});

afterEach(() => {
  resetLeaveGuard();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.history.replaceState({ idx: 0 }, "", "/");
});

describe("the phone back resolver, layer by layer", () => {
  it("a floating layer closes before the guard and the stack", () => {
    window.history.replaceState({ idx: 1, key: "detail" }, "", "/tasks/t1");
    const canLeave = vi.fn(() => false);
    setLeaveGuard(canLeave, false);
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "sheet");
    document.body.append(panel);
    try {
      // The overlay owns this back gesture; the guard is not consulted and
      // the stack does not move underneath it.
      expect(resolvePhoneBack().step).toBe("overlay");
      expect(canLeave).not.toHaveBeenCalled();
      const navigate = vi.fn();
      goBackToList(navigate as unknown as NavigateFunction);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      panel.remove();
    }
  });

  it("an unsaved editor blocks a stack pop", () => {
    window.history.replaceState({ idx: 1, key: "detail" }, "", "/tasks/t1");
    const canLeave = vi.fn(() => false);
    setLeaveGuard(canLeave, false);
    const navigate = vi.fn();

    // The resolver's second layer is the page's own answer.
    expect(resolvePhoneBack().step).toBe("guard");
    expect(canLeave).toHaveBeenCalledTimes(1);

    // The shell composes the same order: the refusal stops the pop and the
    // page stays mounted on its own entry.
    const refused = runGuardedNavigation(() =>
      goBackToList(navigate as unknown as NavigateFunction),
    );
    expect(refused).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/tasks/t1");

    // The approved path still proceeds.
    setLeaveGuard(() => true, false);
    const accepted = runGuardedNavigation(() =>
      goBackToList(navigate as unknown as NavigateFunction),
    );
    expect(accepted).toBe(true);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it("the stack pop wins over the area root", () => {
    window.history.replaceState({ idx: 1, key: "detail" }, "", "/tasks/t1");
    expect(resolvePhoneBack()).toEqual({ step: "pop" });
    const navigate = vi.fn();
    goBackToList(navigate as unknown as NavigateFunction);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it("a cold detail synthesizes the parent the signed table names", () => {
    const cases: Array<[string, string]> = [
      ["/tasks/t1", "/sessions"],
      ["/projects/p1", "/projects"],
      ["/machines/node-1/tasks/t1", "/routines?device=node-1"],
      ["/settings?tab=providers", "/settings"],
    ];
    for (const [url, target] of cases) {
      window.history.replaceState({ idx: 0, key: "cold" }, "", url);
      expect(resolvePhoneBack(), url).toEqual({ step: "root", target });
      const navigate = vi.fn();
      goBackToList(navigate as unknown as NavigateFunction);
      expect(navigate, url).toHaveBeenCalledWith(target, { replace: true });
    }
  });

  it("a true area root declines, so system Back leaves Kin", () => {
    for (const url of [
      "/sessions",
      "/projects",
      "/routines",
      "/settings",
      "/settings?tab=general",
    ]) {
      window.history.replaceState({ idx: 0, key: "root" }, "", url);
      expect(resolvePhoneBack(), url).toEqual({ step: "leave" });
      const navigate = vi.fn();
      goBackToList(navigate as unknown as NavigateFunction);
      expect(navigate, url).not.toHaveBeenCalled();
    }
  });

  it("a cross-area destination keeps the original entry underneath", () => {
    window.history.replaceState({ idx: 0, key: "root" }, "", "/projects");
    const navigate = vi.fn(historyNavigate) as unknown as NavigateFunction;
    phonePush(navigate, here(), "/projects/p1", { phone: true });
    expect(window.history.state.idx).toBe(1);
    phonePush(navigate, here(), "/machines/node-1/tasks/t1", { phone: true });
    expect(window.history.state.idx).toBe(2);

    // One pop returns to the project detail; the routines root is never
    // inserted between them.
    const back = vi.fn();
    goBackToList(back as unknown as NavigateFunction);
    expect(back).toHaveBeenCalledWith(-1);
    expect(back).not.toHaveBeenCalledWith("/routines?device=node-1", { replace: true });
  });

  it("a tab switch never asks the editor's guard", () => {
    window.history.replaceState({ idx: 0, key: "root" }, "", "/sessions");
    const canLeave = vi.fn(() => false);
    setLeaveGuard(canLeave, false);
    const navigate = vi.fn();
    const preventDefault = vi.fn();
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
    } as unknown as Parameters<typeof onGuardedLinkClick>[0];

    // Tabs are shown only at area roots, so the switch cannot be leaving an
    // editor; asking the guard there would be a question with no subject.
    const accepted = onGuardedLinkClick(
      event,
      navigate as unknown as NavigateFunction,
      { pathname: "/sessions", search: "" },
      "/projects",
    );
    expect(accepted).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(canLeave).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/projects", { replace: true, state: undefined });
  });
});

describe("goBackToList", () => {
  it("is the only back rule the detail pages write", () => {
    // Two back affordances on one screen must not disagree about the cold
    // fallback: a push there leaves the deep link in history, so the system
    // Back reopens the screen the reader just left.
    // `import.meta.url` resolves to the served path under some runners; the
    // working tree is the reliable anchor.
    const ui = existsSync(join(process.cwd(), "src/pages"))
      ? process.cwd()
      : join(process.cwd(), "ui");
    for (const page of ["TaskDetailPage", "ProjectDetailPage", "AgentSessionDetailPage"]) {
      const source = readFileSync(join(ui, "src/pages", `${page}.tsx`), "utf8");
      expect(source, page).toContain("goBackToList(navigate)");
      expect(source, page).not.toContain("window.history.state?.idx");
    }
  });
});
