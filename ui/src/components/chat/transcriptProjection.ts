import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import {
  decodeCanonicalEventMeta,
  isProgressMessageMeta,
  resolveSpeaker,
} from "./eventMeta";
import { displayUserPrompt } from "../../lib/attachments";

export type ToolStep = {
  kind: "tool";
  key: string;
  speaker: string;
  model?: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  input?: unknown;
  output?: string;
};

export type NoteStep = {
  kind: "note";
  key: string;
  speaker: string;
  model?: string;
  text: string;
  status: "running" | "done" | "error";
};

export type ProgressStep = ToolStep | NoteStep;

export type ProgressItem = {
  kind: "progress";
  key: string;
  /** Host speaker for alignment (usually kin). */
  speaker: string;
  model?: string;
  steps: ProgressStep[];
};

export type ChatItem =
  | {
      kind: "message";
      key: string;
      speaker: string;
      model?: string;
      text: string;
      partial?: boolean;
      /** Source event seq (for retry/fork). */
      seq?: number;
    }
  | ProgressItem
  | { kind: "error"; key: string; message: string }
  | { kind: "meta"; key: string; label: string };

/** Visual grouping: one user bubble, or one agent column (single avatar). */
export type Turn =
  | { kind: "user"; item: Extract<ChatItem, { kind: "message" }> }
  | {
      kind: "agent";
      /** Host speaker for the shared left avatar. */
      speaker: string;
      model?: string;
      items: ChatItem[];
    }
  | {
      kind: "standalone";
      item: Extract<ChatItem, { kind: "error" | "meta" }>;
    };

/**
 * Project raw task events into the chat transcript model used by ChatStream.
 * This module owns protocol tolerance: legacy tool dumps, worker visibility,
 * streaming partial coalescing, and progress grouping.
 */
export function buildChatItems(
  events: TaskEvent[],
  hostSpeaker = "",
  hostModel?: string | null,
  finalized = false,
): ChatItem[] {
  const items: ChatItem[] = [];
  let streamBuf = "";
  let streamSpeaker = hostSpeaker;
  let streamModel = normalizeModel(hostModel);
  let streamKey = "stream";
  let streamProgress = false;
  const modelsBySpeaker = new Map<string, string>();
  if (streamModel) modelsBySpeaker.set(hostSpeaker, streamModel);

  // Merge tool_use -> tool_result by tool_use_id so UI shows one step.
  const toolById = new Map<string, ToolStep>();
  // Active open progress group (tools + intermediate notes between user-facing msgs).
  // Box avoids TS CFA treating nested-function writes as unreachable.
  const progressRef: { current: ProgressItem | null } = { current: null };
  // Streaming note step key inside the progress box.
  let streamNoteKey: string | null = null;

  const flushStream = (final = false) => {
    if (!streamBuf) return;
    if (streamProgress) {
      // Finalize streaming note inside progress.
      const active = progressRef.current;
      if (streamNoteKey && active) {
        const note = active.steps.find(
          (s): s is NoteStep => s.kind === "note" && s.key === streamNoteKey,
        );
        if (note) {
          note.text = streamBuf;
          note.status = "done";
        } else {
          pushNote(streamSpeaker, streamModel, streamBuf, streamKey, "done");
        }
      } else {
        pushNote(streamSpeaker, streamModel, streamBuf, streamKey, "done");
      }
    } else {
      progressRef.current = null;
      streamNoteKey = null;
      items.push({
        kind: "message",
        key: streamKey,
        speaker: streamSpeaker,
        model: streamModel,
        text: streamBuf,
        // Once the task is terminal there is no live generation: a trailing
        // streamed chunk with no non-partial finalizer must not stay "partial"
        // (otherwise the streaming badge/cursor sticks forever).
        partial: !final,
        // streamKey is `s-${ev.seq}` -- not stable for actions; omit seq while partial.
      });
    }
    streamBuf = "";
    streamNoteKey = null;
  };

  const ensureProgress = (speaker: string): ProgressItem => {
    if (progressRef.current) return progressRef.current;
    const prog: ProgressItem = {
      kind: "progress",
      key: `prog-${items.length}`,
      speaker: speaker || "agent",
      model: modelsBySpeaker.get(speaker),
      steps: [],
    };
    items.push(prog);
    progressRef.current = prog;
    return prog;
  };

  const pushNote = (
    speaker: string,
    model: string | undefined,
    text: string,
    key: string,
    status: NoteStep["status"],
  ) => {
    const prog = ensureProgress(hostSpeaker);
    // Coalesce consecutive partial updates onto the same note.
    const last = prog.steps[prog.steps.length - 1];
    if (
      last &&
      last.kind === "note" &&
      last.key === key &&
      last.speaker === speaker &&
      last.model === model
    ) {
      last.text = text;
      last.status = status;
      return;
    }
    if (
      last &&
      last.kind === "note" &&
      last.speaker === speaker &&
      last.model === model &&
      last.status === "running" &&
      status === "running"
    ) {
      last.text = text;
      last.key = key;
      return;
    }
    prog.steps.push({
      kind: "note",
      key,
      speaker,
      model,
      text,
      status,
    });
  };

  const upsertTool = (
    id: string,
    patch: Partial<ToolStep> & { name: string; speaker: string },
  ) => {
    const existing = toolById.get(id);
    if (existing) {
      Object.assign(existing, patch);
      return;
    }
    const item: ToolStep = {
      kind: "tool",
      key: `tool-${id}`,
      speaker: patch.speaker,
      model: patch.model,
      name: patch.name,
      summary: patch.summary ?? patch.name,
      status: patch.status ?? "running",
      input: patch.input,
      output: patch.output,
    };
    toolById.set(id, item);
    ensureProgress(hostSpeaker).steps.push(item);
  };

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const speaker = resolveSpeaker(p, hostSpeaker);
    const reportedModel = normalizeModel(p.model);
    if (reportedModel) modelsBySpeaker.set(speaker, reportedModel);
    const model = reportedModel ?? modelsBySpeaker.get(speaker);

    switch (ev.type) {
      case "message": {
        const partial = Boolean(p.partial);
        // Speaker is authoritative: resolveSpeaker already maps real/legacy
        // user turns to "user". A stamped worker/host echo carries role:"user"
        // on brief echoes, tool_results, and skill preambles but keeps its agent
        // speaker + task-only visibility — those must not be forced into the
        // main "user" column.
        const sp = speaker;
        let text =
          extractText(p.content) ||
          (typeof p.text === "string" ? p.text : "");
        // Never show local upload paths in the chat timeline.
        if (sp === "user" && text) {
          text = displayUserPrompt(text);
        }
        // Skip legacy expanded tool dumps from older kinagent builds.
        if (isLegacyToolDumpMessage(text)) {
          flushStream();
          streamNoteKey = null;
          const legacy = parseLegacyToolDump(
            text,
            sp,
            model,
            `legacy-${ev.seq}`,
          );
          if (legacy) {
            ensureProgress(hostSpeaker).steps.push(legacy);
            toolById.set(legacy.key, legacy);
          }
          break;
        }

        const asProgress = sp !== "user" && isProgressMessage(p, sp, text, hostSpeaker);

        if (partial) {
          // Switching between speakers / progress vs final message flushes.
          if (
            streamBuf &&
            (streamSpeaker !== sp || streamProgress !== asProgress)
          ) {
            flushStream();
          }
          if (asProgress) {
            if (!streamBuf) {
              // Opening a progress stream closes nothing else; stays in box.
              streamNoteKey = `note-s-${ev.seq}`;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamModel = model;
            streamKey = `s-${ev.seq}`;
            streamProgress = true;
            pushNote(
              sp,
              model,
              streamBuf,
              streamNoteKey ?? streamKey,
              "running",
            );
          } else {
            // User-facing stream closes the progress group.
            if (!streamBuf) {
              progressRef.current = null;
              streamNoteKey = null;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamModel = model;
            streamKey = `s-${ev.seq}`;
            streamProgress = false;
          }
        } else {
          // A non-partial user-facing message is the authoritative version of
          // the live-preview stream it closes. Drop the accumulated preview
          // buffer instead of flushing it as a separate partial item -- else we
          // duplicate the text and leave a dangling "partial" (stuck badge).
          const supersedesPreview =
            !!streamBuf && !streamProgress && !asProgress && streamSpeaker === sp;
          if (supersedesPreview) {
            streamBuf = "";
            progressRef.current = null;
          } else {
            flushStream();
          }
          streamNoteKey = null;
          if (!text.trim()) break;
          if (asProgress) {
            pushNote(sp, model, text, `note-${ev.seq}`, "done");
          } else {
            progressRef.current = null;
            items.push({
              kind: "message",
              key: `t-${ev.seq}`,
              speaker: sp,
              model: sp === "user" ? undefined : model,
              text,
              seq: ev.seq,
            });
          }
        }
        break;
      }
      case "tool_use": {
        // Worker tools are task-only; the host agent's own tools show in chat.
        if (!isUserFacingEvent(p, speaker, hostSpeaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const content = p.content as Record<string, unknown> | undefined;
        const name = String(
          content?.name ??
            p.name ??
            p.tool_name ??
            (p.item as { type?: string } | undefined)?.type ??
            "tool",
        );
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        const summary =
          typeof p.summary === "string" && p.summary
            ? p.summary
            : `${t("chat.progress.running")} · ${prettyToolName(name)}`;
        upsertTool(id, {
          name,
          speaker,
          model,
          summary,
          status: "running",
          input: p.input ?? content?.input ?? content,
        });
        break;
      }
      case "tool_result": {
        if (!isUserFacingEvent(p, speaker, hostSpeaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const name = String(p.name ?? p.tool_name ?? "tool");
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        const ok = p.ok !== false && p.status !== "error";
        const summary =
          typeof p.summary === "string" && p.summary
            ? p.summary
            : `${ok ? t("chat.progress.done") : t("chat.progress.failed")} · ${prettyToolName(name)}`;
        upsertTool(id, {
          name,
          speaker,
          model,
          summary,
          status: ok ? "done" : "error",
          input: p.input,
          output: typeof p.output === "string" ? p.output : undefined,
        });
        break;
      }
      case "error":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "error",
          key: `err-${ev.seq}`,
          message: String(p.message ?? "error"),
        });
        break;
      case "task_started":
        break;
      case "result": {
        // Orchestrator / adapter result closes the turn: finalize any trailing
        // streamed text so it is not left dangling as "partial".
        flushStream(true);
        streamNoteKey = null;
        // Mark any still-running steps as done so the card can collapse.
        const open = progressRef.current;
        if (open) {
          for (const s of open.steps) {
            if (s.status === "running") s.status = "done";
          }
        }
        progressRef.current = null;
        break;
      }
      case "approval_requested":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "meta",
          key: `ar-${ev.seq}`,
          label: t("chat.needsApproval"),
        });
        break;
      default:
        break;
    }
  }
  // When the task is terminal, a trailing streamed chunk is the final answer,
  // not live output -- finalize it so no stale streaming indicator remains.
  flushStream(finalized);
  return items;
}

/**
 * Merge consecutive progress groups + interstitial narration messages within
 * one agent turn into a single collapsible block. A long multi-phase run
 * (tools -> status text -> tools -> status text -> ...) otherwise stacks
 * several "done" cards that read as noise once finished; merging them lets
 * the whole run collapse to one summary line (still expandable to see every
 * step in order). The turn's actual final reply -- the trailing message
 * right before the next user turn / end of transcript -- is left untouched.
 */
export function mergeProcessRuns(items: ChatItem[]): ChatItem[] {
  type Mergeable = ProgressItem | Extract<ChatItem, { kind: "message" }>;
  const isMergeable = (item: ChatItem): item is Mergeable =>
    item.kind === "progress" ||
    (item.kind === "message" && item.speaker !== "user");

  const out: ChatItem[] = [];
  let buffer: Mergeable[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    // The trailing message of a run is the turn's real reply -- keep it
    // visible on its own; only merge what led up to it.
    let tail: Mergeable | null = null;
    let mergeable = buffer;
    const last = buffer[buffer.length - 1];
    if (last.kind === "message") {
      tail = last;
      mergeable = buffer.slice(0, -1);
    }
    const hasProgress = mergeable.some((part) => part.kind === "progress");
    if (!hasProgress || mergeable.length <= 1) {
      out.push(...mergeable);
    } else {
      out.push(mergeProgressParts(mergeable));
    }
    if (tail) out.push(tail);
    buffer = [];
  };

  for (const item of items) {
    if (isMergeable(item)) {
      buffer.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

function mergeProgressParts(
  parts: (ProgressItem | Extract<ChatItem, { kind: "message" }>)[],
): ProgressItem {
  const steps: ProgressStep[] = [];
  for (const part of parts) {
    if (part.kind === "progress") {
      steps.push(...part.steps);
    } else {
      steps.push({
        kind: "note",
        key: part.key,
        speaker: part.speaker,
        model: part.model,
        text: part.text,
        status: part.partial ? "running" : "done",
      });
    }
  }
  const anchor = parts.find((part) => part.kind === "progress") ?? parts[0];
  return {
    kind: "progress",
    key: `merge-${parts[0].key}`,
    speaker: anchor.speaker,
    model: anchor.model,
    steps,
  };
}

/**
 * Group flat chat items into turns:
 * - each user message is its own turn
 * - consecutive agent content (messages + progress + errors/meta) after a
 *   user message share one left avatar column
 */
export function groupIntoTurns(
  items: ChatItem[],
  hostSpeaker = "",
  hostModel?: string,
): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.speaker === "user") {
      turns.push({ kind: "user", item });
      continue;
    }
    if (item.kind === "error" || item.kind === "meta") {
      const last = turns[turns.length - 1];
      if (last?.kind === "agent") {
        last.items.push(item);
      } else {
        turns.push({ kind: "standalone", item });
      }
      continue;
    }
    // Agent message or progress.
    const last = turns[turns.length - 1];
    if (last?.kind === "agent") {
      last.items.push(item);
      last.model ??= chatItemModel(item);
      continue;
    }
    const speaker =
      item.kind === "message"
        ? item.speaker
        : item.speaker || hostSpeaker;
    turns.push({
      kind: "agent",
      speaker,
      model: chatItemModel(item) ?? hostModel,
      items: [item],
    });
  }
  return turns;
}

/** Old kinagent dumped tools as markdown messages: **bash**\n```...``` */
function isLegacyToolDumpMessage(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  return /^\*\*(bash|read_file|write_file|list_dir|glob)\*\*\s*\n```/m.test(
    text.trim(),
  );
}

function parseLegacyToolDump(
  text: string,
  speaker: string,
  model: string | undefined,
  key: string,
): ToolStep | null {
  const m = text
    .trim()
    .match(/^\*\*([a-z_]+)\*\*\s*\n```(?:\w*)\n?([\s\S]*?)```\s*$/i);
  if (!m) return null;
  const name = m[1];
  const output = m[2].trim();
  const failed = /^ERROR:/m.test(output) || output.includes("ERROR: ");
  const lines = countLines(output);
  return {
    kind: "tool",
    key,
    speaker,
    model,
    name,
    summary: `${failed ? t("chat.progress.failed") : t("chat.progress.done")} · ${prettyToolName(name)} · ${t("chat.progress.lines", { n: lines })}`,
    status: failed ? "error" : "done",
    output,
  };
}

function countLines(s: string): number {
  const text = s.replace(/\n+$/, "");
  if (!text) return 0;
  return text.split("\n").length;
}

// Speaker / visibility / progress classification live in eventMeta.ts
// (canonical contract + one legacy decode path).

function isUserFacingEvent(
  p: Record<string, unknown>,
  speaker: string,
  hostSpeaker = "",
): boolean {
  const meta = decodeCanonicalEventMeta(p, hostSpeaker);
  if (speaker) meta.speaker = speaker;
  if (meta.origin === "orchestrator" || meta.origin === "delegate") return true;
  if (meta.visibility && typeof meta.visibility.user === "boolean") {
    return meta.visibility.user;
  }
  return (
    meta.speaker === "user" ||
    meta.speaker === "kin" ||
    meta.speaker === hostSpeaker ||
    meta.speaker === "orchestrator"
  );
}

function isProgressMessage(
  p: Record<string, unknown>,
  speaker: string,
  text: string,
  hostSpeaker = "",
): boolean {
  const meta = decodeCanonicalEventMeta(p, hostSpeaker);
  // Prefer the resolved speaker already computed by the caller when present.
  if (speaker) meta.speaker = speaker;
  return isProgressMessageMeta(meta, text);
}

export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return model || undefined;
}

export function findSpeakerModel(
  events: TaskEvent[],
  speaker: string,
): string | undefined {
  let model: string | undefined;
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (resolveSpeaker(payload, speaker) !== speaker) continue;
    model = normalizeModel(payload.model) ?? model;
  }
  return model;
}

export function chatItemModel(item: ChatItem): string | undefined {
  if (item.kind === "message" || item.kind === "progress") {
    return item.model;
  }
  return undefined;
}

export function prettyToolName(name: string): string {
  switch (name) {
    case "bash":
      return "shell";
    case "read_file":
      return "read";
    case "write_file":
      return "write";
    case "list_dir":
      return "list";
    case "glob":
      return "glob";
    default:
      return name || "tool";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c && typeof c === "object" && "text" in c) {
        return String((c as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}
