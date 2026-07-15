import { Notification, type NotificationAction } from "electron";
import type { Approval, Task } from "./daemon-api";
import { parseToolSummary, decideApproval } from "./daemon-api";

/**
 * Native notification policy (macOS):
 *
 * Electron's Notification API supports `actions` on macOS, but action buttons
 * are unreliable: they require alert-style banners, may not appear when the
 * app is focused, and behavior varies by macOS version / focus state.
 *
 * We still attach Approve / Deny actions when the platform reports support.
 * The reliable path is always: click the notification → open the approval
 * in the main window. Actions, when they fire, call the daemon decision API
 * from the main process (Bearer token) so the user can act without focusing.
 */
export type NotificationCallbacks = {
  openApproval: (approvalId: string) => void;
  openTask: (taskId: string) => void;
  getToken: () => string | null;
  onDecided?: (id: string, decision: "approved" | "denied") => void;
};

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export class Notifier {
  private cb: NotificationCallbacks;
  /** Dedupe approval notifications per id (WS can rebroadcast). */
  private seenApprovals = new Set<string>();
  private seenTerminal = new Set<string>();

  constructor(cb: NotificationCallbacks) {
    this.cb = cb;
  }

  onApproval(a: Approval): void {
    if (a.decision !== "pending") {
      this.seenApprovals.delete(a.id);
      return;
    }
    if (this.seenApprovals.has(a.id)) return;
    this.seenApprovals.add(a.id);

    if (!Notification.isSupported()) {
      console.warn("[kin-desktop] Notification API not supported");
      return;
    }

    const title = a.task_title?.trim() || "Approval needed";
    const body = parseToolSummary(a.payload);
    const actions = notificationActions();

    const n = new Notification({
      title,
      body,
      silent: false,
      // macOS actions (best-effort; see module comment).
      actions,
      // Keep urgency high for approvals.
      urgency: "critical",
    });

    n.on("click", () => {
      this.cb.openApproval(a.id);
    });

    n.on("action", (_ev, index) => {
      const decision = index === 0 ? "approved" : "denied";
      void this.decide(a.id, decision);
    });

    n.show();
    console.log(`[kin-desktop] notification: approval ${a.id} — ${title}`);
  }

  onTaskUpdate(t: Task): void {
    if (!TERMINAL.has(t.status)) {
      // Reset so a re-run of the same task id can notify again.
      if (t.status === "running" || t.status === "queued") {
        this.seenTerminal.delete(t.id);
      }
      return;
    }
    const key = `${t.id}:${t.status}`;
    if (this.seenTerminal.has(key)) return;
    this.seenTerminal.add(key);

    if (!Notification.isSupported()) return;

    const title = t.title?.trim() || "Task finished";
    const body = statusLabel(t.status);
    const n = new Notification({
      title,
      body,
      silent: true, // quieter than approvals
      urgency: "low",
    });
    n.on("click", () => {
      this.cb.openTask(t.id);
    });
    n.show();
    console.log(`[kin-desktop] notification: task ${t.id} → ${t.status}`);
  }

  private async decide(id: string, decision: "approved" | "denied"): Promise<void> {
    const token = this.cb.getToken();
    if (!token) {
      console.error("[kin-desktop] cannot decide: no token");
      this.cb.openApproval(id);
      return;
    }
    try {
      await decideApproval(token, id, decision);
      console.log(`[kin-desktop] decided ${id} → ${decision} via notification`);
      this.cb.onDecided?.(id, decision);
    } catch (err) {
      console.error("[kin-desktop] decide failed", err);
      this.cb.openApproval(id);
    }
  }
}

function notificationActions(): NotificationAction[] {
  // Electron: actions supported on macOS (and Windows with limitations).
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return [];
  }
  return [
    { type: "button", text: "Approve" },
    { type: "button", text: "Deny" },
  ];
}

function statusLabel(status: string): string {
  switch (status) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}
