/**
 * KIN-MOBILE-001 §5 离开再回来 — the sends a conversation keeps while its route
 * is gone.
 *
 * The signed story promises 「草稿、队列与滚动位置保留；不重复发送」
 * (docs/product/stories/KIN-MOBILE-001.md:103). The draft and the reading place
 * already have a store; the queue was the last piece that lived only in a
 * thread model, and Back unmounts that model. This is the queue's memory,
 * headless — plain functions over a map, injected through props with one shared
 * default, the same shape as `draftMemory.ts` and the list's memory.
 *
 * Keyed by task id: a conversation never shows another conversation's queue
 * (AGENTS.md §11). An emptied queue removes its entry, so the map cannot grow
 * one key per conversation the reader ever opened.
 */

import type { QueuedSend } from "./threadModel";

export type QueueMemory = {
  /** The sends this conversation still owes; empty when none. */
  read(taskId: string): QueuedSend[];
  /** Remember the queue as it stands; an empty list forgets it. */
  write(taskId: string, items: readonly QueuedSend[]): void;
};

/** A fresh memory; tests inject one per case, the app uses `sharedQueueMemory`. */
export function createQueueMemory(): QueueMemory {
  const queues = new Map<string, QueuedSend[]>();
  return {
    // A copy per read: a caller that edits what it was handed must not edit
    // the stored queue behind the model's back.
    read: (taskId) => (queues.get(taskId) ?? []).map((item) => ({ ...item })),
    write: (taskId, items) => {
      if (items.length === 0) {
        queues.delete(taskId);
      } else {
        queues.set(
          taskId,
          items.map((item) => ({ ...item })),
        );
      }
    },
  };
}

/** The app's one memory: the conversation route remounts onto it. */
export const sharedQueueMemory: QueueMemory = createQueueMemory();
