/**
 * KIN-CONTRACT-001 — the console's route manifest, asserted against `App.tsx`.
 *
 * The contract's acceptance row 1: a new `<Route path="/x">` that is not in the
 * contract (or in the retirement table, with an owner) fails the gate, and the
 * failure names `KIN-CONTRACT-001` and `/x`. This suite is that gate. It reads
 * `App.tsx` as text, so it needs no DOM, no router render and no network.
 *
 * The sibling `surfacesContract.KIN-CONTRACT-001.test.ts` keeps the story and
 * the two data tables in step; this file holds the tree to them:
 *
 * - every literal route is a contract page, the draft route, or a route-shaped
 *   retirement row;
 * - every contract page (and `/new`) is still registered — deleting one reds;
 * - every retired path still reaches its landing page — deleting the old path
 *   instead of leaving a `<Navigate>` reds;
 * - the design-system route exists only in a dev build, proven by calling
 *   `designSystemRoute` with both flag values rather than by matching a string.
 *
 * The two prose rows in `EXIT_ROWS` (`/routines 里的运行列表`,
 * `Settings 的 agents 安装检测…`) describe a piece of a page, not a path, so
 * only route-shaped cells are compared with the route set. A `from` cell may
 * hold two paths (`/inbox、/approvals`), split on the enumeration comma.
 *
 * DOM-free on purpose: `node:fs` + `import.meta.url` resolves `App.tsx` from
 * this file's own location, not from the process's cwd.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { designSystemRoute } from "../pages/DesignSystemPage";
import {
  CONTRACT_DRAFT_ROUTE,
  CONTRACT_PAGES,
  EXIT_ROWS,
  type ExitRow,
} from "./surfacesContract";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

/** A literal path, or `*`. The two prose rows contain spaces and cannot match. */
const ROUTE_SHAPED = /^\*$|^\/[A-Za-z0-9_:.*/-]*$/;

/** Remove JSX `{/* … *\/}` blocks and `//` line comments before parsing. */
export function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Every literal `<Route path="…">` in a source, comments excluded.
 *
 * Fails closed: an empty result throws instead of returning `[]`, because a
 * manifest suite that silently passes on zero routes is the hole it exists to
 * close (STATUS Watch 76).
 */
export function routePathsFrom(source: string): string[] {
  const paths: string[] = [];
  for (const match of stripComments(source).matchAll(/<Route\s+path="([^"]+)"/g)) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  if (paths.length === 0) {
    throw new Error(
      "KIN-CONTRACT-001: no <Route path> found — the route manifest cannot pass on a file it cannot read",
    );
  }
  return paths;
}

/** The paths in one retirement cell; `/inbox、/approvals` is two routes. */
function routeParts(row: ExitRow): string[] {
  return row.from.split("、").map((part) => part.trim());
}

function isRouteShaped(row: ExitRow): boolean {
  return routeParts(row).every((part) => ROUTE_SHAPED.test(part));
}

function unregisteredRouteMessage(path: string): string {
  return (
    `KIN-CONTRACT-001: "${path}" is not a registered surface — ` +
    "add it to CONTRACT_PAGES (with its story) or to EXIT_ROWS (with its owner)"
  );
}

/** Everything `App.tsx` is allowed to register, from the contract's data. */
function registeredPaths(): Set<string> {
  const registered = new Set<string>(CONTRACT_PAGES.map((page) => page.path));
  registered.add(CONTRACT_DRAFT_ROUTE);
  for (const row of EXIT_ROWS) {
    if (!isRouteShaped(row)) continue;
    for (const part of routeParts(row)) registered.add(part);
  }
  return registered;
}

describe("KIN-CONTRACT-001 route manifest", () => {
  const routes = routePathsFrom(appSource);
  const present = new Set(routes);
  const registered = registeredPaths();

  it("every route in App.tsx is registered", () => {
    for (const path of routes) {
      expect(registered.has(path), unregisteredRouteMessage(path)).toBe(true);
    }
  });

  it("every contract page and the draft route is still registered", () => {
    for (const path of [...CONTRACT_PAGES.map((page) => page.path), CONTRACT_DRAFT_ROUTE]) {
      expect(
        present.has(path),
        `KIN-CONTRACT-001: "${path}" is in the contract but App.tsx no longer registers it`,
      ).toBe(true);
    }
  });

  it("every retired route still lands", () => {
    for (const row of EXIT_ROWS) {
      // Prose rows name a piece of a page; "不在生产路由" is the one deliberate exit.
      if (!isRouteShaped(row)) continue;
      if (!row.to.startsWith("/")) continue;
      for (const part of routeParts(row)) {
        expect(
          present.has(part),
          `KIN-CONTRACT-001: the retired path "${part}" no longer reaches ${row.to} — leave its <Navigate> in App.tsx`,
        ).toBe(true);
      }
    }
  });

  it("the dev-only design-system route is registered only in dev", () => {
    expect(designSystemRoute(false)).toBeNull();
    const devRoute = designSystemRoute(true);
    if (devRoute === null) {
      throw new Error("KIN-CONTRACT-001: the design-system route is absent in a dev build");
    }
    expect(devRoute.props.path).toBe("/dev/components");
    // App.tsx calls `designSystemRoute()` with no argument, so the default is
    // the rule that ships. A stubbed production env proves the default reads
    // Vite's flag rather than registering the page unconditionally.
    vi.stubEnv("DEV", false);
    try {
      expect(designSystemRoute()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    const registeredSource = stripComments(appSource);
    expect(registeredSource).toContain("{designSystemRoute()}");
    expect(registeredSource).not.toMatch(/<Route\s+path="\/dev\/components"/);
  });

  it("the unregistered-route failure names the contract and the fix", () => {
    const message = unregisteredRouteMessage("/rogue");
    expect(message).toContain("KIN-CONTRACT-001");
    expect(message).toContain("/rogue");
    expect(message).toContain(
      "add it to CONTRACT_PAGES (with its story) or to EXIT_ROWS (with its owner)",
    );
  });

  it("the reader fails closed", () => {
    expect(() => routePathsFrom("<Routes></Routes>")).toThrow(/KIN-CONTRACT-001/);
    const source = [
      '<Route path="/real" />',
      '{/* <Route path="/commented" /> */}',
      '// <Route path="/line-commented" />',
    ].join("\n");
    expect(routePathsFrom(source)).toEqual(["/real"]);
  });
});
