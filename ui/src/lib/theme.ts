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

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.removeAttribute("data-theme");
  if (mode === "system") {
    root.setAttribute("data-theme", "system");
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    root.classList.add(light ? "light" : "dark");
  } else if (mode === "light") {
    root.setAttribute("data-theme", "light");
    root.classList.add("light");
  } else {
    root.setAttribute("data-theme", "dark");
    root.classList.add("dark");
  }
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
