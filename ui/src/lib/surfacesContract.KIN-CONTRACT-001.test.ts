/**
 * KIN-CONTRACT-001 — the four-page contract's table, asserted against the story.
 *
 * Why this exists before the pages are deleted: the machine rule is that a
 * story may be `approved` only when at least one test names it, and the routing
 * test that refuses an unlisted route can only be honest once the deletions
 * exist. So the first delivery pins the half that is already true — the
 * retirement table itself:
 *
 * - the story's §设计 table and `EXIT_ROWS` are the same rows, in order, cell
 *   for cell (the story is the source, the code is the copy);
 * - every row names an owner, so "someone will get to it" cannot be a row;
 * - a route-shaped `from` never names a page the contract keeps, and every
 *   `to` lands on a page the contract keeps (or explicitly outside production);
 * - the story names all four pages and `/new` as the draft route.
 *
 * The routing assertion (`App.tsx` ⊆ contract) lands with `R-delete-pages`,
 * the delivery that actually removes `/projects`, `/agent-sessions/:id` and
 * `/machines/:device/tasks/:id`. Asserting it earlier would only describe
 * today's tree and would have to be written to pass on fifteen routes.
 *
 * DOM-free: the tables import without React, and a docs check has no reason to
 * pay for a document. `node:fs` + `import.meta.url` resolves the story from
 * this file's own location, not from the process's cwd.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_DRAFT_ROUTE, CONTRACT_PAGES, EXIT_ROWS } from "./surfacesContract";

const story = readFileSync(
  new URL("../../../docs/product/stories/KIN-CONTRACT-001.md", import.meta.url),
  "utf8",
);

/** Backticks and bold are the story's formatting, not part of a cell's value. */
function normalise(cell: string): string {
  return cell.replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** The 退场表 under §设计, as rows of normalised cells (header and rule dropped). */
function exitTable(text: string): string[][] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes("**退场表**"));
  expect(start, "KIN-CONTRACT-001 must keep its 退场表 under 设计").toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  let header = false;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      if (rows.length > 0) break;
      continue;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(normalise);
    // The |---|---| rule is not a row.
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (!header) {
      header = true;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** A `to` cell reduced to the route it lands on; null when it lands nowhere. */
function landingRoute(to: string): string | null {
  if (!to.startsWith("/")) return null;
  return to.split("?")[0] ?? to;
}

describe("KIN-CONTRACT-001 surface contract", () => {
  it("the story's exit table and EXIT_ROWS are the same rows, in order", () => {
    const fromStory = exitTable(story);
    expect(fromStory.length).toBe(EXIT_ROWS.length);
    expect(EXIT_ROWS.map((row) => [row.from, row.to, row.ability, row.owner])).toEqual(fromStory);
  });

  it("every exit row names an owner", () => {
    for (const row of EXIT_ROWS) {
      expect(normalise(row.owner), `${row.from} has no owner`).not.toBe("");
    }
  });

  it("the contract is four pages plus /new, and /new is not a page", () => {
    expect(CONTRACT_PAGES.map((page) => page.path)).toEqual([
      "/sessions",
      "/tasks/:id",
      "/routines",
      "/settings",
    ]);
    for (const page of CONTRACT_PAGES) expect(page.title.trim()).not.toBe("");
    expect(CONTRACT_PAGES.map((page) => page.path)).not.toContain(CONTRACT_DRAFT_ROUTE);
  });

  it("no exit row keeps a retired route alive as one of the four pages", () => {
    const kept = new Set(CONTRACT_PAGES.map((page) => page.path));
    for (const row of EXIT_ROWS) {
      // `/inbox、/approvals` is two routes in one cell; `/routines 里的运行列表` is
      // a piece of a page, so it is not an exact path match and cannot collide.
      for (const retired of row.from.split("、").map(normalise)) {
        expect(kept.has(retired), `${retired} is still a contract page`).toBe(false);
      }
    }
  });

  it("every exit row lands on a page the contract keeps", () => {
    const kept = new Set(CONTRACT_PAGES.map((page) => page.path));
    for (const row of EXIT_ROWS) {
      const route = landingRoute(row.to);
      if (route === null) {
        // The only non-route destinations are the ones that leave production.
        expect(row.to, `${row.from} lands nowhere`).toBe("不在生产路由");
        continue;
      }
      expect(kept.has(route), `${row.from} lands on ${route}, which is not in the contract`).toBe(
        true,
      );
    }
  });

  it("the story names every contract page and the draft route", () => {
    for (const page of CONTRACT_PAGES) expect(story).toContain("`" + page.path + "`");
    expect(story).toContain(CONTRACT_DRAFT_ROUTE);
  });
});
