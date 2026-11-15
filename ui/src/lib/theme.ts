/** Theme preference: dark | light | system. Stored in localStorage. */

export type ThemeMode = "dark" | "light" | "system";

const KEY = "kin_theme";

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return "dark";
}

/**
 * Applies the preference to `<html>` as a *resolved* scheme.
 *
 * The attribute carries the scheme that is actually in force (`dark` or
 * `light`), not the preference — so the stylesheet needs one block per scheme
 * instead of one per preference plus two `prefers-color-scheme` blocks that
 * restate the same values. The class stays because Tailwind's `dark:` variant
 * keys off it; both are written from the same resolution, so they cannot
 * disagree.
 *
 * The `theme-color` meta is written here for the same reason. It is the colour
 * the browser paints its own chrome with — the address bar on a phone — and
 * `content` accepts no `var()`, so a hand-written hex in `index.html` is the one
 * place a colour could escape the token layer. Reading `--kin-page` back out of
 * the computed style keeps that from happening; it is read after the scheme is
 * applied, so it is always the value in force.
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const light =
    mode === "light" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  root.classList.toggle("light", light);
  root.classList.toggle("dark", !light);
  root.setAttribute("data-theme", light ? "light" : "dark");
  applyThemeColor();
}

/** `--kin-page` -> the `theme-color` meta. No-ops outside a browser document. */
function applyThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const page = getComputedStyle(document.documentElement).getPropertyValue("--kin-page").trim();
  if (page) meta.setAttribute("content", page);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore
  }
  applyTheme(mode);
}

/** Call once at boot. */
export function initTheme(): void {
  applyTheme(getThemeMode());
  // Keep system theme in sync without full remount flicker.
  try {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (getThemeMode() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
  } catch {
    // ignore
  }
}
