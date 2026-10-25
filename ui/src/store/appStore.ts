import { create } from "zustand";
import type { WSMessage } from "../api/contract";
import { closeOpenPanel, nextOpenPanel, type OpenPanel, type PanelId } from "../lib/panels";

/** Auth gate: session is usable until a 401 (or missing token) forces reconnect. */
export type AuthState =
  | { status: "ok" }
  | { status: "need_token"; reason: "missing" | "unauthorized" }
  | { status: "need_account"; mode: "claim" | "login" };

/** One sign-in method offered by the Hub. Empty on a standalone daemon. */
export type AccountProvider = {
  id: string;
  label: string;
  kind: "password" | "oidc";
  start_url?: string;
};

/**
 * The Hub's account surface, as reported by GET /api/auth/status.
 *
 * A standalone daemon answers with no providers, which is how the console
 * knows to keep its original token screen instead of asking for a login.
 */
export type AccountState = {
  enabled: boolean;
  authenticated: boolean;
  needsBootstrap: boolean;
  claimable: boolean;
  providers: AccountProvider[];
  email?: string;
  displayName?: string;
};

export const NO_ACCOUNT: AccountState = {
  enabled: false,
  authenticated: false,
  needsBootstrap: false,
  claimable: false,
  providers: [],
};

export type WSStatus = "connecting" | "connected" | "disconnected";

export type Toast = {
  id: number;
  message: string;
  tone: "error" | "info";
};

type WSListener = (msg: WSMessage) => void;

/** Module-level fan-out so App holds one socket; pages subscribe without extra connections. */
const wsListeners = new Set<WSListener>();

export function subscribeWS(listener: WSListener): () => void {
  wsListeners.add(listener);
  return () => {
    wsListeners.delete(listener);
  };
}

export function dispatchWS(msg: WSMessage): void {
  for (const l of wsListeners) {
    try {
      l(msg);
    } catch {
      // page listener errors must not break the bus
    }
  }
}

type AppState = {
  auth: AuthState;
  account: AccountState;
  wsStatus: WSStatus;
  /** Bumped on every successful WS open so list pages can re-fetch (self-heal). */
  reconnectGen: number;
  toasts: Toast[];
  /**
   * The one panel that is over the app, and the view it belongs to.
   *
   * The surfaces all render in the same place at the same z-index, so the task
   * page and the shell each keeping their own let the terminal paint over an open
   * workspace panel and strand its close button. One value with one owner fixes
   * that; the owner is also what keeps switching sessions from carrying a panel
   * across, and what lets switching back bring it back. See `lib/panels`.
   */
  shownPanel: OpenPanel;
  showPanel: (view: string, id: PanelId) => void;
  hidePanel: (view: string) => void;
  togglePanel: (view: string, id: PanelId) => void;
  setAuthOk: () => void;
  requireToken: (reason: "missing" | "unauthorized") => void;
  requireAccount: (mode: "claim" | "login") => void;
  setAccount: (account: AccountState) => void;
  setWSStatus: (s: WSStatus) => void;
  noteReconnect: () => void;
  pushToast: (message: string, tone?: "error" | "info") => void;
  dismissToast: (id: number) => void;
};

let toastSeq = 0;

function hasStoredToken(): boolean {
  try {
    return !!localStorage.getItem("kin_token");
  } catch {
    return false;
  }
}

export const useAppStore = create<AppState>((set) => ({
  auth: hasStoredToken() ? { status: "ok" } : { status: "need_token", reason: "missing" },
  account: NO_ACCOUNT,
  wsStatus: "disconnected",
  reconnectGen: 0,
  toasts: [],
  // `showPanel` opens without toggling (clicking a changed file must not close
  // the panel it lives in); `togglePanel` is for the buttons that name a panel.
  shownPanel: null,
  showPanel: (view, id) => set({ shownPanel: { view, id } }),
  hidePanel: (view) => set((s) => ({ shownPanel: closeOpenPanel(s.shownPanel, view) })),
  togglePanel: (view, id) => set((s) => ({ shownPanel: nextOpenPanel(s.shownPanel, view, id) })),
  setAuthOk: () => set({ auth: { status: "ok" } }),
  requireToken: (reason) => set({ auth: { status: "need_token", reason } }),
  requireAccount: (mode) => set({ auth: { status: "need_account", mode } }),
  setAccount: (account) => set({ account }),
  setWSStatus: (wsStatus) => set({ wsStatus }),
  noteReconnect: () => set((s) => ({ reconnectGen: s.reconnectGen + 1 })),
  pushToast: (message, tone = "error") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    // Auto-dismiss after 5s.
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
