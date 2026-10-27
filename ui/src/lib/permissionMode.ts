/** Session-level permission mode shared by all agents in a task. */
export type PermissionMode = "default" | "accept_edits" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = ["default", "accept_edits", "yolo"];

/** i18n key for each mode's short label. Shared so the picker and any summary
 *  that names the current mode can never disagree about what it is called. */
export const PERMISSION_MODE_LABEL_KEY: Record<PermissionMode, string> = {
  default: "permission.default",
  accept_edits: "permission.acceptEdits",
  yolo: "permission.yolo",
};

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

/**
 * The modes a chosen run can actually use.
 *
 * Only a remote machine can refuse one: its node runs dispatched turns, and it
 * refuses a mode whose adapter bypasses approvals unless it was started with
 * `--allow-yolo`. The node now says which modes those are. A node too old to
 * say — or an agent the console cannot identify on it — is offered the graded
 * modes and not yolo: the same conservative answer the executor would give,
 * moved to where the choice is made instead of surfacing as a failed session.
 */
export function permissionModesForAgent(
  agent: { permission_modes?: string[]; permissionModes?: string[] } | undefined,
  isSelf: boolean,
): PermissionMode[] {
  if (isSelf) return PERMISSION_MODES;
  const advertised = agent?.permission_modes ?? agent?.permissionModes;
  if (!advertised) return PERMISSION_MODES.filter((mode) => mode !== "yolo");
  return PERMISSION_MODES.filter((mode) => advertised.includes(mode));
}
