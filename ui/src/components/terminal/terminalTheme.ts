import { type ITheme } from "@xterm/xterm";

/**
 * Get xterm theme colors based on light/dark mode.
 * Detects theme from root element's data-theme or class.
 */
export function getTerminalTheme(): ITheme {
  // Detect if dark mode is active
  const isDark =
    document.documentElement.classList.contains("dark") ||
    document.documentElement.getAttribute("data-theme") === "dark";

  if (isDark) {
    return {
      background: "#1e1e1e",
      foreground: "#e0e0e0",
      cursor: "#00ff00",
      cursorAccent: "#1e1e1e",
      black: "#000000",
      red: "#ff5555",
      green: "#55ff55",
      yellow: "#ffff55",
      blue: "#5555ff",
      magenta: "#ff55ff",
      cyan: "#55ffff",
      white: "#ffffff",
      brightBlack: "#555555",
      brightRed: "#ff8888",
      brightGreen: "#88ff88",
      brightYellow: "#ffff88",
      brightBlue: "#8888ff",
      brightMagenta: "#ff88ff",
      brightCyan: "#88ffff",
      brightWhite: "#ffffff",
    };
  }

  return {
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2b91f0",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#ffffff",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  };
}

/**
 * Watch for theme changes and update terminal theme reactively.
 * Returns a cleanup function.
 */
export function observeThemeChanges(
  onThemeChange: (theme: ITheme) => void,
): () => void {
  const observer = new MutationObserver(() => {
    onThemeChange(getTerminalTheme());
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  return () => observer.disconnect();
}
