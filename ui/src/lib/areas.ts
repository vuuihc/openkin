/**
 * The four areas of the console, as one table.
 *
 * The signed direction (KIN-CONTINUE-003, `docs/product/IA.md`) is that the
 * console has four areas — Conversations, Projects, Routines, Settings — and
 * that every navigation surface is a view of the same definitions. Before this
 * table each surface could spell "where can I go" for itself; the failure mode
 * is a place that exists in the router and in no list, or two names for one
 * destination.
 *
 * The table holds data, not presentation, for the same reason `places.ts` and
 * `panels.ts` do: the tests that read it run without a DOM. The icon is an id,
 * not a component; the label is a locale key, not a translated string.
 *
 * This module deliberately does not touch the catalogs. `nav.projects` is
 * reserved here and N2 adds the locale entries when the shell renders the
 * table; N1 is the contract only.
 */

/**
 * The shape of one row.
 *
 * `id` is deliberately `string` here: the narrower union is derived from the
 * table below, so there is no second list of ids to keep in step.
 */
type AreaRow = {
  readonly id: string;
  /** Locale key for the area's name, shared by every surface that lists it. */
  readonly labelKey: string;
  /** DOM-free icon id; the shell maps it to its own component. */
  readonly icon: string;
  /** The URL a cold start in this area lands on. */
  readonly root: string;
  /**
   * The phone stack's parent for the root itself. An area root is the bottom
   * of its own stack (the story map's stack rule 4: underneath it is leaving
   * Kin, not a synthesized page), so every row is null; detail parents live in
   * `areaNavigation.ts`.
   */
  readonly phoneParent: string | null;
  /** Whether the Mac's persistent area navigation lists this area. */
  readonly macNav: boolean;
};

/**
 * The table, in the order the chrome shows the areas.
 *
 * `root` is where a cold start in the area lands, not every URL it owns:
 * `/` is the start route and resolves at runtime, while `/sessions` is the
 * conversation collection the phone opens on.
 */
export const AREAS = [
  {
    id: "conversations",
    labelKey: "nav.sessions",
    icon: "sessions",
    root: "/sessions",
    phoneParent: null,
    macNav: true,
  },
  {
    id: "projects",
    labelKey: "nav.projects",
    icon: "projects",
    root: "/projects",
    phoneParent: null,
    macNav: true,
  },
  {
    id: "routines",
    labelKey: "nav.routines",
    icon: "routines",
    root: "/routines",
    phoneParent: null,
    macNav: true,
  },
  {
    id: "settings",
    labelKey: "nav.settings",
    icon: "settings",
    root: "/settings",
    phoneParent: null,
    macNav: true,
  },
] as const satisfies readonly AreaRow[];

/**
 * The ids and the row type, both derived from the table so an id can only be
 * added in one place. A hand-written union beside a table is exactly the
 * drift this module exists to remove.
 */
export type AreaId = (typeof AREAS)[number]["id"];
export type Area = (typeof AREAS)[number];

/** The ids, in display order, for code that needs to walk the four areas. */
export const AREA_IDS: readonly AreaId[] = AREAS.map((area) => area.id);

/**
 * Mac navigation membership, encoded separately from the table's order and
 * from the phone roots. All four areas belong to Mac navigation today, but a
 * future area can join the phone model without silently entering the sidebar.
 */
export const MAC_NAV_AREA_IDS: readonly AreaId[] = AREAS.filter((area) => area.macNav).map(
  (area) => area.id,
);

/** The row for an id. Returns the table's object, never a copy. */
export function areaById(id: AreaId): Area {
  const found = AREAS.find((area) => area.id === id);
  if (!found) {
    // Unreachable while the table is the union's source — the type says so;
    // this is the backstop that turns an unknown id at a boundary (a saved
    // setting, a URL) into a sentence rather than `undefined`.
    throw new Error(`unknown area: ${id}`);
  }
  return found;
}
