/**
 * Optional bridge when the SPA runs inside the Kin Electron shell.
 * In a normal browser these are undefined → fall back to web APIs / manual path.
 */

export type ExternalAppId =
  | "finder"
  | "explorer"
  | "files"
  | "vscode"
  | "cursor"
  | "idea"
  | "webstorm"
  | "pycharm"
  | "goland"
  | "sublime"
  | "zed"
  | "default";

export type ExternalApp = {
  id: ExternalAppId;
  labelKey: string;
  label: string;
  reveal?: boolean;
};

export type KinDesktopAPI = {
  isDesktop: true;
  platform: string;
  selectDirectory: (opts?: {
    defaultPath?: string;
    title?: string;
  }) => Promise<string | null>;
  listExternalApps?: () => Promise<ExternalApp[]>;
  openInApp?: (
    path: string,
    appId: ExternalAppId,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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

/** Detect installed editors / file managers (desktop only). */
export async function listExternalApps(): Promise<ExternalApp[]> {
  if (window.kinDesktop?.listExternalApps) {
    try {
      return await window.kinDesktop.listExternalApps();
    } catch {
      return [];
    }
  }
  return [];
}

/** Open an absolute path in a detected external app (desktop only). */
export async function openInExternalApp(
  absPath: string,
  appId: ExternalAppId,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!window.kinDesktop?.openInApp) {
    return { ok: false, error: "Desktop shell required" };
  }
  try {
    const result = await window.kinDesktop.openInApp(absPath, appId);
    if (result && typeof result === "object" && "ok" in result) {
      if (result.ok) return { ok: true };
      return { ok: false, error: result.error || "Open failed" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
