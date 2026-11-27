/**
 * KIN-MOBILE-001 §5 离开再回来 — the words a conversation keeps while its route
 * is gone.
 *
 * The composer's text was component state, so Back from a conversation
 * unmounted it and the draft was lost. The signed story promises
 * 「草稿、队列与滚动位置保留」; this row owns the draft half. The memory is
 * headless — plain functions over a map, injected through props with one shared
 * default, the shape `listModel.ts` uses for the list's memory — so a test gets
 * a fresh one and the app hands the same store to every mount of the route.
 *
 * Keyed by task id: a conversation never reads another conversation's words
 * (AGENTS.md §11). An emptied box removes its entry, so the map cannot grow one
 * key per conversation the reader ever opened.
 */

export type DraftMemory = {
  /** The words last left in this conversation's composer; "" when none. */
  read(taskId: string): string;
  /** Remember the box's current words; "" forgets them. */
  write(taskId: string, text: string): void;
};

/** A fresh memory; tests inject one per case, the app uses `sharedDraftMemory`. */
export function createDraftMemory(): DraftMemory {
  const drafts = new Map<string, string>();
  return {
    read: (taskId) => drafts.get(taskId) ?? "",
    write: (taskId, text) => {
      if (text === "") {
        drafts.delete(taskId);
      } else {
        drafts.set(taskId, text);
      }
    },
  };
}

/** The app's one memory: the conversation route remounts onto it. */
export const sharedDraftMemory: DraftMemory = createDraftMemory();
