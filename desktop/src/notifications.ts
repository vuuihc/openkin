import type { NotificationAction } from "electron";
import {
  NotifyDeduper,
  notifyHasDecisionActions,
  safeNotifyPath,
  shouldAnnounceNotify,
  type NotifyEvent,
} from "./native-notifications.ts";

/**
 * Native notification display (macOS).
 *
 * The node owns the decision to notify and fans one event out to this shell and
 * to every registered iPhone; the shell only displays what arrives. That is why
 * there is one `onNotify` here rather than a handler per event type — approvals,
 * questions, terminal tasks, quota waits, routine reports and offline workers
 * all travel the same path, with the same title and body the phone sees.
 *
 * Electron's Notification API supports `actions` on macOS, but action buttons
 * are unreliable: they require alert-style banners, may not appear when the
 * app is focused, and behavior varies by macOS version / focus state. Approve /
 * Deny are still attached for approvals when the platform reports support; the
 * reliable path is always: click the notification → open the item in the main
 * window.
 */
export type NotificationCallbacks = {
  /** Open a console path in the main window. */
  openPath: (path: string) => void;
  getToken: () => string | null;
  onDecided?: (id: string, decision: "approved" | "denied") => void;
  /** Whether the main window is the focused window. */
  isFocused?: () => boolean;
  /** The task the main window is showing, if any. */
  viewingTaskId?: () => string | null;
  /** Origin of the console the window is showing, for resolving relative links. */
  origin?: () => string | null;
};

/** The slice of Electron's Notification the shell uses. */
export type NotificationHandle = {
  on(event: "click", listener: () => void): void;
  on(event: "action", listener: (event: unknown, index: number) => void): void;
  show(): void;
  /** Remove an earlier banner for the same target. */
  close?(): void;
};

export type NotificationOptions = {
  title: string;
  body: string;
  silent: boolean;
  actions: NotificationAction[];
  urgency: "critical" | "normal";
};

/** The approval decision the shell sends when an action button is pressed. */
export type DecideApproval = (
  token: string,
  id: string,
  decision: "approved" | "denied",
) => Promise<unknown>;

/** Injectable seams, so the display policy can be tested without Electron. */
export type NotifierDeps = {
  createNotification?: (options: NotificationOptions) => NotificationHandle;
  isSupported?: () => boolean;
  decideApproval?: DecideApproval;
};

/** The real Electron notification, loaded lazily: under plain Node (the
 * tests) `import "electron"` resolves to the binary path, not the API. */
function electronNotification(options: NotificationOptions): NotificationHandle {
  const { Notification } = require("electron") as typeof import("electron");
  return new Notification(options);
}

function electronSupported(): boolean {
  const { Notification } = require("electron") as typeof import("electron");
  return Notification.isSupported();
}

/** Loaded lazily for the same reason, and because daemon-api pulls in the
 * Electron `app` module that the policy tests must not need. */
function daemonDecideApproval(
  token: string,
  id: string,
  decision: "approved" | "denied",
): Promise<unknown> {
  const { decideApproval } = require("./daemon-api") as typeof import("./daemon-api");
  return decideApproval(token, id, decision);
}

export class Notifier {
  private cb: NotificationCallbacks;
  private dedupe = new NotifyDeduper();
  private createNotification: (options: NotificationOptions) => NotificationHandle;
  private isSupported: () => boolean;
  private decideApproval: DecideApproval;
  // One slot per kind and target, mirroring apns-collapse-id on the phone.
  // Without it a quota wait and its resume stack in Notification Center even
  // though the phone shows one banner.
  private showing = new Map<string, NotificationHandle>();
  static readonly MAX_SHOWN = 512;

  constructor(cb: NotificationCallbacks, deps: NotifierDeps = {}) {
    this.cb = cb;
    this.createNotification = deps.createNotification ?? electronNotification;
    this.isSupported = deps.isSupported ?? electronSupported;
    this.decideApproval = deps.decideApproval ?? daemonDecideApproval;
  }

  onNotify(ev: NotifyEvent): void {
    const announce = shouldAnnounceNotify(ev, {
      focused: this.cb.isFocused?.() ?? false,
      viewingTaskId: this.cb.viewingTaskId?.() ?? null,
    });
    // Record suppressed events too: the reader already saw that task end on
    // screen, and a later rebroadcast must not turn it into a banner.
    if (!this.dedupe.remember(ev)) return;
    const key = notificationKey(ev);
    const previous = this.showing.get(key);
    if (!announce) {
      // The new state still replaces the banner it supersedes. A quota wait
      // that resumed while the reader is looking at the task must not leave
      // the "waiting" banner behind offering a stale tap.
      if (previous) this.closeBanner(key, previous);
      console.log(`[kin-desktop] notification: ${ev.kind} ${ev.id} on screen — not announced`);
      return;
    }
    if (!this.isSupported()) {
      console.warn("[kin-desktop] Notification API not supported");
      return;
    }

    const actions = notifyHasDecisionActions(ev.kind) ? notificationActions() : [];
    const n = this.createNotification({
      title: ev.title.trim() || "Kin",
      body: ev.body,
      silent: false,
      // macOS actions (best-effort; see module comment).
      actions,
      // Approvals are the one kind that blocks an agent until a person acts.
      urgency: ev.kind === "approval" ? "critical" : "normal",
    });

    // The new state replaces the banner it supersedes, on the phone and here.
    this.showing.get(key)?.close?.();
    this.showing.delete(key);
    if (this.showing.size >= Notifier.MAX_SHOWN) {
      const oldest = this.showing.keys().next().value;
      if (oldest !== undefined) {
        // Evicting the entry without closing its banner would leave one on
        // screen that dismiss and decision can no longer reach.
        this.showing.get(oldest)?.close?.();
        this.showing.delete(oldest);
      }
    }
    this.showing.set(key, n);

    n.on("click", () => {
      this.closeBanner(key, n);
      this.cb.openPath(this.pathFor(ev));
    });

    if (actions.length > 0) {
      n.on("action", (_ev, index) => {
        const decision = index === 0 ? "approved" : "denied";
        void this.decide(ev, decision);
      });
    }

    n.show();
    console.log(`[kin-desktop] notification: ${ev.kind} ${ev.id} — ${ev.title}`);
  }

  private closeBanner(key: string, handle: NotificationHandle): void {
    if (this.showing.get(key) !== handle) return;
    this.showing.delete(key);
    handle.close?.();
  }

  private pathFor(ev: NotifyEvent): string {
    return safeNotifyPath(ev.url, this.cb.origin?.() ?? undefined);
  }

  private async decide(ev: NotifyEvent, decision: "approved" | "denied"): Promise<void> {
    const token = this.cb.getToken();
    if (!token) {
      console.error("[kin-desktop] cannot decide: no token");
      this.cb.openPath(this.pathFor(ev));
      return;
    }
    try {
      await this.decideApproval(token, ev.id, decision);
      const key = notificationKey(ev);
      const shown = this.showing.get(key);
      if (shown) this.closeBanner(key, shown);
      console.log(`[kin-desktop] decided ${ev.id} → ${decision} via notification`);
      this.cb.onDecided?.(ev.id, decision);
    } catch (err) {
      console.error("[kin-desktop] decide failed", err);
      this.cb.openPath(this.pathFor(ev));
    }
  }
}

function notificationKey(ev: NotifyEvent): string {
  return `${ev.kind}:${ev.id}`;
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
