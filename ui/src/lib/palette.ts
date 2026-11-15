/**
 * What the command palette offers, derived from the tables that already decide it.
 *
 * The palette used to hold its own answers: six hand-written navigation actions,
 * each one a `navigate("/…")` literal beside a locale key, plus a terminal row
 * gated by a `terminalAvailable` prop the shell computed from the panel registry.
 * Then N1 made the four areas the console's destinations, and the palette became
 * the third surface — after the router and a notification tap — that must read
 * that one table. So a destination is `AREAS`' row or it is not offered: the
 * palette cannot list a place the area navigation does not, which is the drift
 * this module exists to stop.
 *
 * It stays data-only, like `areas.ts` and `panels.ts`, so the guard that walks
 * it runs without a DOM. The icon is the area table's DOM-free icon id; the
 * surface maps it to a component.
 *
 * Two things here are deliberately *not* derived, because they are not lists of
 * places: the recipe rows (they depend on the most recently active project, which
 * is live data) and the chat rows (the task list from the API).
 */

import { areaById, MAC_NAV_AREA_IDS, type Area, type AreaId } from "./areas";
import { availablePanels, type PanelContext, type PanelId } from "./panels";

/**
 * One row's worth of what to draw and what it does.
 *
 * `kind` is the whole difference between the two families, and it is in the type
 * rather than inferred from the id: an area navigates, a panel opens or closes,
 * and the two ids come from different spaces that happen to share a name for
 * nothing.
 */
export type PaletteEntry =
  | {
      kind: "area";
      id: AreaId;
      /** The area root, from the table. */
      path: string;
      labelKey: string;
      /** DOM-free icon id; the surface maps it to its own component. */
      icon: Area["icon"];
    }
  | {
      kind: "panel";
      id: PanelId;
      labelKey: string;
      hint?: string;
    };

/**
 * The palette's rows for this context: every area the area navigation lists,
 * then every panel that applies here.
 *
 * Order is the tables' order, so the palette reads the way the area chrome does
 * and a new area lands where its table row says rather than at the end of a
 * hand-written list. Membership is asked of the same `macNav` flag the Mac
 * navigation uses — an area that joins the phone model without entering the
 * sidebar cannot silently appear here.
 *
 * Availability is asked, not assumed: `availablePanels` is the same call that
 * decides whether the panel's own toggle is drawn, so the palette cannot offer
 * something the header refuses to.
 *
 * What the *shell* asks with is the shell's own context — no session in front —
 * so in the running app the panel half of the list is the terminal and nothing
 * else: `files` and `pr` need a session, `publish` needs one running elsewhere.
 * Session panels are opened from the session's own header, which is where the
 * view key that owns them is known; a palette row carries a `PanelId`, not the
 * view to open it in, so offering one from here would open it in the shell's view
 * where no session page is listening.
 */
export function paletteEntries(ctx: PanelContext): PaletteEntry[] {
  const areas: PaletteEntry[] = MAC_NAV_AREA_IDS.map((id) => {
    const area = areaById(id);
    return {
      kind: "area",
      id,
      path: area.root,
      labelKey: area.labelKey,
      icon: area.icon,
    };
  });
  const panels: PaletteEntry[] = availablePanels(ctx).map((p) => ({
    kind: "panel",
    id: p.id,
    labelKey: p.titleKey,
    hint: p.hint,
  }));
  return [...areas, ...panels];
}
