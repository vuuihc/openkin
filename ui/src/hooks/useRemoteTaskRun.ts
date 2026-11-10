import { useCallback, useEffect, useState } from "react";
import {
  getMachineTask,
  isTerminal,
  listMachineTaskEvents,
  type Task,
  type TaskEvent,
} from "../api/client";
import { highestContiguousSeq, mergeEventsBySeq } from "../lib/eventStream";

/**
 * One run that lives on another machine, kept current while it is open.
 *
 * The Hub cannot push another machine's task updates: its WebSocket carries the
 * tasks this daemon owns, and a routine run is a row in the machine's store.
 * So the page polls the machine through the Hub while the run is not finished
 * — the same "HTTP is the truth, realtime is an accelerant" rule ADR 0024 sets
 * for the session feed. A finished run is read once and not polled again.
 *
 * The transcript is read after the highest *contiguous* seq, not the highest
 * one seen: a gap means an event has not arrived yet, and asking from before it
 * is how the gap closes. Merging by seq keeps a late answer from duplicating a
 * row that already landed.
 */
export type RemoteTaskRun = {
  task: Task | null;
  events: TaskEvent[];
  loaded: boolean;
  error: unknown;
  /** Re-read now, after a failed first load. */
  retry: () => void;
};

const POLL_MS = 3000;
const RETRY_MS = 5000;

const EMPTY: RemoteTaskRun = {
  task: null,
  events: [],
  loaded: false,
  error: null,
  retry: () => undefined,
};

export function useRemoteTaskRun(device: string, id: string): RemoteTaskRun {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<RemoteTaskRun, "retry">>({
    task: null,
    events: [],
    loaded: false,
    error: null,
  });

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!device || !id) {
      setState({ task: null, events: [], loaded: false, error: null });
      return;
    }
    let live = true;
    let timer: number | undefined;
    let running = false;
    let events: TaskEvent[] = [];
    let cursor = 0;
    setState({ task: null, events: [], loaded: false, error: null });

    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), delay);
    };

    const load = async () => {
      // One read at a time: a slow answer must not stack a second poll on top
      // of it, or a machine that is merely slow gets a queue of questions.
      if (running || !live) return;
      running = true;
      try {
        const [task, page] = await Promise.all([
          getMachineTask(device, id),
          listMachineTaskEvents(device, id, cursor),
        ]);
        if (!live) return;
        events = mergeEventsBySeq(events, page);
        cursor = highestContiguousSeq(events);
        setState({ task, events, loaded: true, error: null });
        if (!isTerminal(task.status)) schedule(POLL_MS);
      } catch (e) {
        if (!live) return;
        // Keep whatever the page already has: a poll that failed after a good
        // answer is not a reason to blank a run the reader is looking at.
        setState((prev) => ({ ...prev, error: e }));
        // A machine that went away comes back; a page left open waits for it
        // rather than making the reader reload. A failed first read shows the
        // error immediately and still retries behind it.
        schedule(RETRY_MS);
      } finally {
        running = false;
      }
    };

    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [device, id, attempt]);

  if (!device || !id) return EMPTY;
  return { ...state, retry };
}
