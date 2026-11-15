/**
 * What the command palette offers, derived from the tables that already decide it.
 *
 * The palette used to hold its own answers: six hand-written navigation actions,
 * each one a `navigate("/…")` literal beside a locale key, plus a terminal row
 * gated by a `terminalAvailable` prop the shell computed from the panel registry.
 * So the same three facts — which places exist, which panels exist, and whether a
 * panel applies here — had two sources, and the palette's copy was the one nobody
 * remembered to update. This module is the palette asking the tables instead:
 * `PLACES` for where it can go, `availablePanels` for what it can open.
 *
 * It stays data-only, like both of those modules, so the guard that walks it runs
 * without a DOM.
 *
 * Two things here are deliberately *not* derived, because they are not lists of
 * places: the recipe rows (they depend on the most recently active project, which
 * is live data) and the chat rows (the task list from the API).
 */

import { availablePanels, type PanelContext, type PanelId } from "./panels";
import { PLACES, type PlaceId } from "./places";

/**
 * One row's worth of what to draw and what it does.
 *
 * `kind` is the whole difference between the two families, and it is in the type
 * rather than inferred from the id: a place navigates, a panel opens or closes,
 * and the two ids come from different spaces that happen to share a name for
 * nothing.
 */
export type PaletteEntry =
  | {
      kind: "place";
      id: PlaceId;
      path: string;
      labelKey: string;
      hint?: string;
    }
  | {
      kind: "panel";
      id: PanelId;
      labelKey: string;
      hint?: string;
    };

/**
 * The palette's rows for this context: every place, then every panel that applies
 * here.
 *
 * Order is the tables' order, so the palette reads the way the sidebar does and a
 * new row lands where its table says rather than at the end of a hand-written
 * list. Availability is asked, not assumed: `availablePanels` is the same call
 * that decides whether the panel's own toggle is drawn, so the palette cannot
 * offer something the header refuses to.
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
  const places: PaletteEntry[] = PLACES.map((p) => ({
    kind: "place",
    id: p.id,
    path: p.path,
    labelKey: p.labelKey,
    hint: p.hint,
  }));
  const panels: PaletteEntry[] = availablePanels(ctx).map((p) => ({
    kind: "panel",
    id: p.id,
    labelKey: p.titleKey,
    hint: p.hint,
  }));
  return [...places, ...panels];
}
