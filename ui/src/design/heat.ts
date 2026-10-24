/**
 * The activity heatmap's five levels, and the ring that separates a lit cell
 * from an unlit one.
 *
 * Not tokens, and the reason is arithmetic: a token names a *role* (this is a
 * surface, this is a status), while these five encode a *quantity* — no
 * activity, then more. Painting them from `--kin-green` would say the busy days
 * are "the success colour", which is a different claim from "this day had more
 * commits than that one", and it would have to be re-derived for every scheme.
 *
 * Two things about the ramp are worth stating rather than leaving to be
 * rediscovered. It is GitHub's scale, which is where a reader has already
 * learned to read this chart, and one ramp serves both schemes: the greens are
 * dark-scheme values drawn on panels, so in the light scheme the empty step
 * (`#2a2b30`) is darker than the panel behind it. That is visible on
 * `/projects/<id>` and it is a design decision this file records rather than
 * fixes — the light ramp is not written yet.
 *
 * It lives under `design/` because that is the one directory allowed to spell a
 * colour; see `theme.css`'s header for the three boundaries.
 */
export const HEAT_RAMP = [
  "#2a2b30", // empty
  "#0e4429",
  "#006d32",
  "#26a641",
  "#39d353",
] as const;

/** The inner hairline on a lit cell, so the ramp's steps stay apart on a panel. */
export const HEAT_CELL_RING = "inset 0 0 0 1px rgba(255,255,255,0.06)";
