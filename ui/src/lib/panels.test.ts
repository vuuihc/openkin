import { describe, expect, it } from "vitest";
import { en, zh } from "../i18n";
import {
  PANELS,
  PANEL_IDS,
  availablePanels,
  isPanelAvailable,
  nextPanel,
  panelById,
  resolvePanel,
  type PanelContext,
} from "./panels";

/**
 * A context with both answers set, so a test can vary one without the other
 * silently deciding the outcome.
 */
function ctx(over: Partial<PanelContext> = {}): PanelContext {
  return { taskId: "task-1", remote: false, ...over };
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
    expect(availablePanels(ctx()).map((p) => p.id)).toEqual(["files", "pr"]);
    expect(availablePanels(ctx({ remote: true })).map((p) => p.id)).toEqual([
      "files",
      "pr",
      "publish",
    ]);
    expect(availablePanels(ctx({ taskId: null })).map((p) => p.id)).toEqual([]);
    expect(availablePanels(ctx({ taskId: null, remote: true })).map((p) => p.id)).toEqual([
      "publish",
    ]);
  });
});

describe("nextPanel", () => {
  it("opens the panel that was asked for", () => {
    expect(nextPanel(null, "pr")).toBe("pr");
    expect(nextPanel(null, "files")).toBe("files");
    expect(nextPanel(null, "publish")).toBe("publish");
  });

  it("closes it when it is already open", () => {
    expect(nextPanel("pr", "pr")).toBeNull();
    expect(nextPanel("files", "files")).toBeNull();
    expect(nextPanel("publish", "publish")).toBeNull();
  });

  // The panels are the same surface at the same z-index, so asking for one while
  // another is open replaces it rather than stacking — including the publish
  // sheet, which is reached from the workspace panel's own header.
  it("replaces the other panel rather than stacking", () => {
    expect(nextPanel("files", "pr")).toBe("pr");
    expect(nextPanel("pr", "files")).toBe("files");
    expect(nextPanel("files", "publish")).toBe("publish");
    expect(nextPanel("publish", "pr")).toBe("pr");
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
  });

  // The context moves under an open panel: the session is published, so the
  // checkout is the Hub's now and the publish sheet would be refused. It closes
  // itself rather than rendering in a state it is not allowed to be in.
  it("closes an open panel that stopped being offered", () => {
    expect(resolvePanel("publish", ctx())).toBeNull();
    expect(resolvePanel("files", ctx({ taskId: null, remote: true }))).toBeNull();
  });
});
