import type { TaskEvent } from "../../api/client";
import { isCancelNoise } from "../../lib/friendlyError";
import { t } from "../../i18n";
import {
  decodeCanonicalEventMeta,
  isHostVoice,
  isProgressMessageMeta,
  resolveSpeaker,
} from "./eventMeta";
import { parseUserPrompt, type UserImage } from "../../lib/attachments";
import {
  recordedRoundEvidence,
  recordedRounds,
  roundEvidence,
  type RoundEvidence,
} from "../../lib/roundEvidence";
import type { PendingRef } from "../../lib/needsYou";

export type ToolStep = {
  kind: "tool";
  key: string;
  speaker: string;
  model?: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  /**
   * How long the call itself took: its result event's timestamp minus its use
   * event's. Absent while it runs, when either event carried no timestamp, or
   * when the two disagree about which came first.
   */
  durationMs?: number;
  input?: unknown;
  output?: string;
  /**
   * True when the agent said a subagent ran this call. ACP carries no parent
   * field; the claude adapter marks subagent work in `_meta`, and the projection
   * keeps the mark so the row can say whose call it was.
   */
  sidechain?: boolean;
  /** Key of the tool call that spawned this one, when the agent said. */
  parentKey?: string;
  /** Subagent calls, nested under the call that spawned them. */
  children?: ToolStep[];
  /** Source event seq, when an event is behind this step. */
  seq?: number;
};

/**
 * Where a note came from: the model's own thinking, the plan line, or
 * narration. Read from the event's role and canonical phase at the moment the
 * note is made -- never guessed from the words, which is why the last case is
 * a category rather than a heuristic.
 */
export type NoteSource = "reasoning" | "plan" | "note" | "subagent";

export type NoteStep = {
  kind: "note";
  key: string;
  speaker: string;
  model?: string;
  text: string;
  status: "running" | "done" | "error";
  source: NoteSource;
  /** Source event seq, when an event is behind this step. */
  seq?: number;
};

/**
 * Where a note came from, from the fields that decided it would be a note at
 * all (`isProgressMessageMeta`): a reasoning role is the model thinking to
 * itself, a plan phase is the plan line, a subagent mark is someone the main
 * agent delegated to, everything else is narration.
 */
export function noteSourceOf(meta: {
  role?: string;
  phase?: string;
  sidechain?: boolean;
}): NoteSource {
  if (meta.sidechain) return "subagent";
  if (meta.role === "reasoning") return "reasoning";
  if (meta.phase === "plan") return "plan";
  return "note";
}

/**
 * Whether a note's row has to say whose it is. The host's own column needs no
 * attribution -- and neither does a legacy row that names the host by another
 * of its names, which is the difference between a label and noise on a phone.
 */
export function noteNeedsAttribution(note: NoteStep, hostSpeaker: string): boolean {
  return !isHostVoice(note.speaker, hostSpeaker);
}

/**
 * The wording a note row carries. The source is the only thing that decides
 * it: thinking and narration read the same, and a step that was labelled by
 * guessing at the prose would be wrong exactly when it mattered.
 */
export function noteLabelKey(
  source: NoteSource,
): "chat.progress.thinking" | "chat.progress.plan" | "chat.progress.subagent" | null {
  if (source === "reasoning") return "chat.progress.thinking";
  if (source === "plan") return "chat.progress.plan";
  if (source === "subagent") return "chat.progress.subagent";
  // Narration is the agent's own voice in its own column; a word in front of it
  // would answer a question nobody asked.
  return null;
}

export type ProgressStep = ToolStep | NoteStep;

export type ProgressItem = {
  kind: "progress";
  key: string;
  /** Host speaker for alignment (usually kin). */
  speaker: string;
  model?: string;
  steps: ProgressStep[];
  /**
   * Wall time from the run's first stamped event to its last. Absent when
   * fewer than two stamped events contributed, which is why a settled card
   * draws no chip rather than "0s".
   */
  durationMs?: number;
  /**
   * A note of the run still in progress, drawn as body prose. Only a live
   * split sets it; every earlier run belongs to a finished round and folds
   * back into its card even while a later round runs.
   */
  prose?: true;
  /**
   * A tools-only card built from the run still in progress. The live split
   * draws notes after it, so it is not the last item and carries its own
   * liveness for the card's breathing state.
   */
  live?: true;
};

/**
 * The events that stamped a progress item, kept off the public shape: the card
 * reads `durationMs`, but a settled run is assembled from several groups, and
 * merging their durations needs the bounds and which events contributed them.
 */
const PROGRESS_SPAN = Symbol("kin.progressSpan");
type ProgressSpan = { first: number; last: number; seqs: Set<number> };
type ProgressItemWithSpan = ProgressItem & { [PROGRESS_SPAN]?: ProgressSpan };

/** Epoch milliseconds, with 0 and non-finite values read as "not stamped". */
function isStampedTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0;
}

function elapsedBetween(from: unknown, to: unknown): number | undefined {
  if (!isStampedTs(from) || !isStampedTs(to)) return undefined;
  const ms = to - from;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function progressSpan(item: ProgressItem): ProgressSpan | undefined {
  return (item as ProgressItemWithSpan)[PROGRESS_SPAN];
}

/** Fold one event's timestamp into an item's run. A seq counts once. */
function stampProgress(item: ProgressItem | null | undefined, ts: unknown, seq: number): void {
  if (!item || !isStampedTs(ts)) return;
  const holder = item as ProgressItemWithSpan;
  const span = holder[PROGRESS_SPAN] ?? { first: ts, last: ts, seqs: new Set<number>() };
  span.first = Math.min(span.first, ts);
  span.last = Math.max(span.last, ts);
  span.seqs.add(seq);
  holder[PROGRESS_SPAN] = span;
  item.durationMs = span.seqs.size >= 2 ? span.last - span.first : undefined;
}

/** Combine the spans of the groups a settled card is made from. */
function mergeProgressSpans(
  into: ProgressSpan | undefined,
  from: ProgressSpan | undefined,
): ProgressSpan | undefined {
  if (!from) return into;
  if (!into) return { first: from.first, last: from.last, seqs: new Set(from.seqs) };
  into.first = Math.min(into.first, from.first);
  into.last = Math.max(into.last, from.last);
  for (const seq of from.seqs) into.seqs.add(seq);
  return into;
}

/**
 * One context compaction: the adapter's summary of what came before, kept
 * behind a disclosure.
 *
 * It is deliberately not a `message`. A message is selectable, shareable,
 * findable, and eligible to be the final answer of a process run — none of
 * which is true of a handoff paragraph the agent wrote about its own memory.
 * One item per compaction, rewritten by its chunks until it settles.
 */
export type CompactionItem = {
  kind: "compaction";
  key: string;
  speaker: string;
  model?: string;
  /** The summary so far; complete once `partial` is false. */
  text: string;
  /** Still streaming: the row says it is compacting and draws no text. */
  partial?: boolean;
  /** Source event seq, so the item can anchor the turn it belongs to. */
  seq?: number;
};

export type ChatItem =
  | {
      kind: "message";
      key: string;
      speaker: string;
      model?: string;
      text: string;
      /** Pictures a user message carried, drawable above its body. */
      images?: UserImage[];
      partial?: boolean;
      phase?: string;
      /** Source event seq (for retry/fork). */
      seq?: number;
    }
  | ProgressItem
  | { kind: "error"; key: string; message: string }
  | {
      kind: "meta";
      key: string;
      label: string;
      pending?: PendingRef;
      /**
       * The note says a queued message was taken back. It is written mid-turn,
       * so the message it was withdrawn from may still be streaming — unlike
       * every other note, which is a line the agent wrote between messages.
       */
      withdrawal?: boolean;
    }
  | CompactionItem;

/** The pending card an event asks for, if it is one of the two asking kinds. */
export function pendingRefOf(ev: TaskEvent): PendingRef | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (ev.type === "approval_requested") {
    const id = p.approval_id;
    if (typeof id === "string" && id) return { kind: "approval", id };
    return null;
  }
  if (ev.type === "user_question_requested") {
    const id = p.question_id;
    if (typeof id === "string" && id) return { kind: "question", id };
    return null;
  }
  return null;
}

/**
 * Seq of the event each pending card was asked at, by card id.
 *
 * Read from the same place the projection reads it, so a card that was asked for
 * inside the loaded window can be told apart from one whose event has scrolled
 * out of it — the second has no place in the conversation to render at and has
 * to fall back to the end of the stream.
 */
export function pendingRefSeqs(events: TaskEvent[]): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const ev of events) {
    if (typeof ev.seq !== "number") continue;
    const ref = pendingRefOf(ev);
    if (ref) seqs.set(ref.id, ev.seq);
  }
  return seqs;
}

type ProcessRunItem = Extract<ChatItem, { kind: "message" | "progress" }>;

/**
 * The event seq range a turn was built from, when it has one.
 *
 * `toSeq` runs to the event before the next turn begins, so the events between
 * two turns were produced by the earlier one. Read it as "the events this turn's
 * visible content came from" rather than as an authority. A turn whose items all
 * came from seq-less events (a streamed preview) has no range; one whose first
 * item has no seq starts later than the turn really did; and the last turn has no
 * next turn to close it, so it ends at the newest event any of its items came
 * from — a step is anchored at the event that opened it, so a trailing result of
 * the newest call can sit outside it.
 *
 * Not every event lands in a turn. A turn with no range covers none of them, the
 * events before the first turn and after the last turn's newest event are in no
 * turn either, and a card built on a round is a slice of the transcript rather
 * than a partition of it.
 *
 * A round — what the user asked for and everything done about it — is a user turn
 * plus the agent turn that answers it, and its range is those turns' ranges
 * together (see `roundsOf`). That union is the boundary to read when asking "what
 * did this round change": work that the chat column never showed (a subagent's
 * file tools, a filtered event) produces no item at all, so it falls in the gap
 * and belongs to whichever turn the gap was closed onto rather than to the item
 * it is nearest.
 */
export type TurnSeqRange = {
  fromSeq?: number;
  toSeq?: number;
};

/** Visual grouping: one user bubble, or one agent column (single avatar). */
export type Turn = (
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
      item: Extract<ChatItem, { kind: "error" | "meta" | "compaction" }>;
    }
) &
  TurnSeqRange;

/**
 * The seq range a chat item came from: a message is its own seq, a progress box
 * spans the steps in it. Null when nothing behind the item carried a seq.
 */
export function chatItemSeqRange(item: ChatItem): { from: number; to: number } | null {
  if (item.kind === "message") {
    return typeof item.seq === "number" ? { from: item.seq, to: item.seq } : null;
  }
  if (item.kind === "progress") {
    let from = Infinity;
    let to = -Infinity;
    for (const step of item.steps) {
      if (typeof step.seq !== "number") continue;
      if (step.seq < from) from = step.seq;
      if (step.seq > to) to = step.seq;
    }
    return to >= from ? { from, to } : null;
  }
  if (item.kind === "compaction") {
    return typeof item.seq === "number" ? { from: item.seq, to: item.seq } : null;
  }
  return null;
}

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
  taskStatus?: string | null,
): ChatItem[] {
  const items: ChatItem[] = [];
  let streamBuf = "";
  // The compaction item each protocol compaction id opened. A chunk carries
  // its compaction id, and the update that settles the compaction carries the
  // same one; the id is the only thing that joins them.
  const compactionById = new Map<string, CompactionItem>();

  // The seq the current streamed buffer started at: a note built from many
  // partial chunks has only this one event to be anchored to.
  let streamFromSeq = 0;
  let streamSpeaker = hostSpeaker;
  let streamModel = normalizeModel(hostModel);
  let streamKey = "stream";
  let streamProgress = false;
  let streamRole = "";
  // Why the buffer being streamed is a note at all, carried to the note it
  // becomes: the reasoning chunks and the narration chunks arrive the same way.
  let streamSource: NoteSource = "note";
  // Pictures a streamed user preview carried. The buffer holds the normalised
  // text, which no longer names them, so they travel beside it until flush.
  let streamImages: UserImage[] | undefined;
  let canceledRound = false;
  // Which path canceled the round: the composer interrupt already closed it
  // with a line above the message that cut it, while a bare Stop sends no
  // message and leaves the transcript to say so at the result. The cancel
  // error itself cannot tell the two apart.
  let canceledByInterrupt = false;
  // A cancel-noise error on the conversation's own stream. Delegated workers
  // persist their events on the same log but stamped task-only; a step canceled
  // in the plan table is not the conversation stopping.
  let bareStopRound = false;
  // A turn the executor has started in the loaded window. Its events may not
  // have produced a visible item yet — an interrupt can land before the first
  // token — but the round exists, and an interrupt that cuts it should say so.
  let roundStarted = false;
  const modelsBySpeaker = new Map<string, string>();
  if (streamModel) modelsBySpeaker.set(hostSpeaker, streamModel);

  // Merge tool_use -> tool_result by tool_use_id so UI shows one step.
  const toolById = new Map<string, ToolStep>();
  // When each call opened, so its result can say how long it took.
  const toolStartedAt = new Map<string, number>();
  // The progress group a tool landed in, so a later result stamps that group's
  // run even after another group opened.
  const toolProgress = new WeakMap<ToolStep, ProgressItem>();
  // Active open progress group (tools + intermediate notes between user-facing msgs).
  // Box avoids TS CFA treating nested-function writes as unreachable.
  const progressRef: { current: ProgressItem | null } = { current: null };
  // The event being folded in, read by the step helpers below to stamp the
  // group's run without threading two more arguments through every caller.
  let currentTs = 0;
  let currentSeq = 0;
  // Streaming note step key inside the progress box.
  let streamNoteKey: string | null = null;

  /**
   * Whether the projection has an agent item above the event being folded in —
   * a round for an interrupt to have cut. A transcript window can start
   * mid-round, so "no user bubble above" is not the same as "no round": the
   * prompt may simply be older than the window, and the cut answer is still
   * there to close. A user bubble first means nothing was answered yet.
   */
  const hasRoundAbove = () => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.speaker === "user") return false;
      if (item.kind === "message" || item.kind === "progress" || item.kind === "compaction") {
        return true;
      }
    }
    return false;
  };

  const flushStream = (final = false, progressStatus: NoteStep["status"] = "done") => {
    if (!streamBuf) return;
    if (!streamBuf.trim()) {
      const active = progressRef.current;
      if (streamNoteKey && active) {
        active.steps = active.steps.filter((step) => step.key !== streamNoteKey);
        if (active.steps.length === 0) {
          const index = items.indexOf(active);
          if (index >= 0) items.splice(index, 1);
          progressRef.current = null;
        }
      }
      streamBuf = "";
      streamFromSeq = 0;
      streamNoteKey = null;
      streamProgress = false;
      streamRole = "";
      streamSource = "note";
      streamImages = undefined;
      return;
    }
    if (streamProgress) {
      // Finalize streaming note inside progress.
      const active = progressRef.current;
      if (streamNoteKey && active) {
        const note = active.steps.find(
          (s): s is NoteStep => s.kind === "note" && s.key === streamNoteKey,
        );
        if (note) {
          note.text = streamBuf;
          note.status = progressStatus;
          if (note.seq === undefined && streamFromSeq) note.seq = streamFromSeq;
        } else {
          pushNote(
            streamSpeaker,
            streamModel,
            streamBuf,
            streamKey,
            progressStatus,
            streamSource,
            streamFromSeq || undefined,
          );
        }
      } else {
        pushNote(
          streamSpeaker,
          streamModel,
          streamBuf,
          streamKey,
          progressStatus,
          streamSource,
          streamFromSeq || undefined,
        );
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
        images: streamImages,
        // Once the task is terminal there is no live generation: a trailing
        // streamed chunk with no non-partial finalizer must not stay "partial"
        // (otherwise the streaming badge/cursor sticks forever).
        partial: !final,
        // streamKey is `s-${ev.seq}` -- not stable for actions; omit seq while partial.
      });
    }
    streamBuf = "";
    streamFromSeq = 0;
    streamNoteKey = null;
    streamRole = "";
    streamSource = "note";
    streamImages = undefined;
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

  // The plan is one line per speaker per round, rewritten in place wherever it
  // sits — in the current box, or in one an answer has since closed. Holding the
  // step itself rather than searching for it is what makes that work: an agent
  // that plans, runs a tool, answers, then revises the plan would otherwise get a
  // second plan line in the next box (and two lines in one card once the boxes
  // merge). One line each, not one line total: a host and a worker it delegated
  // to are two agents with two plans, and neither should overwrite the other. A
  // new round starts new plans: the previous round's lines are history.
  const planNotes = new Map<string, NoteStep>();
  const upsertPlanNote = (
    speaker: string,
    model: string | undefined,
    text: string,
    seq: number,
  ) => {
    const existing = planNotes.get(speaker);
    if (existing) {
      existing.speaker = speaker;
      existing.model = model;
      existing.text = text;
      existing.status = "running";
      stampProgress(progressRef.current, currentTs, currentSeq);
      return;
    }
    const note: NoteStep = {
      kind: "note",
      key: `${PLAN_NOTE_PREFIX}${seq}`,
      speaker,
      model,
      text,
      status: "running",
      source: "plan",
      seq,
    };
    ensureProgress(hostSpeaker).steps.push(note);
    planNotes.set(speaker, note);
    stampProgress(progressRef.current, currentTs, currentSeq);
  };

  const pushNote = (
    speaker: string,
    model: string | undefined,
    text: string,
    key: string,
    status: NoteStep["status"],
    source: NoteSource,
    seq?: number,
  ) => {
    const prog = ensureProgress(hostSpeaker);
    const last = prog.steps[prog.steps.length - 1];
    // Coalesce consecutive partial updates onto the same note — never across a
    // plan line, in either direction. The plan is the agent's whole plan, and a
    // streamed chunk merged with it would replace it with a sentence and take its
    // key with it.
    const lastIsPlan = !!last && last.kind === "note" && last.key.startsWith(PLAN_NOTE_PREFIX);
    if (!key.startsWith(PLAN_NOTE_PREFIX) && !lastIsPlan) {
      if (
        last &&
        last.kind === "note" &&
        last.key === key &&
        last.speaker === speaker &&
        last.model === model
      ) {
        last.text = text;
        last.status = status;
        stampProgress(prog, currentTs, currentSeq);
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
        stampProgress(prog, currentTs, currentSeq);
        return;
      }
    }
    prog.steps.push({
      kind: "note",
      key,
      speaker,
      model,
      text,
      status,
      source,
      seq,
    });
    stampProgress(prog, currentTs, currentSeq);
  };

  const replaceProgressNote = (
    key: string,
    speaker: string,
    model: string | undefined,
    text: string,
  ): boolean => {
    for (const item of items) {
      if (item.kind !== "progress") continue;
      const note = item.steps.find(
        (step): step is NoteStep => step.kind === "note" && step.key === key,
      );
      if (!note) continue;
      note.speaker = speaker;
      note.model = model;
      note.text = text;
      note.status = "done";
      stampProgress(item, currentTs, currentSeq);
      return true;
    }
    return false;
  };

  const upsertTool = (
    id: string,
    patch: Partial<ToolStep> & { speaker: string; parentId?: string },
  ) => {
    const { parentId, ...fields } = patch;
    const existing = toolById.get(id);
    if (existing) {
      // A step keeps the seq of the event that opened it. Letting the result
      // patch move it would drag the step — and the seq range of the turn it
      // sits in — into whatever turn the result arrived in, which for an
      // interrupted call is a different one.
      const { seq, ...rest } = fields;
      Object.assign(existing, rest);
      if (existing.seq === undefined) existing.seq = seq;
      stampProgress(toolProgress.get(existing), currentTs, currentSeq);
      return;
    }
    const name = fields.name ?? "tool";
    const item: ToolStep = {
      kind: "tool",
      key: `tool-${id}`,
      speaker: fields.speaker,
      model: fields.model,
      name,
      summary: fields.summary ?? name,
      status: fields.status ?? "running",
      durationMs: fields.durationMs,
      input: fields.input,
      output: fields.output,
      sidechain: fields.sidechain,
      parentKey: parentId ? `tool-${parentId}` : undefined,
      seq: fields.seq,
    };
    toolById.set(id, item);
    // A subagent's call is part of the call that spawned it, so it opens under
    // that row rather than as another step of the main thread. The parent is
    // usually earlier in the stream; when it is not (a replay can start
    // mid-subagent), the row stays at the top level still marked as subagent —
    // a child is never promoted into looking like the main agent's own work.
    //
    // The parent id is agent output: a call that names itself is not a child,
    // and treating it as one would build a cycle the renderer would recurse on.
    const parent = parentId ? toolById.get(parentId) : undefined;
    if (parent && parent !== item) {
      (parent.children ??= []).push(item);
      // A subagent's call belongs to the group that holds the call it spawned.
      const owner = toolProgress.get(parent) ?? ensureProgress(hostSpeaker);
      toolProgress.set(item, owner);
      stampProgress(owner, currentTs, currentSeq);
      return;
    }
    const prog = ensureProgress(hostSpeaker);
    prog.steps.push(item);
    toolProgress.set(item, prog);
    stampProgress(prog, currentTs, currentSeq);
  };

  // One status for everything still open, at every depth: a turn that ends
  // while a subagent call is running leaves no row breathing forever.
  const settleSteps = (steps: ProgressStep[], status: ToolStep["status"]) => {
    for (const step of steps) {
      if (step.status === "running") step.status = status;
      if (step.kind === "tool" && step.children?.length) settleSteps(step.children, status);
    }
  };

  const settleRunningSteps = (status: ToolStep["status"]) => {
    for (const item of items) {
      if (item.kind !== "progress") continue;
      settleSteps(item.steps, status);
    }
  };

  const settlePartialMessages = () => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.speaker === "user") break;
      if (item.kind === "message" && item.partial) item.partial = false;
      // A running compaction settles with the turn too. Left partial it would
      // say "compacting" forever, which is a spinner over work that is done.
      if (item.kind === "compaction" && item.partial) item.partial = false;
    }
  };

  // The compaction item of the current turn, when one was already opened by a
  // chunk or by the adapter's "context compacted" notice.
  const compactionInTurn = (): CompactionItem | null => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.speaker === "user") return null;
      if (item.kind === "compaction") return item;
    }
    return null;
  };

  /**
   * Fold one compaction event into its item.
   *
   * Chunks aggregate, the final replaces the preview, and a settled item never
   * absorbs a later compaction: two compactions in one task are two lines, not
   * one growing one. A protocol event names its compaction, and the id is what
   * joins a chunk to the update that settles it even when no chunk arrived at
   * all. The item is deliberately outside `streamBuf` — the stream is the
   * agent's answer, and a summary that entered it would be drawn as one.
   */
  const upsertCompaction = (
    speaker: string,
    model: string | undefined,
    text: string,
    messageKey: string,
    final: boolean,
    seq: number,
    compactionId: string,
  ) => {
    const keyed = compactionId ? compactionById.get(compactionId) : undefined;
    // A late chunk of an already-settled summary adds nothing; only the final
    // update may restate a settled compaction.
    if (keyed && !keyed.partial && !final) return;
    // Without an id the turn's open item is the best hint there is. With one,
    // only an item no id owns may be adopted — otherwise a compaction settling
    // next to another one still running would write its summary into that
    // other compaction's line.
    let open = keyed;
    if (!open && !compactionId) open = compactionInTurn() ?? undefined;
    if (!open && compactionId) {
      const inTurn = compactionInTurn();
      const owned = inTurn ? [...compactionById.values()].includes(inTurn) : false;
      if (inTurn?.partial && !owned) open = inTurn;
    }
    if (open && (open.partial || keyed)) {
      if (final) {
        // The final carries the whole summary. An empty final is no reason to
        // throw away the text the chunks already delivered.
        if (text) open.text = text;
        open.partial = false;
      } else {
        open.text += text;
      }
      open.speaker = speaker;
      open.model = model ?? open.model;
      if (compactionId && !keyed) compactionById.set(compactionId, open);
      return;
    }
    const item: CompactionItem = {
      kind: "compaction",
      key: compactionId
        ? `compaction-${compactionId}`
        : messageKey
          ? `compaction-${messageKey}`
          : `compaction-${seq}`,
      speaker,
      model,
      text,
      partial: !final,
      seq,
    };
    items.push(item);
    if (compactionId) compactionById.set(compactionId, item);
  };

  for (const ev of events) {
    currentTs = ev.ts;
    currentSeq = ev.seq;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const speaker = resolveSpeaker(p, hostSpeaker);
    const reportedModel = normalizeModel(p.model);
    if (reportedModel) modelsBySpeaker.set(speaker, reportedModel);
    const model = reportedModel ?? modelsBySpeaker.get(speaker);

    switch (ev.type) {
      case "message": {
        const partial = Boolean(p.partial);
        const role = typeof p.role === "string" ? p.role : "";
        const phase = typeof p.phase === "string" ? p.phase : undefined;
        // A chunk someone else in the turn wrote: the agent said this text came
        // from a subagent, so its label says so even though it travels on the
        // same stream as the main answer.
        const sidechain = p.sidechain === true;
        // Speaker is authoritative: resolveSpeaker already maps real/legacy
        // user turns to "user". A stamped worker/host echo carries role:"user"
        // on brief echoes, tool_results, and skill preambles but keeps its agent
        // speaker + task-only visibility — those must not be forced into the
        // main "user" column.
        const sp = speaker;
        // Read before this prompt changes anything: an interrupt ends the round
        // that was running when it arrived, and its line goes above this message.
        const interruptsRound =
          sp === "user" && (p.interrupted === true || p.source === "interrupt");
        const roundWasStarted = roundStarted;
        if (sp === "user") {
          canceledRound = interruptsRound;
          // Only the interrupt's own line closes this round. A plain follow-up
          // leaves canceledByInterrupt alone: the cancel error still belongs to
          // the round the interrupt cut, so it must not read as a bare Stop.
          if (interruptsRound) canceledByInterrupt = true;
        }
        // `task_started` and `result` own the round lifecycle. A prompt that
        // lands while a round is running is a follow-up (queued or steering),
        // not the start of the next one: clearing `roundStarted` here made a
        // later interrupt forget the round it cut whenever a queued follow-up
        // sat between the two, because that follow-up's own bubble also stops
        // `hasRoundAbove` at the nearest user message.
        let text = extractText(p.content) || (typeof p.text === "string" ? p.text : "");
        // Never show local upload paths in the chat timeline. The same parse
        // keeps the pictures, which the normalised text names but cannot draw.
        let images: UserImage[] | undefined;
        if (sp === "user" && text) {
          const parsed = parseUserPrompt(text);
          text = parsed.text;
          if (parsed.images.length > 0) images = parsed.images;
        }
        // A prompt starts a round, and a round has plans of its own: the lines
        // the previous round carried are part of what happened, not something a
        // new plan updates in place. Only a message with words in it starts one
        // — an empty user event renders nothing, so letting it clear the plans
        // would split the plan it never began. It sits above the legacy-dump
        // divert below because a round starts when the prompt arrives, whatever
        // the prompt happens to look like.
        if (sp === "user" && text.trim()) {
          planNotes.clear();
        }
        const messageID = typeof p.message_id === "string" ? p.message_id : "";
        const blockIndex =
          typeof p.index === "number" || typeof p.index === "string" ? String(p.index) : "";
        const messageKey =
          messageID && blockIndex ? `message-${sp}-${role}-${messageID}-${blockIndex}` : "";
        // A context compaction is not the agent's answer: the adapter writes a
        // handoff paragraph about what it forgot, and drawing that paragraph as
        // a reply is the bug. Its chunks rewrite one item instead of entering
        // the answer stream, so nothing downstream can select, share or find it
        // as prose.
        if (phase === "compaction") {
          flushStream();
          streamNoteKey = null;
          progressRef.current = null;
          const compactionId = typeof p.compaction_id === "string" ? p.compaction_id : "";
          upsertCompaction(sp, model, text, messageKey, !partial, ev.seq, compactionId);
          break;
        }
        // Skip legacy expanded tool dumps from older kinagent builds.
        if (isLegacyToolDumpMessage(text)) {
          flushStream();
          streamNoteKey = null;
          const legacy = parseLegacyToolDump(text, sp, model, `legacy-${ev.seq}`);
          if (legacy) {
            legacy.seq = ev.seq;
            const prog = ensureProgress(hostSpeaker);
            prog.steps.push(legacy);
            toolProgress.set(legacy, prog);
            stampProgress(prog, currentTs, currentSeq);
            toolById.set(legacy.key, legacy);
          }
          break;
        }

        const asProgress = sp !== "user" && isProgressMessage(p, sp, text, hostSpeaker);

        if (partial) {
          // Switching between speakers / progress vs final message flushes.
          if (
            streamBuf &&
            (streamSpeaker !== sp ||
              streamProgress !== asProgress ||
              (!!messageKey && streamKey !== messageKey))
          ) {
            flushStream();
          }
          if (asProgress) {
            if (!streamBuf) {
              // Opening a progress stream closes nothing else; stays in box.
              streamNoteKey = messageKey || `note-s-${ev.seq}`;
              streamFromSeq = ev.seq;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamModel = model;
            streamKey = messageKey || `s-${ev.seq}`;
            streamProgress = true;
            streamRole = role;
            streamSource = noteSourceOf({ role, phase, sidechain });
            pushNote(
              sp,
              model,
              streamBuf,
              streamNoteKey ?? streamKey,
              "running",
              streamSource,
              ev.seq,
            );
          } else {
            // User-facing stream closes the progress group.
            if (!streamBuf) {
              progressRef.current = null;
              streamNoteKey = null;
              streamFromSeq = ev.seq;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamModel = model;
            streamKey = messageKey || `s-${ev.seq}`;
            streamProgress = false;
            streamRole = role;
            streamSource = noteSourceOf({ role, phase, sidechain });
            streamImages = images;
          }
        } else {
          if (sp !== "user") {
            // The scan removes the previews this message supersedes. An error
            // ends it: that is a round that died, and its previews are not being
            // replaced by anything.
            //
            // A note ends it too, unless this message carries an identity. Text
            // before a note is a message of its own when there is no id to match
            // on — that is the split the adapter notices rely on — but a
            // withdrawal is written while a turn is running, and only droid
            // stamps the identity a match needs: for every other adapter the
            // note would leave the first half of this message behind as its own
            // bubble. So exactly one withdrawal note is transparent, and only
            // for the single preview behind it: the note says nothing about text
            // from an earlier message that never got a final version, and
            // removing that would delete the only copy of it.
            let crossedWithdrawal = false;
            for (let index = items.length - 1; index >= 0; index -= 1) {
              const item = items[index];
              if (item.kind === "message" && item.speaker === "user") break;
              if (item.kind === "error") break;
              if (item.kind === "meta" && !messageKey) {
                if (!item.withdrawal || crossedWithdrawal) break;
                crossedWithdrawal = true;
                continue;
              }
              if (
                item.kind === "message" &&
                item.partial &&
                (messageKey ? item.key === messageKey : item.speaker === sp)
              ) {
                items.splice(index, 1);
                // With an identity there may be more than one preview to match;
                // without one, the nearest preview is the only thing the note
                // could have been standing in front of.
                if (!messageKey) break;
              }
            }
          }
          // A non-partial user-facing message is the authoritative version of
          // the live-preview stream it closes. Drop the accumulated preview
          // buffer instead of flushing it as a separate partial item -- else we
          // duplicate the text and leave a dangling "partial" (stuck badge).
          const supersedesPreview =
            !!streamBuf &&
            (messageKey ? streamKey === messageKey : streamSpeaker === sp && streamRole === role);
          if (supersedesPreview) {
            const active = progressRef.current;
            if (
              streamProgress &&
              streamNoteKey &&
              active &&
              !(asProgress && messageKey === streamNoteKey)
            ) {
              active.steps = active.steps.filter((step) => step.key !== streamNoteKey);
            }
            streamBuf = "";
            streamFromSeq = 0;
            if (!asProgress) progressRef.current = null;
          } else {
            flushStream();
          }
          streamNoteKey = null;
          // A round cut short by an interrupt leaves no reply and no trace of
          // its own: the answer just stops. The toast that said so is gone on
          // reload, so the transcript says it too — one line closing the round
          // that was cut, above the message that cut it. Placed after the stream
          // flush so the cut half of the answer stays above the line, and keyed
          // so a repeated copy of the same message does not add a second.
          if (interruptsRound) {
            if (roundWasStarted || hasRoundAbove()) {
              const markKey = `interrupt-${messageKey || ev.seq}`;
              if (!items.some((item) => item.kind === "meta" && item.key === markKey)) {
                items.push({ kind: "meta", key: markKey, label: t("chat.interruptedNote") });
              }
            }
          }
          if (!text.trim()) break;
          if (asProgress) {
            if (!messageKey || !replaceProgressNote(messageKey, sp, model, text)) {
              pushNote(
                sp,
                model,
                text,
                messageKey || `note-${ev.seq}`,
                "done",
                noteSourceOf({ role, phase, sidechain }),
                ev.seq,
              );
            }
          } else {
            progressRef.current = null;
            items.push({
              kind: "message",
              key: messageKey || `t-${ev.seq}`,
              speaker: sp,
              model: sp === "user" ? undefined : model,
              text,
              images,
              phase: typeof p.phase === "string" ? p.phase : undefined,
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
        const hinted =
          content?.name ?? p.name ?? p.tool_name ?? (p.item as { type?: string } | undefined)?.type;
        // A status-only update names no tool. That is not a statement that the
        // step is called "tool": the row keeps the name it was opened with,
        // which is the whole reason the adapter leaves the field out.
        const nameHint = typeof hinted === "string" && hinted.trim() ? hinted : undefined;
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        // The first sighting of a call is when it started; a later status-only
        // update must not move the start it was given.
        if (isStampedTs(ev.ts) && !toolStartedAt.has(id)) toolStartedAt.set(id, ev.ts);
        const parentId = parentToolUseIdOf(p);
        const explicitSummary = typeof p.summary === "string" && p.summary ? p.summary : undefined;
        const patch: Partial<ToolStep> & { speaker: string; parentId?: string } = {
          speaker,
          model,
          status: "running",
          input: p.input ?? content?.input ?? content,
          seq: ev.seq,
          sidechain: p.sidechain === true || !!parentId,
          parentId,
        };
        if (nameHint) {
          patch.name = nameHint;
          if (explicitSummary) {
            patch.summary = explicitSummary;
          } else if (!toolById.has(id)) {
            patch.summary = `${t("chat.progress.running")} · ${prettyToolName(nameHint)}`;
          }
        } else if (explicitSummary) {
          patch.summary = explicitSummary;
        } else if (!toolById.has(id)) {
          // First sight of an unnamed step still needs a line to draw.
          patch.summary = `${t("chat.progress.running")} · ${prettyToolName("tool")}`;
        }
        upsertTool(id, patch);
        break;
      }
      case "tool_result": {
        if (!isUserFacingEvent(p, speaker, hostSpeaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        const durationMs = elapsedBetween(toolStartedAt.get(id), ev.ts);
        // The result need not repeat the mark the call carried, and a result
        // that repeats nothing must not erase it: only add what is here.
        const parentId = parentToolUseIdOf(p);
        const name = String(p.name ?? p.tool_name ?? toolById.get(id)?.name ?? "tool");
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
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(p.input !== undefined ? { input: p.input } : {}),
          output: typeof p.output === "string" ? p.output : undefined,
          seq: ev.seq,
          ...(p.sidechain === true || parentId ? { sidechain: true } : {}),
          ...(parentId ? { parentId } : {}),
        });
        break;
      }
      case "notice": {
        // A status line from whatever is driving the turn: an adapter saying it
        // could not reload the agent's context, that the chosen permission mode
        // does not apply, or how full the context window is. It is not part of
        // the answer, so it closes the streamed text before it — the reader sees
        // it in the order it happened.
        const title = typeof p.title === "string" ? p.title.trim() : "";
        const message = typeof p.message === "string" ? p.message.trim() : "";
        const severity = typeof p.severity === "string" ? p.severity : "";
        // A withdrawal note is written by the daemon, in one language; wording it
        // for the reader is the console's job, so the code names the note and the
        // UI says it. Everything else here is the agent's own words.
        const withdrawal = p.code === "prompt_withdrawn";
        // A compaction the adapter reported through the protocol. Its status is
        // the truth, never the title: a failed handoff and a finished one share
        // the words "context compacted", and only one of them produced a
        // summary. Running stays one line; completed settles with the whole
        // summary even when no chunk arrived; failed or cancelled is not a
        // compaction at all and says so in the reader's language.
        if (p.code === "context_compacted") {
          const compactionId = typeof p.compaction_id === "string" ? p.compaction_id : "";
          const status = typeof p.status === "string" ? p.status : "";
          flushStream();
          streamNoteKey = null;
          progressRef.current = null;
          if (status === "failed" || status === "cancelled") {
            // The running line this replaces is gone: it promised a summary
            // that will never come, and a spinner over failed work is a lie.
            const running = compactionId ? compactionById.get(compactionId) : compactionInTurn();
            if (running && running.partial) {
              const index = items.indexOf(running);
              if (index >= 0) items.splice(index, 1);
              if (compactionId) compactionById.delete(compactionId);
            }
            const label = t(
              status === "failed" ? "chat.compaction.failed" : "chat.compaction.cancelled",
            );
            items.push({
              kind: "meta",
              key: `compaction-${compactionId || ev.seq}`,
              label: `${noticeSeverityMark(severity)}${message ? `${label}: ${message}` : label}`,
            });
            break;
          }
          const completed = status === "completed";
          upsertCompaction(
            speaker,
            model,
            completed ? message : "",
            "",
            completed,
            ev.seq,
            compactionId,
          );
          break;
        }
        // The same compaction the summary chunks describe. Two hints for one
        // compaction is the bug; when this turn already has its item, the
        // notice adds nothing. When no summary has arrived yet, the notice is
        // what opens the running line — never a body sentence of its own. This
        // is the fallback for transcripts an adapter wrote before it sent a
        // code; a protocol notice never reaches it.
        if (title.toLowerCase() === "context compacted") {
          flushStream();
          streamNoteKey = null;
          progressRef.current = null;
          if (!compactionInTurn()) {
            items.push({
              kind: "compaction",
              key: `compaction-notice-${ev.seq}`,
              speaker,
              model,
              text: "",
              partial: true,
              seq: ev.seq,
            });
          }
          break;
        }
        const label = withdrawal
          ? t("chat.withdrawnNote")
          : [title, message].filter(Boolean).join(": ");
        if (!label) break;
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "meta",
          key: `notice-${ev.seq}`,
          label: `${noticeSeverityMark(severity)}${label}`,
          withdrawal,
        });
        break;
      }
      case "plan": {
        // The agent's own plan, replaced whole on every update. It belongs to the
        // process box, not to the answer, and successive updates rewrite one line:
        // a plan is revised as it is worked through, and a stack of drafts is not a
        // transcript. The markers carry each entry's status; the words are the
        // agent's own.
        //
        // The stream is settled first, like every other step-producing case: a plan
        // written in the middle of an open note would be swallowed by the next chunk
        // of it (the note coalescer rewrites whatever running note is last).
        flushStream();
        streamNoteKey = null;
        const entries = Array.isArray(p.entries) ? p.entries : [];
        const parts: string[] = [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const row = entry as Record<string, unknown>;
          const content = typeof row.content === "string" ? row.content.trim() : "";
          if (!content) continue;
          const status = typeof row.status === "string" ? row.status : "";
          parts.push(`${planMarker(status)} ${content}`);
        }
        if (!parts.length) {
          // An empty plan is a plan: the agent withdrew it. Leaving the last one
          // on screen would describe work that is no longer planned.
          const note = planNotes.get(speaker);
          if (note) {
            note.text = t("chat.progress.planCleared");
            note.status = "done";
          }
          break;
        }
        upsertPlanNote(speaker, model, parts.join(" · "), ev.seq);
        break;
      }
      case "error": {
        // Steer/interrupt aborts emit "canceled" — not a real failure for the UI.
        const errMsg = String(p.message ?? "error");
        if (isCancelNoise(errMsg)) {
          canceledRound = true;
          // A worker's cancel is process chatter on the parent log; only the
          // conversation's own cancel can close the round this transcript shows.
          if (isUserFacingEvent(p, speaker, hostSpeaker)) bareStopRound = true;
          break;
        }
        // A deliberate Stop discards the messages queued behind the canceled
        // round, and the store reports the count on the error channel because
        // that is the channel it has (internal/store/pending_prompts.go). It is
        // not a failure: the report is the only on-screen account of where
        // those messages went, so it reads as the same quiet, counted note as
        // the stop line — in the reader's language, naming the conversation
        // rather than the daemon's task. Match the template, not the whole
        // sentence: the count changes with what was queued.
        const discardCount = typeof p.count === "number" ? p.count : null;
        if (discardCount !== null && /queued prompt\(s\) discarded/i.test(errMsg)) {
          flushStream(true, "error");
          streamNoteKey = null;
          settlePartialMessages();
          settleRunningSteps("error");
          progressRef.current = null;
          items.push({
            kind: "meta",
            key: `discard-${ev.seq}`,
            label:
              discardCount === 1
                ? t("chat.discardedPrompt")
                : t("chat.discardedPrompts", { count: discardCount }),
          });
          break;
        }
        flushStream(true, "error");
        streamNoteKey = null;
        settlePartialMessages();
        settleRunningSteps("error");
        progressRef.current = null;
        items.push({
          kind: "error",
          key: `err-${ev.seq}`,
          message: errMsg,
        });
        break;
      }
      case "task_started":
        roundStarted = true;
        // A new round has its own cancel story; an earlier interrupt no longer
        // owns the cancel error this one may end with.
        canceledByInterrupt = false;
        bareStopRound = false;
        break;
      case "result": {
        // Orchestrator / adapter result closes the turn: finalize any trailing
        // streamed text so it is not left dangling as "partial".
        const terminalStatus = p.is_error === true && !canceledRound ? "error" : "done";
        flushStream(true, terminalStatus);
        streamNoteKey = null;
        settlePartialMessages();
        // A summary may already have closed progressRef, so settle every
        // projected process group rather than only the currently open one.
        settleRunningSteps(terminalStatus);
        progressRef.current = null;
        // A bare Stop ends the round here with no reply and no message of its
        // own: the toast said so once, and a reload left an answer that simply
        // stops. Close the round in the transcript, after the text the stop cut,
        // keyed so a repeated copy of the result adds no second line. Only a
        // failed result of a round this window saw start is claimed: a
        // mid-round window has process rows above the result but no evidence of
        // a round to close, and a cancel the agent recovered from (a steer) is
        // not a stop.
        if (
          bareStopRound &&
          !canceledByInterrupt &&
          p.is_error === true &&
          roundStarted &&
          isUserFacingEvent(p, speaker, hostSpeaker)
        ) {
          const stopKey = `stopped-${ev.seq}`;
          if (!items.some((item) => item.kind === "meta" && item.key === stopKey)) {
            items.push({ kind: "meta", key: stopKey, label: t("chat.stoppedNote") });
          }
        }
        canceledRound = false;
        canceledByInterrupt = false;
        bareStopRound = false;
        roundStarted = false;
        break;
      }
      case "approval_requested":
      case "user_question_requested": {
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        // The card goes where the asking happened. Two requests never share an
        // anchor — each event has its own seq — so a card renders exactly once.
        const pending = pendingRefOf(ev);
        items.push({
          kind: "meta",
          key: `${ev.type === "approval_requested" ? "ar" : "uq"}-${ev.seq}`,
          label: t(ev.type === "approval_requested" ? "chat.needsApproval" : "question.cardTitle"),
          ...(pending ? { pending } : {}),
        });
        break;
      }
      case "limit_hit":
        // Rendered as LimitCard in TaskDetailPage, not as transcript text.
        break;
      case "route_decision":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        {
          const team = typeof p.team === "string" ? p.team : "";
          const phase = typeof p.phase === "string" ? p.phase : "";
          const prov = typeof p.provider === "string" ? p.provider : "";
          const mdl = typeof p.model === "string" ? p.model : "";
          items.push({
            kind: "meta",
            key: `rd-${ev.seq}`,
            label: `Routing: ${phase} → ${prov}/${mdl}${team ? ` (team: ${team})` : ""}`,
          });
        }
        break;
      case "route_fallback":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        {
          const prov = typeof p.provider === "string" ? p.provider : "";
          const mdl = typeof p.model === "string" ? p.model : "";
          const from = p.fallback_from as Record<string, string> | undefined;
          const fromStr = from ? `${from.provider}/${from.model}` : "unknown";
          items.push({
            kind: "meta",
            key: `rf-${ev.seq}`,
            label: `Fallback: ${fromStr} → ${prov}/${mdl}`,
          });
        }
        break;
      default:
        // Workspace lifecycle events (workspace_provisioning, workspace_ready, etc.)
        if (typeof ev.type === "string" && ev.type.startsWith("workspace_")) {
          const wsId = typeof p.workspace_id === "string" ? p.workspace_id : "";
          const genNum =
            typeof p.generation === "number"
              ? p.generation
              : typeof p.generation === "string"
                ? parseInt(p.generation, 10)
                : undefined;
          const label = workspaceEventLabel(ev.type, wsId, genNum);
          if (label) {
            flushStream();
            streamNoteKey = null;
            progressRef.current = null;
            items.push({
              kind: "meta",
              key: `ws-${ev.seq}`,
              label,
            });
          }
        }
        break;
    }
  }
  // When the task is terminal, a trailing streamed chunk is the final answer,
  // not live output -- finalize it so no stale streaming indicator remains.
  flushStream(finalized);
  if (finalized) {
    // A task that ended without a `result` (a crash, an import) must not leave
    // a compaction saying it is still compacting.
    for (const item of items) {
      if (item.kind === "compaction" && item.partial) item.partial = false;
    }
  }
  // Not every adapter records the cancel a Stop caused: the default
  // claude-code agent and the fake CLI persist neither the cancel error nor an
  // is_error result, because the engine drops events once cancelTask deletes
  // the run. The task's own terminal status is the durable fact, so when it
  // says canceled and nothing else closed the round this window watched start,
  // the transcript closes it. An interrupt already put its own line above the
  // message that cut the round, and a worker's cancel leaves `roundStarted`
  // false, so neither is claimed twice.
  if (finalized && taskStatus === "canceled" && roundStarted && !canceledByInterrupt) {
    // The events stop mid-round because the adapter never wrote its ending:
    // settle what the cut left open so nothing still reads as streaming.
    settlePartialMessages();
    settleRunningSteps("done");
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    const stopKey = `stopped-${lastSeq}`;
    if (!items.some((item) => item.kind === "meta" && item.key === stopKey)) {
      items.push({ kind: "meta", key: stopKey, label: t("chat.stoppedNote") });
    }
  }
  return items;
}

/**
 * Collapse each contiguous agent process run into one card. Explicit summaries
 * stay outside; phase-less history keeps its last complete assistant message
 * as the final answer.
 *
 * A turn that is still running is read differently: its notes are body text the
 * reader is following, not a summary of work already done. `splitNotes` gives
 * each note its own item and keeps only the tools in the card, which is how the
 * live transcript shows thinking and narration in the conversation column while
 * a finished turn still folds into one row.
 *
 * Only the trailing run can be the live one: every run before it ended at a
 * message, so those rounds are already finished and keep their cards. Splitting
 * them again would re-open work the reader has already seen collapsed.
 */
export function mergeProcessRuns(items: ChatItem[], splitNotes = false): ChatItem[] {
  const out: ChatItem[] = [];
  let run: ProcessRunItem[] = [];
  const flushRun = (live = false) => {
    if (run.length === 0) return;
    out.push(...mergeProcessRun(run, splitNotes && live));
    run = [];
  };
  for (const item of items) {
    if (item.kind === "progress" || (item.kind === "message" && item.speaker !== "user")) {
      run.push(item);
    } else {
      flushRun();
      out.push(item);
    }
  }
  // The run still in progress is the one the reader is watching.
  flushRun(true);
  return out;
}

function mergeProcessRun(run: ProcessRunItem[], splitNotes: boolean): ChatItem[] {
  if (!run.some((item) => item.kind === "progress")) return run;

  let finalMessageIdx = -1;
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const item = run[index];
    if (item.kind === "message" && item.phase === "summary") {
      finalMessageIdx = index;
      break;
    }
  }
  if (finalMessageIdx < 0) {
    for (let index = run.length - 1; index >= 0; index -= 1) {
      const item = run[index];
      if (
        item.kind === "message" &&
        !item.partial &&
        item.phase !== "plan" &&
        item.phase !== "progress"
      ) {
        finalMessageIdx = index;
        break;
      }
    }
  }

  return splitNotes
    ? splitProcessRun(run, finalMessageIdx)
    : collapseProcessRun(run, finalMessageIdx);
}

/**
 * A live run, in reading order: contiguous tool calls across adjacent groups
 * are one card, every note is its own body item, and the final answer stays
 * outside exactly as the settled collapse selects it.
 */
function splitProcessRun(run: ProcessRunItem[], finalMessageIdx: number): ChatItem[] {
  const out: ChatItem[] = [];
  let tools: ProgressItem | null = null;
  const flushTools = () => {
    if (tools && tools.steps.length > 0) out.push(tools);
    tools = null;
  };

  for (let index = 0; index < run.length; index += 1) {
    const item = run[index];
    if (item.kind === "message") {
      const foldIntoProcess =
        !item.partial && item.phase !== "summary" && index !== finalMessageIdx;
      if (!foldIntoProcess) {
        flushTools();
        out.push(item);
        continue;
      }
      flushTools();
      out.push(noteItemOf(item.key, item.speaker, item.model, noteStepOfMessage(item)));
      continue;
    }
    for (const step of item.steps) {
      if (step.kind === "tool") {
        if (!tools) {
          tools = {
            kind: "progress",
            key: step.key,
            speaker: item.speaker,
            model: item.model,
            steps: [],
            live: true,
          };
        }
        tools.steps.push(step);
        continue;
      }
      flushTools();
      // The step's own key is what find points at, and it survives stream
      // updates: the item a note is drawn in must not outlive it.
      out.push(noteItemOf(step.key, step.speaker || item.speaker, step.model ?? item.model, step));
    }
  }
  flushTools();
  return out;
}

function noteItemOf(
  key: string,
  speaker: string,
  model: string | undefined,
  step: NoteStep,
): ProgressItem {
  return { kind: "progress", key, speaker, model, steps: [step], prose: true };
}

/** A message folded into a process item says the same thing a note says. */
function noteStepOfMessage(item: Extract<ChatItem, { kind: "message" }>): NoteStep {
  return {
    kind: "note",
    key: item.key,
    speaker: item.speaker,
    model: item.model,
    text: item.text,
    status: "done",
    // A message only lands here when it was not a progress message to begin
    // with, which leaves the plan phase as the one source a still-visible
    // message can carry into the item.
    source: noteSourceOf({ phase: item.phase }),
    seq: item.seq,
  };
}

/** The settled run: every step of every group in one card. */
function collapseProcessRun(run: ProcessRunItem[], finalMessageIdx: number): ChatItem[] {
  const merged: ChatItem[] = [];
  let segment: ProcessRunItem[] = [];
  const flushSegment = () => {
    if (segment.length === 0) return;
    const anchor = segment.find((item): item is ProgressItem => item.kind === "progress");
    if (!anchor) {
      merged.push(...segment);
      segment = [];
      return;
    }
    const steps: ProgressStep[] = [];
    let span: ProgressSpan | undefined;
    for (const item of segment) {
      if (item.kind === "progress") {
        steps.push(...item.steps);
        span = mergeProgressSpans(span, progressSpan(item));
      } else {
        steps.push(noteStepOfMessage(item));
      }
    }
    const mergedItem: ProgressItem = {
      kind: "progress",
      key: anchor.key,
      speaker: anchor.speaker,
      model: anchor.model,
      steps,
    };
    if (span) {
      (mergedItem as ProgressItemWithSpan)[PROGRESS_SPAN] = span;
      mergedItem.durationMs = span.seqs.size >= 2 ? span.last - span.first : undefined;
    }
    merged.push(mergedItem);
    segment = [];
  };

  for (let index = 0; index < run.length; index += 1) {
    const item = run[index];
    if (item.kind === "progress") {
      segment.push(item);
      continue;
    }
    const foldIntoProcess = !item.partial && item.phase !== "summary" && index !== finalMessageIdx;
    if (foldIntoProcess) {
      segment.push(item);
      continue;
    }
    flushSegment();
    merged.push(item);
  }
  flushSegment();
  return merged;
}

/**
 * Group flat chat items into turns:
 * - each user message is its own turn
 * - consecutive agent content (messages + progress + errors/meta) after a
 *   user message share one left avatar column
 */
export function groupIntoTurns(items: ChatItem[], hostSpeaker = "", hostModel?: string): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.speaker === "user") {
      turns.push({ kind: "user", item });
      continue;
    }
    // A compaction is a marker in time, not something the agent said: it joins
    // the column it happened inside so the order survives, and starts a
    // marker-only turn when it is the first thing after an ask. It never opens
    // an avatar column of its own.
    if (item.kind === "error" || item.kind === "meta" || item.kind === "compaction") {
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
    const speaker = item.kind === "message" ? item.speaker : item.speaker || hostSpeaker;
    turns.push({
      kind: "agent",
      speaker,
      model: chatItemModel(item) ?? hostModel,
      items: [item],
    });
  }
  assignTurnSeqRanges(turns, items);
  return turns;
}

/**
 * Fill in each turn's seq range from the items it holds, then close it at the
 * event before the next turn starts.
 *
 * The closing pass is why this cannot be a field on the item: a turn's last
 * item is rarely its last event (the result of a tool, the end of a stream), and
 * those events are the turn's too. Taking them from the next turn's start is the
 * only boundary the projection actually knows.
 */
function assignTurnSeqRanges(turns: Turn[], items: ChatItem[]): void {
  const ranges = new Map<ChatItem, { from: number; to: number }>();
  for (const item of items) {
    const range = chatItemSeqRange(item);
    if (range) ranges.set(item, range);
  }
  const own = (turn: Turn): { from: number; to: number } | null => {
    const held =
      turn.kind === "standalone" ? [turn.item] : turn.kind === "user" ? [turn.item] : turn.items;
    let from = Infinity;
    let to = -Infinity;
    for (const item of held) {
      const range = ranges.get(item);
      if (!range) continue;
      if (range.from < from) from = range.from;
      if (range.to > to) to = range.to;
    }
    return to >= from ? { from, to } : null;
  };
  // Two passes, because closing a turn needs the *next* turn's start: assigning
  // and closing in one pass would read fromSeq before it was written and quietly
  // never close anything.
  for (const turn of turns) {
    const range = own(turn);
    if (!range) continue;
    turn.fromSeq = range.from;
    turn.toSeq = range.to;
  }
  for (let index = 0; index < turns.length; index += 1) {
    const to = turns[index].toSeq;
    if (to === undefined) continue;
    // The next turn that knows its own start is what closes this one; a
    // standalone error or a streamed preview carries no seq, and letting one of
    // those close the turn would end it at the wrong event.
    for (let next = index + 1; next < turns.length; next += 1) {
      const nextFrom = turns[next].fromSeq;
      if (nextFrom === undefined) continue;
      if (nextFrom - 1 > to) turns[index].toSeq = nextFrom - 1;
      break;
    }
  }
}

/** One round: the ask, everything done about it, and the slice of stream behind it. */
export type Round = {
  /** The user turn the round is an answer to. */
  user: Extract<Turn, { kind: "user" }>;
  /** The round read as turns: the ask, and what followed until it was answered. */
  turns: Turn[];
  fromSeq?: number;
  toSeq?: number;
};

/**
 * Split turns into rounds: what the user asked for, and everything done about it.
 *
 * A round opens at a user turn and closes at the agent turn that answers it — a
 * turn carrying a settled (non-partial) message, or one that ends on an error
 * with nothing picking the work back up before the next ask. A user turn that
 * arrives while a round is still open does not open another one. That is the case
 * this exists for:
 * the same ask can reach the transcript twice, as a streamed copy that was flushed
 * into its own item and the final copy that carries the seq, and an ACP agent
 * echoes the prompt it was given at all — late enough that the work it prompted
 * has already started, which puts an agent turn *between* the two copies. The
 * projection cannot tell either apart from a second question, and the work in
 * flight is the work the open round asked for, so the open round keeps it rather
 * than the new user turn taking it: narrowing a round to whichever user turn
 * carries a seq is how "what did this round change" comes back empty while the
 * file it changed sits at the seq before it.
 *
 * A round may open with turns that belong to no round before it and close with
 * the stream still going, so its range comes from the turns that have one and is
 * absent when none of them do. It is a slice, not a partition: see
 * `TurnSeqRange`.
 */
/** The items a turn speaks through: an agent column's own, a standalone turn's one. */
function spokenItems(turn: Turn): ChatItem[] | null {
  if (turn.kind === "agent") return turn.items;
  if (turn.kind === "standalone") return [turn.item];
  return null;
}

/**
 * The last item a turn actually said. Trailing markers — an approval notice, a
 * question waiting on the user — are not content, and a turn is judged by what
 * it ended on rather than by the marker that followed it.
 */
function lastContentItem(items: ChatItem[]): ChatItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    // A compaction is a marker about the context, not an answer: a turn that
    // died on an error did not come back to life by compacting.
    if (item.kind !== "meta" && item.kind !== "compaction") return item;
  }
  return undefined;
}

/**
 * Whether the work behind this turn stopped with an error, which ends the round
 * just as much as an answer does.
 *
 * An error on its own is not an ending: a retry that failed and then answered
 * leaves one in the middle of the work, and the round keeps that work — the turn
 * it sits in either ends on the answer or is followed by one. So this asks both
 * questions: the turn ends on the error, and nothing picks the work back up
 * before the next ask. A run that died leaves its ask unanswered, and whatever
 * the user asks next is a new round — reading it as the same one is how the
 * changes of the next ask get reported under the ask that failed.
 */
function stoppedAtError(turns: Turn[], index: number): boolean {
  const items = spokenItems(turns[index]);
  if (!items || lastContentItem(items)?.kind !== "error") return false;
  for (let next = index + 1; next < turns.length; next += 1) {
    const turn = turns[next];
    if (turn.kind === "user") return true;
    if (
      turn.kind === "agent" &&
      turn.items.some((item) => item.kind === "message" && !item.partial)
    ) {
      return false;
    }
  }
  // Nothing follows at all: the run ended on the failure, so the next ask opens
  // its own round.
  return true;
}

export function roundsOf(turns: Turn[]): Round[] {
  const rounds: Round[] = [];
  let open: Round | null = null;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.kind === "user") {
      if (open) {
        open.turns.push(turn);
      } else {
        open = { user: turn, turns: [turn] };
        rounds.push(open);
      }
      continue;
    }
    // An agent turn with no round open — the tail of a round that started before
    // the loaded window — belongs to no round rather than to an invented one.
    if (!open) continue;
    open.turns.push(turn);
    const answered =
      turn.kind === "agent" && turn.items.some((item) => item.kind === "message" && !item.partial);
    if (answered || stoppedAtError(turns, index)) open = null;
  }
  for (const round of rounds) {
    const from = round.turns.map((turn) => turn.fromSeq).filter((seq) => seq !== undefined);
    const to = round.turns.map((turn) => turn.toSeq).filter((seq) => seq !== undefined);
    if (from.length) round.fromSeq = Math.min(...from);
    if (to.length) round.toSeq = Math.max(...to);
  }
  return rounds;
}

/**
 * What each round changed, keyed by the turn that round ends on.
 *
 * The key is the placement: a round's range is a slice of the stream, so the
 * card that reports it belongs under the turn carrying the last event of that
 * slice — which is where the reader has just finished reading about the work.
 * A round is routinely more than one ask (see `roundsOf`), and when it is, the
 * card reports the whole of it: the ask that never got its own answer and the
 * one that arrived on top of it are the same piece of work, so splitting their
 * files between two cards would be inventing a boundary the transcript does not
 * have.
 *
 * Absent means no card: a round nothing carried a seq for, and a round that
 * changed nothing through a file tool, are both nothing to report.
 *
 * A round the daemon recorded wins over the payload reconstruction, including
 * when the record is empty. The record compares two snapshots of the disk, so
 * it knows about a `sed` the payload cannot see and about a write the next turn
 * reverted; falling back to the payloads would put files on screen that do not
 * differ. Payloads are the fallback for everything the daemon could not record:
 * shared checkouts, tasks that ran elsewhere, sessions older than the record.
 */
export function roundEvidenceByTurn(events: TaskEvent[], turns: Turn[]): Map<Turn, RoundEvidence> {
  const byTurn = new Map<Turn, RoundEvidence>();
  const recorded = recordedRounds(events);
  for (const round of roundsOf(turns)) {
    const lastTurn = round.turns[round.turns.length - 1];
    const record = round.fromSeq === undefined ? undefined : recorded.get(round.fromSeq);
    if (record) {
      const { fromSeq, toSeq } = round;
      const slice =
        fromSeq === undefined || toSeq === undefined
          ? []
          : events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
      const evidence = recordedRoundEvidence(record, slice);
      if (evidence) byTurn.set(lastTurn, evidence);
      continue;
    }
    const evidence = roundEvidence(events, round);
    if (evidence) byTurn.set(lastTurn, evidence);
  }
  return byTurn;
}

export function shouldShowGenericThinking(items: ChatItem[], loading: boolean): boolean {
  if (!loading) return false;
  let roundStart = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.speaker === "user") {
      roundStart = index + 1;
      break;
    }
  }
  return !items.slice(roundStart).some((item) => {
    if (item.kind === "message") return item.text.trim().length > 0;
    // A compaction that is still streaming is the cue. The generic dots over
    // it would be a second "working" hint for the same moment; once it settles,
    // an otherwise empty round is the agent thinking again, and the dots are
    // the truth.
    if (item.kind === "compaction") return item.partial === true;
    if (item.kind !== "progress") return false;
    return item.steps.some((step) => step.kind === "tool" || step.text.trim().length > 0);
  });
}

export function isProgressCardRunning(
  items: ChatItem[],
  item: ProgressItem,
  loading: boolean,
): boolean {
  if (!loading) return false;
  const lastItem = items[items.length - 1];
  return lastItem?.kind === "progress" && lastItem.key === item.key;
}

/** One row of the progress box, in reading order. */
export type ProgressRow = {
  step: ProgressStep;
  /** 0 for a step of the main thread, 1 for a subagent's call, and so on. */
  depth: number;
  /** The top-level step number; 0 for a nested row, which carries no number. */
  index: number;
};

/**
 * The box's rows: every top-level step in order, each followed by the calls a
 * subagent made underneath it. Nesting is a display decision made here so the
 * rows, the counts, and the card's status all read the same tree.
 */
export function progressRows(steps: ProgressStep[]): ProgressRow[] {
  const rows: ProgressRow[] = [];
  let index = 0;
  const walk = (list: ProgressStep[], depth: number) => {
    for (const step of list) {
      if (depth === 0) index += 1;
      rows.push({ step, depth, index: depth === 0 ? index : 0 });
      if (step.kind === "tool" && step.children?.length) {
        walk(step.children, depth + 1);
      }
    }
  };
  walk(steps, 0);
  return rows;
}

function flattenProgressSteps(steps: ProgressStep[]): ProgressStep[] {
  return progressRows(steps).map((row) => row.step);
}

export function summarizeProgressDetails(steps: ProgressStep[]): {
  toolCounts: string;
  latestNote: string;
  noteCount: number;
} {
  const counts = new Map<string, number>();
  let latestNote = "";
  let noteCount = 0;
  for (const step of flattenProgressSteps(steps)) {
    if (step.kind === "tool") {
      const name = prettyToolName(step.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      continue;
    }
    const text = step.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    latestNote = text;
    noteCount += 1;
  }
  return {
    toolCounts: [...counts.entries()].map(([name, count]) => `${name} × ${count}`).join(" · "),
    latestNote,
    noteCount,
  };
}

export function summarizeProgressStatus(
  steps: ProgressStep[],
  running: boolean,
): {
  state: "running" | "done" | "failed" | "partial_failed";
  doneTools: number;
  failedTools: number;
  /**
   * Failed steps when the card holds no tools at all: the notes are then what
   * the state was derived from, so the failure sentence has to count them too.
   * Always zero on a card with tools, where the state ignores note statuses.
   */
  failedNotes: number;
  totalTools: number;
} {
  const tools = flattenProgressSteps(steps).filter(
    (step): step is ToolStep => step.kind === "tool",
  );
  const doneTools = tools.filter((step) => step.status === "done").length;
  const failedTools = tools.filter((step) => step.status === "error").length;
  const statusSteps = tools.length > 0 ? tools : steps;
  const done = statusSteps.filter((step) => step.status === "done").length;
  const failed = statusSteps.filter((step) => step.status === "error").length;
  const state = running
    ? "running"
    : failed === 0
      ? "done"
      : done === 0
        ? "failed"
        : "partial_failed";
  return {
    state,
    doneTools,
    failedTools,
    // `statusSteps` is the notes exactly when there are no tools.
    failedNotes: tools.length > 0 ? 0 : failed,
    totalTools: tools.length,
  };
}

/** One glyph per ACP plan entry status; unknown statuses read as "not started". */
function planMarker(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "▸";
    default:
      return "·";
  }
}

/**
 * Note keys for an agent's plan start with this. The seq suffix keeps two
 * process boxes merged into one card from colliding on a key; the prefix is how
 * a later plan update finds the line to rewrite.
 */
const PLAN_NOTE_PREFIX = "plan-";

/** A notice's own severity is worth one glyph: "the disk is full" is not a status line. */
function noticeSeverityMark(severity: string): string {
  switch (severity) {
    case "error":
      return "⚠ ";
    case "warning":
      return "! ";
    default:
      return "";
  }
}

/** Old kinagent dumped tools as markdown messages: **bash**\n```...``` */
function isLegacyToolDumpMessage(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  return /^\*\*(bash|read_file|write_file|edit_file|list_dir|glob)\*\*\s*\n```/m.test(text.trim());
}

function parseLegacyToolDump(
  text: string,
  speaker: string,
  model: string | undefined,
  key: string,
): ToolStep | null {
  const m = text.trim().match(/^\*\*([a-z_]+)\*\*\s*\n```(?:\w*)\n?([\s\S]*?)```\s*$/i);
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

/**
 * The tool call a streamed call belongs to, when the agent said. ACP has no
 * parent field; the claude adapter lifts `_meta.claudeCode.parentToolUseId`
 * onto the payload, and that is the only source this reads.
 */
function parentToolUseIdOf(p: Record<string, unknown>): string | undefined {
  const raw = p.parent_tool_use_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function isUserFacingEvent(p: Record<string, unknown>, speaker: string, hostSpeaker = ""): boolean {
  const meta = decodeCanonicalEventMeta(p, hostSpeaker);
  if (speaker) meta.speaker = speaker;
  if (meta.origin === "orchestrator" || meta.origin === "delegate") return true;
  if (meta.visibility && typeof meta.visibility.user === "boolean") {
    return meta.visibility.user;
  }
  return meta.speaker === "user" || isHostVoice(meta.speaker, hostSpeaker);
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

export function findSpeakerModel(events: TaskEvent[], speaker: string): string | undefined {
  let model: string | undefined;
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (resolveSpeaker(payload, speaker) !== speaker) continue;
    model = normalizeModel(payload.model) ?? model;
  }
  return model;
}

export function chatItemModel(item: ChatItem): string | undefined {
  if (item.kind === "message" || item.kind === "progress" || item.kind === "compaction") {
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
    case "edit_file":
      return "edit";
    case "list_dir":
      return "list";
    case "glob":
      return "glob";
    default:
      return name || "tool";
  }
}

/**
 * Map a workspace lifecycle event type to a human-readable label.
 * Uses the i18n layer so labels follow the active locale.
 */
function workspaceEventLabel(eventType: string, workspaceId: string, generation?: number): string {
  const genSuffix = generation !== undefined && !isNaN(generation) ? ` #${generation}` : "";
  const idSuffix = workspaceId ? ` (${workspaceId.slice(0, 8)})` : "";

  switch (eventType) {
    case "workspace_provisioning":
      return `${t("workspace.generation.eventProvisioning")}${genSuffix}${idSuffix}`;
    case "workspace_ready":
      return `${t("workspace.generation.eventReady")}${genSuffix}${idSuffix}`;
    case "workspace_active":
      return `${t("workspace.generation.eventActive")}${genSuffix}${idSuffix}`;
    case "workspace_finalizing":
      return `${t("workspace.generation.eventFinalizing")}${genSuffix}${idSuffix}`;
    case "workspace_integrated":
      return `${t("workspace.generation.eventIntegrated")}${genSuffix}${idSuffix}`;
    case "workspace_released":
      return `${t("workspace.generation.eventReleased")}${genSuffix}${idSuffix}`;
    case "workspace_merge_blocked":
      return `${t("workspace.generation.eventMergeBlocked")}${genSuffix}${idSuffix}`;
    case "workspace_finalize_blocked":
      return `${t("workspace.generation.eventFinalizeBlocked")}${genSuffix}${idSuffix}`;
    case "workspace_orphaned":
      return `${t("workspace.generation.eventOrphaned")}${genSuffix}${idSuffix}`;
    case "workspace_legacy_pending":
      return `${t("workspace.generation.eventLegacyPending")}${genSuffix}${idSuffix}`;
    default:
      return "";
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
