import type { TaskEvent } from "../api/client";
import { resolveSpeaker } from "../components/chat/eventMeta";
import { displayUserPrompt } from "./attachments";

/**
 * A user message the console is already showing while the send is still in
 * flight.
 *
 * The composer clears itself the moment the person submits, so the message they
 * just wrote disappears from the screen until the daemon answers. The product
 * answer (gap log, 2026-11-12) is the opposite: the bubble appears in the same
 * update that clears the input, and the waiting row follows it. This type is
 * that local copy, and `settlePendingSends` is when it goes away: as soon as the
 * transcript contains the message the daemon wrote for it.
 *
 * The server writes the visible user event at accept time, before the follow-up
 * request answers, so a successful send always has a real message to hand over
 * to. `startSeq` is the transcript's high-water mark when the send began: only
 * events after it can be this send's copy, which keeps an older message with
 * the same words from claiming the pending bubble.
 */
export type PendingSend = {
  /** Identity for React keys; a counter, not a server id. */
  id: string;
  /** What the reader sees, already normalised by `displayUserPrompt`. */
  text: string;
  /** Highest event seq the transcript held when the send started. */
  startSeq: number;
};

let idCounter = 0;

/** A local id, unique for the life of this page. */
export function nextPendingSendId(): string {
  idCounter += 1;
  return `pending-${idCounter}`;
}

/**
 * The pending copy of a send the composer just handed over.
 *
 * The text goes through `displayUserPrompt` here rather than at render time so
 * it is compared in the same shape the transcript will render: the composer
 * appends an "Attached …" block for uploads, and the timeline shows that block
 * as a short summary instead of local paths.
 */
export function pendingSend(rawText: string, events: TaskEvent[]): PendingSend {
  let startSeq = 0;
  for (const event of events) {
    if (event.seq > startSeq) startSeq = event.seq;
  }
  return { id: nextPendingSendId(), text: displayUserPrompt(rawText), startSeq };
}

/** The visible text of a user message event, or null when it is not one. */
export function userMessageText(event: TaskEvent): string | null {
  if (event.type !== "message") return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (resolveSpeaker(payload) !== "user") return null;
  const content = payload.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  if (!text && typeof payload.text === "string") text = payload.text;
  return displayUserPrompt(text);
}

/**
 * Drop the pending sends whose server copy has landed.
 *
 * Matching is by visible text and by "after the send began", and each event can
 * settle only one pending send: two identical messages sent in a row keep their
 * two bubbles until both events exist, and never collapse into one. An event
 * with other text is somebody else's message (a second device, a retry) and is
 * left alone.
 *
 * Returns the same array when nothing settled, so a page can call this from an
 * effect on every event batch without re-rendering for free.
 */
export function settlePendingSends(
  pending: readonly PendingSend[],
  events: readonly TaskEvent[],
): readonly PendingSend[] {
  if (pending.length === 0) return pending;
  const consumed = new Set<number>();
  const remaining: PendingSend[] = [];
  for (const send of pending) {
    const match = events.find((event) => {
      if (consumed.has(event.seq) || event.seq <= send.startSeq) return false;
      const text = userMessageText(event);
      return text !== null && text.trim() === send.text.trim();
    });
    if (match) consumed.add(match.seq);
    else remaining.push(send);
  }
  return remaining.length === pending.length ? pending : remaining;
}

/** The list as React state holds it: same instance when nothing settled. */
export function settlePendingSendList(
  pending: PendingSend[],
  events: readonly TaskEvent[],
): PendingSend[] {
  const next = settlePendingSends(pending, events);
  return next === pending ? pending : [...next];
}
