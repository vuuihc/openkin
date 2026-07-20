import { create } from "zustand";

/** Auth gate: session is usable until a 401 (or missing token) forces reconnect. */
export type AuthState =
  | { status: "ok" }
  | { status: "need_token"; reason: "missing" | "unauthorized" };

/** Minimal WS message shape (avoid importing client → circular store↔client). */
export type WSMessage =
  | { kind: "task_update"; data: unknown }
  | { kind: "task_deleted"; data: unknown }
  | { kind: "event"; data: unknown }
  | { kind: "approval_update"; data: unknown };

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
  wsStatus: WSStatus;
  /** Bumped on every successful WS open so list pages can re-fetch (self-heal). */
  reconnectGen: number;
  toasts: Toast[];
  setAuthOk: () => void;
  requireToken: (reason: "missing" | "unauthorized") => void;
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
  auth: hasStoredToken()
    ? { status: "ok" }
    : { status: "need_token", reason: "missing" },
  wsStatus: "disconnected",
  reconnectGen: 0,
  toasts: [],
  setAuthOk: () => set({ auth: { status: "ok" } }),
  requireToken: (reason) => set({ auth: { status: "need_token", reason } }),
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
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
