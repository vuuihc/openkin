import {
  getSessionCursor,
  listSessions,
  streamEvents,
  waitSessions,
  type SessionChangePage,
  type WSMessage,
} from "./client";
import type { LiveResourceStore } from "./liveResources";
import { useAppStore } from "../store/appStore";

/** How long one long-poll request may hang on the Hub before it gives up. */
const LONG_POLL_SECONDS = 25;
/** Rows per catch-up page. */
const PAGE_LIMIT = 200;
/** Cap on the pause after a failed request, in milliseconds. */
const RETRY_MAX_MS = 15_000;
/**
 * How often the loop re-checks which channel it should be using. While the
 * stream is delivering there is nothing to do but wait: the stream's own
 * watchdogs notice a connection that has quietly died.
 */
const CHANNEL_TICK_MS = 5_000;

export type SessionSyncOptions = {
  /**
   * Called for every change the console should react to, whether it arrived as
   * a live frame or out of a catch-up page. A change recovered from a page
   * deserves the same toast and badge as one that arrived live.
   */
  onMessage?: (message: WSMessage) => void;
};

/**
 * Keeps this console in step with the Hub.
 *
 * The Hub keeps one ordered feed of session changes (see the store's global
 * cursor), and this is the whole client side of it: read the cursor, drain the
 * feed into the live resource store, and use the realtime channel only to find
 * out sooner.
 *
 * That order is what makes the console correct on a network that cannot stream.
 * A frame is never the source of truth and never moves the cursor — only a feed
 * page does — so a dropped stream, a sleeping laptop, or a proxy that buffers
 * responses costs latency and nothing else. Cancel a turn on the phone, open the
 * laptop an hour later, and the laptop learns exactly what it missed.
 */
export class SessionSync {
  private readonly store: LiveResourceStore;
  private readonly options: SessionSyncOptions;
  private cursor: number | null = null;
  private stopStream: (() => void) | null = null;
  private poll: AbortController | null = null;
  private stopped = true;
  private streaming = false;
  private failures = 0;

  constructor(store: LiveResourceStore, options: SessionSyncOptions = {}) {
    this.store = store;
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus("connecting");
    this.stopStream = streamEvents({
      onMessage: (message) => this.deliver(message),
      onOpen: () => {
        this.streaming = true;
        this.setStatus("connected");
        // Frames resume here, but what was missed while the stream was down is
        // not replayed on it: the gap is closed over HTTP, before anything the
        // stream delivers from now on is believed. Transcripts of open sessions
        // have no feed of their own, so they are re-read from their event
        // cursors too.
        void this.drain();
        void this.store.refreshOpenDetails();
      },
      onStatus: (status) => {
        if (status === "connected") return;
        this.streaming = false;
      },
      onUnavailable: () => {
        // This network will not carry a stream. The loop below long-polls
        // instead, which is slower and just as correct.
        this.streaming = false;
      },
    });
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.stopStream?.();
    this.stopStream = null;
    this.poll?.abort();
    this.poll = null;
  }

  /**
   * The console is in sync with the Hub when either channel is delivering.
   * Showing "offline" because the stream is unavailable would be wrong on the
   * long-poll path, where everything still works.
   */
  private setStatus(status: "connecting" | "connected" | "disconnected"): void {
    useAppStore.getState().setWSStatus(status);
  }

  private deliver(message: WSMessage): void {
    this.store.applyMessage(message);
    this.options.onMessage?.(message);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.cursor === null) {
        await this.loadCursor();
        continue;
      }
      if (this.streaming) {
        await sleep(CHANNEL_TICK_MS);
        continue;
      }
      await this.pollOnce();
    }
  }

  /**
   * Read the current end of the feed.
   *
   * This happens before the console has any session list, so that every change
   * the lists then hear about is either newer than what they fetched or already
   * part of it. Taking the cursor after the lists would silently drop whatever
   * changed in between.
   */
  private async loadCursor(): Promise<void> {
    try {
      this.cursor = await getSessionCursor();
      this.failures = 0;
      this.setStatus("connected");
    } catch {
      await this.backOff();
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped || this.cursor === null) return;
      let page: SessionChangePage;
      const startedAt = this.store.currentRevision();
      try {
        page = await listSessions({
          updatedSince: this.cursor,
          limit: PAGE_LIMIT,
        });
        this.failures = 0;
        this.setStatus("connected");
      } catch {
        await this.backOff();
        return;
      }
      if (this.stopped) return;
      this.applyPage(page, startedAt);
      if (!page.has_more) return;
    }
  }

  private async pollOnce(): Promise<void> {
    const startedAt = this.store.currentRevision();
    this.poll = new AbortController();
    try {
      const page = await waitSessions({
        updatedSince: this.cursor ?? undefined,
        timeoutSeconds: LONG_POLL_SECONDS,
        signal: this.poll.signal,
      });
      this.poll = null;
      this.failures = 0;
      this.setStatus("connected");
      if (this.stopped) return;
      const applied = this.applyPage(page, startedAt);
      if (page.has_more) await this.drain();
      if (applied.length > 0) {
        // No frames reach this client, so the inbox and any open transcript
        // are re-read on the same signal a frame would have carried.
        void this.store.refreshPending(true);
        void this.store.refreshOpenDetails(changedTaskIds(applied));
      }
    } catch {
      this.poll = null;
      if (this.stopped) return;
      await this.backOff();
    }
  }

  private applyPage(page: SessionChangePage, startedAt: number): WSMessage[] {
    const applied = this.store.applyChangesSince(
      startedAt,
      page.sessions ?? [],
      page.deleted ?? [],
    );
    if (typeof page.next_cursor === "number") this.cursor = page.next_cursor;
    for (const message of applied) this.options.onMessage?.(message);
    return applied;
  }

  private async backOff(): Promise<void> {
    if (this.stopped) return;
    const delay = Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(this.failures, 4));
    this.failures += 1;
    this.setStatus("disconnected");
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function changedTaskIds(messages: readonly WSMessage[]): string[] {
  return messages
    .filter((message) => message.kind === "task_update")
    .map((message) => message.data.id);
}
