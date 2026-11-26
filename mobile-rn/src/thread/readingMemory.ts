/**
 * KIN-MOBILE-001 §3/§4 离开再回来 — where a conversation was left.
 *
 * The route pops on Back, so the view and its refs go with it; the place the
 * reader was reading at has to live outside the mount. This memory is the
 * place: plain functions over a map, injected through props with one shared
 * default, the shape `draftMemory.ts` uses for the composer and
 * `listModel.ts` uses for the list. No React, no storage, no layout.
 *
 * The place is keyed by task id: a conversation never restores another
 * conversation's page (AGENTS.md §11). `pinned` travels with the offset
 * because the two are one decision — a reader who left at the live edge wants
 * the newest segment, not the offset they happened to stop at.
 */

export type ReadingPlace = {
  /** The scroll offset the reader was last seen at. */
  offset: number;
  /** True when they were within the follow band of the end. */
  pinned: boolean;
};

export type ReadingMemory = {
  /** Where this conversation was left; null when it was never left. */
  read(taskId: string): ReadingPlace | null;
  /** Remember the place the reader was last seen at. */
  write(taskId: string, place: ReadingPlace): void;
};

/** A fresh memory; tests inject one per case, the app uses `sharedReadingMemory`. */
export function createReadingMemory(): ReadingMemory {
  const places = new Map<string, ReadingPlace>();
  return {
    // The stored place is copied both ways: the caller keeps its own object,
    // and a later write cannot move a place already handed out.
    read: (taskId) => {
      const place = places.get(taskId);
      return place === undefined ? null : { ...place };
    },
    write: (taskId, place) => {
      places.set(taskId, { ...place });
    },
  };
}

/** The app's one memory: the conversation route remounts onto it. */
export const sharedReadingMemory: ReadingMemory = createReadingMemory();
