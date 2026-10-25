/**
 * Everywhere the shell can take you, as one table.
 *
 * There were three lists before this one. The sidebar had a table of four
 * (`lib/sidebarNavigation.ts`), the mobile tab bar had three paths inline, and
 * the command palette had six, hand-written beside a `navigate` call each. The
 * same place therefore had up to three names, three orders and three ideas of
 * whether it existed — and adding a page meant remembering all of them, which is
 * the failure mode the P3 plan calls out: a place that exists in the router and
 * in no list is a place nobody can reach.
 *
 * So this table is the answer to "where can I go", and each surface is a view of
 * it: the sidebar renders its two groups, the mobile bar renders the three it has
 * room for, and the command palette renders all of them (see `lib/palette.ts`).
 * Each surface keeps its own chrome — icons, order within a group, whether it
 * exists at all on a 390px screen — because that is presentation, and the row a
 * place occupies here is not.
 *
 * The table holds data, not presentation, for the same reason `panels.ts` does:
 * the tests that read it run without a DOM.
 */

/**
 * The ids, as a value the union is derived from.
 *
 * Same reasoning as `PANEL_IDS`: a union is erased at runtime, so a place added
 * to a hand-written union and forgotten in the table would compile and then be
 * unreachable. Here the only way to add an id is to add it to the list, and the
 * list is what the palette test walks.
 */
export const PLACE_IDS = [
  "new",
  "sessions",
  "tasks",
  "inbox",
  "artifacts",
  "routines",
  "projects",
  "agents",
  "settings",
] as const;

export type PlaceId = (typeof PLACE_IDS)[number];

/**
 * Where a place belongs when the chrome has room for groups.
 *
 * `work` is the set the shell treats as the primary loop — the three the mobile
 * bar keeps plus the draft — and it has no sidebar group, which is why it is a
 * section id with no entry in `SIDEBAR_SECTIONS` rather than a fourth group.
 */
export type PlaceSectionId = "work" | "library" | "operations";

export type Place = {
  id: PlaceId;
  path: string;
  /** Locale key for its name, shared by every surface that lists it. */
  labelKey: string;
  section: PlaceSectionId;
  /** The keyboard shortcut, where one exists, for a palette row's hint column. */
  hint?: string;
};

export const PLACES: Place[] = [
  { id: "new", path: "/new", labelKey: "nav.newChat", section: "work", hint: "⌘N" },
  { id: "sessions", path: "/sessions", labelKey: "nav.sessions", section: "work" },
  { id: "tasks", path: "/tasks", labelKey: "nav.tasks", section: "work" },
  { id: "inbox", path: "/inbox", labelKey: "nav.inbox", section: "work" },
  { id: "artifacts", path: "/artifacts", labelKey: "nav.artifacts", section: "library" },
  { id: "routines", path: "/routines", labelKey: "nav.routines", section: "library" },
  // `/projects` is where the sidebar's project rows lead when a project is
  // archived away under them (`ProjectDetailPage` navigates there), so the page
  // was reachable and unnamed: a route in the router and in no list. The guard
  // in `places.test.ts` is what found it.
  { id: "projects", path: "/projects", labelKey: "nav.projects", section: "library" },
  { id: "agents", path: "/agents", labelKey: "nav.agentOperations", section: "operations" },
  { id: "settings", path: "/settings", labelKey: "nav.settings", section: "operations" },
];

export function placeById(id: PlaceId): Place {
  const found = PLACES.find((p) => p.id === id);
  if (!found) {
    // Unreachable while `PLACES` covers `PLACE_IDS` — the test keeps it that way;
    // this is the backstop that turns a gap into a sentence.
    throw new Error(`unknown place: ${id}`);
  }
  return found;
}

/** Where a place goes. The one way to ask, so a path literal lives in the table only. */
export function placePath(id: PlaceId): string {
  return placeById(id).path;
}

/** The sidebar's groups, in the order it renders them. */
export const SIDEBAR_SECTIONS: { id: Exclude<PlaceSectionId, "work">; labelKey: string }[] = [
  { id: "library", labelKey: "nav.sectionLibrary" },
  { id: "operations", labelKey: "nav.sectionOperations" },
];

export type SidebarNavSection = {
  id: (typeof SIDEBAR_SECTIONS)[number]["id"];
  labelKey: string;
  items: Place[];
};

/**
 * The sidebar's groups with their places, from the one table.
 *
 * The sidebar shows the library and operations places only: the work set is the
 * mobile bar's and the draft's, and the sidebar reaches the same destinations
 * through the project list it is mostly made of.
 */
export function sidebarNavSections(): SidebarNavSection[] {
  return SIDEBAR_SECTIONS.map((section) => ({
    ...section,
    items: PLACES.filter((p) => p.section === section.id),
  }));
}
