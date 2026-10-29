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
};

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
  const width = Math.max(MIN_WIDTH, Math.round(saved.width) || 0);
  const height = Math.max(MIN_HEIGHT, Math.round(saved.height) || 0);

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

function overlap(start: number, areaStart: number, length: number, areaLength: number): number {
  return Math.max(0, Math.min(start + length, areaStart + areaLength) - Math.max(start, areaStart));
}
