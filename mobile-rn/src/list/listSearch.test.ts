import { describe, expect, it, jest } from "@jest/globals";
import {
  applyFolds,
  createListMemory,
  createMemoryFoldStore,
  filterGroups,
  foldStateKey,
  type ConversationRow,
  type DeviceGroup,
  type ListViewState,
} from "./listModel";

/**
 * KIN-MOBILE-001 R3 — the list's search fold.
 *
 * The filter is pure and sits on top of the grouped page the model already
 * produces: it narrows rows by title and agent, keeps the headings that still
 * hold a match, and forces a matching project open for the duration of the
 * query. It never writes the fold store — the reader's folds must be exactly
 * what they were when the query is cleared.
 */

function row(id: string, title: string, agentId = "kin"): ConversationRow {
  return {
    id,
    title,
    agentId,
    at: 1,
    timeLabel: "t1",
    statusKey: "sessions.statusSucceeded",
    pending: 0,
    remote: false,
  };
}

function groups(): DeviceGroup[] {
  return [
    {
      id: "dev-a",
      label: "Laptop",
      isSelf: true,
      online: true,
      count: 3,
      projects: [
        {
          key: "/work/alpha",
          label: "alpha",
          open: true,
          lastActivityAt: 1000,
          rows: [
            row("a1", "Fix the parser", "codex"),
            row("a2", "Write docs", "kin"),
          ],
        },
        {
          key: "/work/beta",
          label: "beta",
          open: false,
          lastActivityAt: 900,
          rows: [row("b1", "Parser follow-up", "kin")],
        },
      ],
    },
    {
      id: "dev-b",
      label: "Studio",
      isSelf: false,
      online: true,
      count: 1,
      projects: [
        {
          key: "/work/gamma",
          label: "gamma",
          open: true,
          lastActivityAt: 800,
          rows: [row("g1", "Ship it", "kin")],
        },
      ],
    },
  ];
}

describe("KIN-MOBILE-001 R3 list search", () => {
  it("KIN-MOBILE-001 R3: search matches title and agent case-insensitively and drops non-matching headings", () => {
    const byTitle = filterGroups(groups(), "PARSER");
    expect(byTitle.map((device) => device.label)).toEqual(["Laptop"]);
    expect(byTitle[0]!.projects.map((project) => project.label)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      byTitle[0]!.projects.flatMap((project) =>
        project.rows.map((item) => item.id),
      ),
    ).toEqual(["a1", "b1"]);
    // The heading's number is the number of matching rows, not the page's.
    expect(byTitle[0]!.count).toBe(2);

    // An agent id is a searchable field too, and the case does not matter.
    const byAgent = filterGroups(groups(), "CODEX");
    expect(byAgent.map((device) => device.label)).toEqual(["Laptop"]);
    expect(
      byAgent[0]!.projects.flatMap((project) =>
        project.rows.map((item) => item.id),
      ),
    ).toEqual(["a1"]);
  });

  it("KIN-MOBILE-001 R3: a match in a folded project is shown, and clearing restores the fold untouched", () => {
    const store = createMemoryFoldStore({
      [foldStateKey("dev-a", "/work/beta")]: false,
    });
    const write = jest.spyOn(store, "write");
    const folded = applyFolds(groups(), store);
    expect(folded[0]!.projects[1]!.open).toBe(false);

    const filtered = filterGroups(folded, "follow-up");
    // The query forces the project open so its matching row can be read...
    expect(filtered[0]!.projects[0]!.open).toBe(true);
    expect(filtered[0]!.projects[0]!.rows.map((item) => item.id)).toEqual([
      "b1",
    ]);
    // ...without writing the fold store: the query is view state, not a fold.
    expect(write).not.toHaveBeenCalled();
    expect(store.read()[foldStateKey("dev-a", "/work/beta")]).toBe(false);

    // Clearing the query hands the reader's folds back exactly as they were.
    expect(filterGroups(folded, "   ")).toBe(folded);
    expect(filtered[0]!.projects[0]!.open).toBe(true);
    expect(folded[0]!.projects[1]!.open).toBe(false);
  });

  it("KIN-MOBILE-001 R3: an empty query returns the same groups object", () => {
    const page = groups();
    expect(filterGroups(page, "")).toBe(page);
    expect(filterGroups(page, " \t\n ")).toBe(page);
  });

  it("KIN-MOBILE-001 R3: a query that matches nothing leaves no group", () => {
    expect(filterGroups(groups(), "zzz")).toEqual([]);
  });
});

describe("KIN-MOBILE-001 R3 list memory", () => {
  it("KIN-MOBILE-001 R3: a claim supersedes the earlier one and only the newest mount is current", () => {
    const memory = createListMemory();
    const first = memory.claim();
    expect(memory.isCurrent(first)).toBe(true);

    // A remount claims the same memory while the old one is still alive.
    const second = memory.claim();
    expect(second).not.toBe(first);
    expect(memory.isCurrent(second)).toBe(true);
    expect(memory.isCurrent(first)).toBe(false);
    // An older generation never becomes current again.
    expect(memory.isCurrent(second - 1)).toBe(false);
    expect(memory.isCurrent(second + 1)).toBe(false);
  });

  it("KIN-MOBILE-001 R3: stored pages are keyed by origin, so another node's rows never restore", () => {
    const memory = createListMemory();
    const pageA: ListViewState = {
      status: "ready",
      groups: groups(),
      error: null,
    };
    const pageB: ListViewState = { status: "empty", groups: [], error: null };

    expect(memory.readSnapshot("https://a.example")).toBeNull();
    memory.writeSnapshot("https://a.example", pageA);
    memory.writeSnapshot("https://b.example", pageB);

    expect(memory.readSnapshot("https://a.example")).toBe(pageA);
    expect(memory.readSnapshot("https://b.example")).toBe(pageB);
    // A re-pairing to a third node restores nothing.
    expect(memory.readSnapshot("https://c.example")).toBeNull();
  });

  it("KIN-MOBILE-001 R3: the query and the offset survive the route and patch independently", () => {
    const memory = createListMemory({ query: "seed" });
    expect(memory.read()).toEqual({ query: "seed", offset: 0 });

    memory.write({ offset: 180 });
    memory.write({ query: "alpha" });
    expect(memory.read()).toEqual({ query: "alpha", offset: 180 });

    // A patch that names one field leaves the other alone.
    memory.write({});
    expect(memory.read()).toEqual({ query: "alpha", offset: 180 });
  });
});
