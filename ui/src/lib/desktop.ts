/**
 * Optional bridge when the SPA runs inside the Kin Electron shell.
 * In a normal browser these are undefined → fall back to web APIs / manual path.
 */

export type KinDesktopAPI = {
  isDesktop: true;
  platform: string;
  selectDirectory: (opts?: {
    defaultPath?: string;
    title?: string;
  }) => Promise<string | null>;
};

declare global {
  interface Window {
    kinDesktop?: KinDesktopAPI;
  }
}

export function isKinDesktop(): boolean {
  return typeof window !== "undefined" && !!window.kinDesktop?.isDesktop;
}

/** Native folder picker when available; null if cancelled or unsupported. */
export async function pickDirectory(opts?: {
  defaultPath?: string;
  title?: string;
}): Promise<string | null> {
  if (window.kinDesktop?.selectDirectory) {
    return window.kinDesktop.selectDirectory(opts);
  }
  // Chromium File System Access API — does NOT return a real absolute path
  // (privacy). Only useful as a last resort label; we skip using it for cwd.
  return null;
}
