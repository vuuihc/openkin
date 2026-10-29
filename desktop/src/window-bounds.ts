/**
 * Where to put the main window when it is created.
 *
 * A saved position is a fact about the screens that existed when the window was
 * last moved. Unplug the display it lived on and the same numbers name a point
 * that is on no screen at all: macOS happily creates the window there, and the
 * launch looks like a no-op — the app is running, the tray is there, and no
 * window ever appears. So a saved rect is honoured only while a title-bar-sized
 * part of it still lands on some display; otherwise the window comes back
 * centred on the primary one, at a size that display can hold.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type SavedBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /**
   * How the window was being shown when it was saved. The rect beside these is
   * always the *normal* one: while maximized or full screen the window's own
   * bounds are the screen's, and remembering those would lose the size it
   * returns to when the person un-maximizes it.
   */
  maximized?: boolean;
  fullScreen?: boolean;
};

/** How a window should be shown after it is created. */
export type WindowState = "normal" | "maximized" | "fullscreen";

/**
 * Which of the three states a saved file asks for.
 *
 * Full screen wins over maximized: a full-screen window reports maximized on
 * some platforms, and restoring it merely maximized would drop it out of its
 * own Space. A file from before the flags existed has neither, and `false` is
 * what that file meant — the window comes back normal.
 */
export function restoreWindowState(saved: SavedBounds): WindowState {
  if (saved.fullScreen === true) return "fullscreen";
  if (saved.maximized === true) return "maximized";
  return "normal";
}

/** What a saved file asks for: where to open, and how to show the window. */
export type RestoredWindow = { rect: Rect; state: WindowState };

/**
 * Both answers at once, from the same file.
 *
 * They have to come from one place. `restoreWindowBounds` returns a plain rect
 * and the flags are optional fields, so a caller that reads the state back off
 * that rect type-checks and silently restores `normal` forever. Any path that
 * keeps only the rect loses the state; this is the one that keeps both.
 */
export function restoreWindow(
  saved: SavedBounds,
  workAreas: Rect[],
  primary: Rect,
): RestoredWindow {
  return {
    rect: restoreWindowBounds(saved, workAreas, primary),
    state: restoreWindowState(saved),
  };
}

/** Below this the console has no room for its two panes. */
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;

/**
 * What has to be on screen to keep a saved position: a strip of title bar wide
 * enough to grab, and enough of it clear of the menu bar to click. A window
 * whose title bar is gone cannot be dragged back, however much of its body
 * shows.
 */
const VISIBLE_TITLE_WIDTH = 120;
const TITLE_BAR_HEIGHT = 40;
const VISIBLE_TITLE_HEIGHT = 20;

export function restoreWindowBounds(
  saved: SavedBounds,
  workAreas: Rect[],
  primary: Rect,
): Rect {
  const width = Math.max(MIN_WIDTH, rounded(saved.width) ?? 0);
  const height = Math.max(MIN_HEIGHT, rounded(saved.height) ?? 0);

  const x =
    typeof saved.x === "number" && Number.isFinite(saved.x) ? saved.x : null;
  const y =
    typeof saved.y === "number" && Number.isFinite(saved.y) ? saved.y : null;
  if (
    x !== null &&
    y !== null &&
    workAreas.some(
      (area) =>
        overlap(x, area.x, width, area.width) >= VISIBLE_TITLE_WIDTH &&
        overlap(y, area.y, TITLE_BAR_HEIGHT, area.height) >= VISIBLE_TITLE_HEIGHT,
    )
  ) {
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  const fitWidth = Math.min(width, primary.width);
  const fitHeight = Math.min(height, primary.height);
  return {
    x: Math.round(primary.x + (primary.width - fitWidth) / 2),
    y: Math.round(primary.y + (primary.height - fitHeight) / 2),
    width: fitWidth,
    height: fitHeight,
  };
}

/**
 * A bounds file's contents, as far as they can be trusted.
 *
 * The file is written by this shell and edited by nobody, which is exactly why
 * a corrupt one is possible: a crash mid-write, a hand edit, a field that was
 * once a string. A size is the one part a window cannot do without, so a
 * document without two usable numbers is no saved bounds at all — the caller
 * falls back to its defaults rather than to a 720×480 window.
 *
 * `1e999` parses to Infinity, which `Math.round` keeps; finite is the test, not
 * "is a number".
 */
export function savedBoundsFrom(value: unknown): SavedBounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width,
    height,
    x: finite(raw.x) ?? undefined,
    y: finite(raw.y) ?? undefined,
    // Only a literal `true` is a state. A hand-edited `"true"` or `1` is not
    // something the shell can restore, and guessing would move the window.
    maximized: raw.maximized === true,
    fullScreen: raw.fullScreen === true,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rounded(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function overlap(start: number, areaStart: number, length: number, areaLength: number): number {
  return Math.max(0, Math.min(start + length, areaStart + areaLength) - Math.max(start, areaStart));
}
