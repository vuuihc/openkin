/** Session-level permission mode shared by all agents in a task. */
export type PermissionMode = "default" | "accept_edits" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "accept_edits",
  "yolo",
];

const STORAGE_KEY = "kin_permission_mode";

export function normalizePermissionMode(raw?: string | null): PermissionMode {
  switch (raw) {
    case "accept_edits":
    case "acceptEdits":
    case "accept-edits":
      return "accept_edits";
    case "yolo":
    case "bypass":
    case "bypassPermissions":
      return "yolo";
    default:
      return "default";
  }
}

/** Last mode chosen in the composer (new-session default). */
export function getDraftPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "default";
  }
}

export function setDraftPermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}
