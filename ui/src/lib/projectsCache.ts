import { useSyncExternalStore } from "react";
import type { Project } from "../api/client";

/**
 * The last successful `/projects` read, kept outside the page.
 *
 * The collection is a block the reader returns to — from a conversation, from a
 * project cover, from anywhere the Back stack leads. A page-local `useState`
 * made every return start at `null`, so the four-row skeleton was painted and
 * then replaced by rows the reader had just seen. TASTE 15 says the skeleton
 * belongs to a block's first load only; after that the block stays and updates
 * in place.
 *
 * Same shape as `panelPresence` and `backStack`: a module-level store the page
 * writes and the page reads through `useSyncExternalStore`, with a server
 * snapshot of "nothing loaded". Only a successful read replaces the value, so a
 * failed revalidation leaves the kept rows alone.
 *
 * Sign-out is a full reload (`AccountSection` calls `window.location.assign`),
 * so this module store is discarded with the rest of the page's memory; there
 * is no account-switch path that keeps it alive.
 */

let cached: Project[] | null = null;
const subscribers = new Set<() => void>();

function publish(): void {
  for (const notify of subscribers) notify();
}

/** Watch the kept block (for `useSyncExternalStore`). */
export function subscribeProjects(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** The last successful read, or `null` before one. */
export function cachedProjects(): Project[] | null {
  return cached;
}

/** Record a successful read so the next mount paints rows instead of a skeleton. */
export function setCachedProjects(projects: Project[]): void {
  cached = projects;
  publish();
}

/** Test hook: forget the kept block between mounts. */
export function resetProjectsCache(): void {
  cached = null;
  publish();
}

/** Read the kept block; `null` until the first successful read. */
export function useCachedProjects(): Project[] | null {
  return useSyncExternalStore(subscribeProjects, cachedProjects, () => null);
}
