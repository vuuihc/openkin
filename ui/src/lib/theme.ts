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
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const light =
    mode === "light" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  root.classList.toggle("light", light);
  root.classList.toggle("dark", !light);
  root.setAttribute("data-theme", light ? "light" : "dark");
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
