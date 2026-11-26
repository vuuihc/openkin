/**
 * KIN-MOBILE-001 R7 — when the phone reopens a conversation's live stream.
 *
 * Pure policy, no React and no transport: the screen asks whether a platform
 * app-state change is a return to the foreground, and the view asks whether
 * the offline banner may offer its one manual retry. The reconnect itself is
 * the thread model's (`resume()`), so there is no second stream here.
 */

import type { ThreadBanner, ThreadStatus } from "../thread/threadModel";

/**
 * The slice of React Native's `AppState` status this policy reads. Kept
 * structural so the screen's injected seam and the real module are the same
 * shape without importing React Native into this module.
 */
export type AppStateStatus =
  | "active"
  | "background"
  | "inactive"
  | "unknown"
  | "extension";

/** The slice of React Native's `AppState` the screen subscribes to. */
export type AppStateLike = {
  currentState: AppStateStatus;
  addEventListener(
    type: "change",
    listener: (status: AppStateStatus) => void,
  ): { remove(): void };
};

/**
 * React Native types `AppState.currentState` loosely (`string | null`, null
 * until the platform sets it). A value outside the union is not a foreground
 * return, so it reads as `unknown` rather than being trusted.
 */
export function asAppStateStatus(
  value: string | null | undefined,
): AppStateStatus {
  switch (value) {
    case "active":
    case "background":
    case "inactive":
    case "unknown":
    case "extension":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Only becoming active from a non-active state is a return: iOS walks
 * inactive → background and back, and an `active` already being active is a
 * duplicate event, not a reason to reopen anything.
 */
export function shouldResume(
  previous: AppStateStatus,
  next: AppStateStatus,
): boolean {
  return next === "active" && previous !== "active";
}

/**
 * The offline banner's retry is offered exactly when the live stream is gone
 * but the screen still has content. The blank/expired screen (`status:
 * "error"`) owns its own full-screen `onRetry`, so the banner must not draw a
 * second one.
 */
export function canRetry(state: {
  banner: ThreadBanner;
  status: ThreadStatus;
}): boolean {
  return state.banner === "offline" && state.status !== "error";
}
