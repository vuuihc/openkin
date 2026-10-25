import type { TaskEvent } from "../../api/client";
import { isCancelNoise } from "../../lib/friendlyError";
import { t } from "../../i18n";
import { decodeCanonicalEventMeta, isProgressMessageMeta, resolveSpeaker } from "./eventMeta";
import { displayUserPrompt } from "../../lib/attachments";
import type { PendingRef } from "../../lib/needsYou";

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
  /** Source event seq, when an event is behind this step. */
  seq?: number;
};

export type NoteStep = {
  kind: "note";
  key: string;
  speaker: string;
  model?: string;
  text: string;
  status: "running" | "done" | "error";
  /** Source event seq, when an event is behind this step. */
  seq?: number;
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
      phase?: string;
      /** Source event seq (for retry/fork). */
      seq?: number;
    }
  | ProgressItem
  | { kind: "error"; key: string; message: string }
  | { kind: "meta"; key: string; label: string; pending?: PendingRef };

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
      item: Extract<ChatItem, { kind: "error" | "meta" }>;
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
): ChatItem[] {
  const items: ChatItem[] = [];
  let streamBuf = "";
  // The seq the current streamed buffer started at: a note built from many
  // partial chunks has only this one event to be anchored to.
  let streamFromSeq = 0;
  let streamSpeaker = hostSpeaker;
  let streamModel = normalizeModel(hostModel);
  let streamKey = "stream";
  let streamProgress = false;
  let streamRole = "";
  let canceledRound = false;
  const modelsBySpeaker = new Map<string, string>();
  if (streamModel) modelsBySpeaker.set(hostSpeaker, streamModel);

  // Merge tool_use -> tool_result by tool_use_id so UI shows one step.
  const toolById = new Map<string, ToolStep>();
  // Active open progress group (tools + intermediate notes between user-facing msgs).
  // Box avoids TS CFA treating nested-function writes as unreachable.
  const progressRef: { current: ProgressItem | null } = { current: null };
  // Streaming note step key inside the progress box.
  let streamNoteKey: string | null = null;

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
      return;
    }
    const note: NoteStep = {
      kind: "note",
      key: `${PLAN_NOTE_PREFIX}${seq}`,
      speaker,
      model,
      text,
      status: "running",
      seq,
    };
    ensureProgress(hostSpeaker).steps.push(note);
    planNotes.set(speaker, note);
  };

  const pushNote = (
    speaker: string,
    model: string | undefined,
    text: string,
    key: string,
    status: NoteStep["status"],
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
    }
    prog.steps.push({
      kind: "note",
      key,
      speaker,
      model,
      text,
      status,
      seq,
    });
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
      return true;
    }
    return false;
  };

  const upsertTool = (id: string, patch: Partial<ToolStep> & { name: string; speaker: string }) => {
    const existing = toolById.get(id);
    if (existing) {
      // A step keeps the seq of the event that opened it. Letting the result
      // patch move it would drag the step — and the seq range of the turn it
      // sits in — into whatever turn the result arrived in, which for an
      // interrupted call is a different one.
      const { seq, ...rest } = patch;
      Object.assign(existing, rest);
      if (existing.seq === undefined) existing.seq = seq;
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
      seq: patch.seq,
    };
    toolById.set(id, item);
    ensureProgress(hostSpeaker).steps.push(item);
  };

  const settleRunningSteps = (status: ToolStep["status"]) => {
    for (const item of items) {
      if (item.kind !== "progress") continue;
      for (const step of item.steps) {
        if (step.status === "running") step.status = status;
      }
    }
  };

  const settlePartialMessages = () => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.speaker === "user") break;
      if (item.kind === "message" && item.partial) item.partial = false;
    }
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
        const role = typeof p.role === "string" ? p.role : "";
        // Speaker is authoritative: resolveSpeaker already maps real/legacy
        // user turns to "user". A stamped worker/host echo carries role:"user"
        // on brief echoes, tool_results, and skill preambles but keeps its agent
        // speaker + task-only visibility — those must not be forced into the
        // main "user" column.
        const sp = speaker;
        if (sp === "user") {
          canceledRound = p.interrupted === true || p.source === "interrupt";
        }
        let text = extractText(p.content) || (typeof p.text === "string" ? p.text : "");
        // Never show local upload paths in the chat timeline.
        if (sp === "user" && text) {
          text = displayUserPrompt(text);
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
        // Skip legacy expanded tool dumps from older kinagent builds.
        if (isLegacyToolDumpMessage(text)) {
          flushStream();
          streamNoteKey = null;
          const legacy = parseLegacyToolDump(text, sp, model, `legacy-${ev.seq}`);
          if (legacy) {
            legacy.seq = ev.seq;
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
            pushNote(sp, model, streamBuf, streamNoteKey ?? streamKey, "running", ev.seq);
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
          }
        } else {
          if (sp !== "user") {
            for (let index = items.length - 1; index >= 0; index -= 1) {
              const item = items[index];
              if (item.kind === "message" && item.speaker === "user") break;
              if (item.kind === "error" || item.kind === "meta") break;
              if (
                item.kind === "message" &&
                item.partial &&
                (messageKey ? item.key === messageKey : item.speaker === sp)
              ) {
                items.splice(index, 1);
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
          if (!text.trim()) break;
          if (asProgress) {
            if (!messageKey || !replaceProgressNote(messageKey, sp, model, text)) {
              pushNote(sp, model, text, messageKey || `note-${ev.seq}`, "done", ev.seq);
            }
          } else {
            progressRef.current = null;
            items.push({
              kind: "message",
              key: messageKey || `t-${ev.seq}`,
              speaker: sp,
              model: sp === "user" ? undefined : model,
              text,
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
          seq: ev.seq,
        });
        break;
      }
      case "tool_result": {
        if (!isUserFacingEvent(p, speaker, hostSpeaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
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
          ...(p.input !== undefined ? { input: p.input } : {}),
          output: typeof p.output === "string" ? p.output : undefined,
          seq: ev.seq,
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
        const label = [title, message].filter(Boolean).join(": ");
        if (!label) break;
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "meta",
          key: `notice-${ev.seq}`,
          label: `${noticeSeverityMark(severity)}${label}`,
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
        canceledRound = false;
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
  return items;
}

/**
 * Collapse each contiguous agent process run into one card. Explicit summaries
 * stay outside; phase-less history keeps its last complete assistant message
 * as the final answer.
 */
export function mergeProcessRuns(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let run: ProcessRunItem[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push(...mergeProcessRun(run));
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
  flushRun();
  return out;
}

function mergeProcessRun(run: ProcessRunItem[]): ChatItem[] {
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
    for (const item of segment) {
      if (item.kind === "progress") {
        steps.push(...item.steps);
      } else {
        steps.push({
          kind: "note",
          key: item.key,
          speaker: item.speaker,
          model: item.model,
          text: item.text,
          status: "done",
          seq: item.seq,
        });
      }
    }
    merged.push({
      kind: "progress",
      key: anchor.key,
      speaker: anchor.speaker,
      model: anchor.model,
      steps,
    });
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
 * turn carrying a settled (non-partial) message. A user turn that arrives while a
 * round is still open does not open another one. That is the case this exists for:
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
export function roundsOf(turns: Turn[]): Round[] {
  const rounds: Round[] = [];
  let open: Round | null = null;
  for (const turn of turns) {
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
    if (
      turn.kind === "agent" &&
      turn.items.some((item) => item.kind === "message" && !item.partial)
    ) {
      open = null;
    }
  }
  for (const round of rounds) {
    const from = round.turns.map((turn) => turn.fromSeq).filter((seq) => seq !== undefined);
    const to = round.turns.map((turn) => turn.toSeq).filter((seq) => seq !== undefined);
    if (from.length) round.fromSeq = Math.min(...from);
    if (to.length) round.toSeq = Math.max(...to);
  }
  return rounds;
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

export function summarizeProgressDetails(steps: ProgressStep[]): {
  toolCounts: string;
  latestNote: string;
  noteCount: number;
} {
  const counts = new Map<string, number>();
  let latestNote = "";
  let noteCount = 0;
  for (const step of steps) {
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
  totalTools: number;
} {
  const tools = steps.filter((step): step is ToolStep => step.kind === "tool");
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

function isUserFacingEvent(p: Record<string, unknown>, speaker: string, hostSpeaker = ""): boolean {
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
