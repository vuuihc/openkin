import type { TaskEvent } from "../api/client";

/**
 * The words a publish starts from.
 *
 * The agent has already written the description: it is the last thing it said,
 * in prose, and asking it for a structured reply now would be a second version
 * of the same paragraph. So the sheet opens with the agent's own answer in it —
 * title from the first line, body from the whole — and the person edits what
 * they want before anything is pushed.
 *
 * A prefill is a draft, not a decision: everything here is editable, and an
 * empty answer leaves both boxes empty rather than inventing a description
 * nobody wrote.
 */
export type PublishDraft = {
  title: string;
  body: string;
};

/** The longest title a first line is allowed to become, before it is cut. */
const MAX_TITLE = 120;

/**
 * The longest body taken from an answer.
 *
 * The wire's own bound is far larger; this one is about the phone. A session's
 * last answer is usually a few paragraphs, and one that is a megabyte of pasted
 * code is one the person is not going to read in a textarea — the prefill stops
 * here and the box still scrolls.
 */
const MAX_BODY = 16000;

export function publishDraftFrom(events: readonly TaskEvent[]): PublishDraft {
  const body = lastAssistantText(events);
  if (!body.trim()) return { title: "", body: "" };
  return { title: titleFrom(body), body: cut(body, MAX_BODY) };
}

/**
 * The text of the agent's last answer, streaming included.
 *
 * The rule is the transcript's own, and it has to be: a partial message is a
 * piece of the answer being written, so it appends to the answer in progress
 * rather than starting a new one — otherwise the draft would be the last token
 * of a streamed reply.
 */
function lastAssistantText(events: readonly TaskEvent[]): string {
  let answer = "";
  let streaming = "";
  for (const ev of events) {
    if (ev.type !== "message") continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (String(p.role ?? "assistant") !== "assistant") continue;
    const text = messageText(p.content);
    if (!text) continue;
    if (p.partial) {
      streaming += text;
      continue;
    }
    answer = text;
    streaming = "";
  }
  // A reply still arriving is the newest thing the agent has said, and it is
  // what the person is looking at when they open the sheet.
  return streaming || answer;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "",
    )
    .join("");
}

/**
 * A first line worth putting in a title box.
 *
 * Markdown headings and list markers are how the answer is laid out, not part
 * of what it says, so they come off; a first line that is only punctuation or
 * is very long is the answer's shape rather than its subject, and the person
 * gets an empty box they can fill in a second.
 */
function titleFrom(body: string): string {
  const first = body.split("\n").find((line) => line.trim().length > 0) ?? "";
  const cleaned = first
    .replace(/^\s*(#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cut(cleaned, MAX_TITLE);
}

function cut(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit).trimEnd() + "…";
}
