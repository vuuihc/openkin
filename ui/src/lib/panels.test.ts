import { describe, expect, it } from "vitest";
import { en, zh } from "../i18n";
import {
  PANELS,
  PANEL_IDS,
  SHELL_VIEW,
  availablePanels,
  closeOpenPanel,
  isPanelAvailable,
  nextOpenPanel,
  panelById,
  panelForView,
  resolvePanel,
  type OpenPanel,
  type PanelContext,
} from "./panels";

/**
 * A context with every answer set, so a test can vary one without the others
 * silently deciding the outcome.
 */
function ctx(over: Partial<PanelContext> = {}): PanelContext {
  return { taskId: "task-1", remote: false, desktop: true, ...over };
}

describe("PANELS", () => {
  it("has one row per id, with no duplicates", () => {
    const ids = PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The union is derived from `PANEL_IDS`, so an id can only be added to both at
  // once — and the row is a separate edit that this walks for. A missing row is
  // a `panelById` throw in the render path, which is a blank page.
  it("knows every id, and has a row for each", () => {
    for (const id of PANEL_IDS) {
      expect({ id, row: panelById(id).id }).toEqual({ id, row: id });
    }
    expect(PANELS.map((p) => p.id).sort()).toEqual([...PANEL_IDS].sort());
  });

  // The table is data, so the one thing it cannot do is notice that its own
  // `titleKey` is a dotted path nobody translated — `t()` falls back to the path
  // string and the panel header reads `workspace.title`.
  it("names every panel in both locales", () => {
    const has = (catalog: unknown, path: string) => {
      let cur: unknown = catalog;
      for (const part of path.split(".")) {
        if (cur === null || typeof cur !== "object") return false;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === "string" && cur.trim() !== "";
    };
    for (const panel of PANELS) {
      expect({
        id: panel.id,
        en: has(en, panel.titleKey),
        zh: has(zh, panel.titleKey),
      }).toEqual({ id: panel.id, en: true, zh: true });
    }
  });
});

describe("isPanelAvailable", () => {
  it("offers the workspace and pull request panels for any session", () => {
    expect(isPanelAvailable("files", ctx())).toBe(true);
    expect(isPanelAvailable("pr", ctx())).toBe(true);
    // Including one whose checkout the Hub holds — the tree is what that panel
    // shows, and it is still the session in front of you.
    expect(isPanelAvailable("files", ctx({ remote: true }))).toBe(true);
    expect(isPanelAvailable("pr", ctx({ remote: true }))).toBe(true);
  });

  it("offers publishing only for a session running elsewhere", () => {
    expect(isPanelAvailable("publish", ctx({ remote: true }))).toBe(true);
    expect(isPanelAvailable("publish", ctx())).toBe(false);
  });

  it("offers the terminal only where there is a machine to run it on", () => {
    expect(isPanelAvailable("terminal", ctx())).toBe(true);
    expect(isPanelAvailable("terminal", ctx({ desktop: false }))).toBe(false);
    // Not a property of the session: the shell has one terminal, and it is there
    // whether or not a session is in front.
    expect(isPanelAvailable("terminal", ctx({ taskId: null }))).toBe(true);
  });

  it("offers nothing about a panel with no session", () => {
    expect(isPanelAvailable("files", ctx({ taskId: null, remote: true }))).toBe(false);
    expect(isPanelAvailable("pr", ctx({ taskId: null, remote: true }))).toBe(false);
    // The one exception: publishing is a property of where the session runs, and
    // the sheet is opened from a page that has one.
    expect(isPanelAvailable("publish", ctx({ taskId: null, remote: true }))).toBe(true);
  });
});

describe("availablePanels", () => {
  it("lists what is offered, in table order", () => {
    expect(availablePanels(ctx()).map((p) => p.id)).toEqual(["files", "pr", "terminal"]);
    expect(availablePanels(ctx({ remote: true })).map((p) => p.id)).toEqual([
      "files",
      "pr",
      "publish",
      "terminal",
    ]);
    expect(availablePanels(ctx({ taskId: null })).map((p) => p.id)).toEqual(["terminal"]);
    expect(availablePanels(ctx({ taskId: null, remote: true })).map((p) => p.id)).toEqual([
      "publish",
      "terminal",
    ]);
    // The phone loses exactly one row, and it is the terminal's.
    expect(availablePanels(ctx({ remote: true, desktop: false })).map((p) => p.id)).toEqual([
      "files",
      "pr",
      "publish",
    ]);
  });
});

describe("nextOpenPanel", () => {
  const session = "task-1";

  it("opens the panel that was asked for", () => {
    expect(nextOpenPanel(null, session, "pr")).toEqual({ view: session, id: "pr" });
    expect(nextOpenPanel(null, session, "files")).toEqual({ view: session, id: "files" });
  });

  it("closes it when it is already open", () => {
    const open: OpenPanel = { view: session, id: "pr" };
    expect(nextOpenPanel(open, session, "pr")).toBeNull();
  });

  // The panels are the same surface at the same z-index, so asking for one while
  // another is open replaces it rather than stacking — including across the two
  // places a panel can belong to, the session and the shell.
  it("replaces the other panel rather than stacking", () => {
    expect(nextOpenPanel({ view: session, id: "files" }, session, "pr")).toEqual({
      view: session,
      id: "pr",
    });
    expect(nextOpenPanel({ view: SHELL_VIEW, id: "terminal" }, session, "files")).toEqual({
      view: session,
      id: "files",
    });
    expect(nextOpenPanel({ view: session, id: "files" }, SHELL_VIEW, "terminal")).toEqual({
      view: SHELL_VIEW,
      id: "terminal",
    });
  });

  // The one thing that must not happen: a panel opened here and a panel opened
  // there both alive, both at `z-40`, one of them underneath the other with a
  // close button nobody can reach.
  it("leaves at most one panel open, whichever view asked", () => {
    let open: OpenPanel = null;
    for (const [view, id] of [
      [session, "files"],
      [SHELL_VIEW, "terminal"],
      ["task-2", "pr"],
      [session, "publish"],
    ] as const) {
      open = nextOpenPanel(open, view, id);
      expect(open === null ? [] : [open]).toHaveLength(1);
      expect(panelForView(open, view)).toBe(id);
    }
  });
});

describe("panelForView", () => {
  it("answers only for the view the panel belongs to", () => {
    const open: OpenPanel = { view: "task-1", id: "files" };
    expect(panelForView(open, "task-1")).toBe("files");
    expect(panelForView(open, "task-2")).toBeNull();
    expect(panelForView(open, SHELL_VIEW)).toBeNull();
    expect(panelForView(null, "task-1")).toBeNull();
  });

  // What makes switching sessions not carry a panel across, and not lose it
  // either: the value is untouched by the switch, so coming back finds it.
  it("still answers for its own view after another view was looked at", () => {
    const open: OpenPanel = { view: "task-1", id: "files" };
    expect(panelForView(open, "task-2")).toBeNull();
    expect(panelForView(open, "task-1")).toBe("files");
  });
});

describe("closeOpenPanel", () => {
  it("closes the view that asked", () => {
    expect(closeOpenPanel({ view: "task-1", id: "files" }, "task-1")).toBeNull();
  });

  it("leaves another view's panel alone", () => {
    const open: OpenPanel = { view: "task-1", id: "files" };
    expect(closeOpenPanel(open, "task-2")).toEqual(open);
    expect(closeOpenPanel(null, "task-1")).toBeNull();
  });
});

describe("resolvePanel", () => {
  it("has nothing to render when nothing is open", () => {
    expect(resolvePanel(null, ctx({ remote: true }))).toBeNull();
  });

  it("keeps an open panel that is still offered", () => {
    expect(resolvePanel("files", ctx())).toBe("files");
    expect(resolvePanel("pr", ctx())).toBe("pr");
    expect(resolvePanel("publish", ctx({ remote: true }))).toBe("publish");
    expect(resolvePanel("terminal", ctx())).toBe("terminal");
  });

  // The context moves under an open panel: the session is published, so the
  // checkout is the Hub's now and the publish sheet would be refused. It closes
  // itself rather than rendering in a state it is not allowed to be in.
  it("closes an open panel that stopped being offered", () => {
    expect(resolvePanel("publish", ctx())).toBeNull();
    expect(resolvePanel("files", ctx({ taskId: null, remote: true }))).toBeNull();
  });
});
