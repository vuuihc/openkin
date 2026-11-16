/**
 * Where a routine's next run continues.
 *
 * A run is its own task and its own record in the feed. What a routine chooses
 * is the agent session a run starts from: by default the next run resumes the
 * newest run's session, so the agent keeps what earlier runs found; "fresh"
 * starts a new session in the routine's directory on every run.
 *
 * The daemon makes the same decision when it dispatches: it looks at the one
 * newest run and carries its native session id only when the agent, directory
 * and model still match, the id was minted on this machine, and the run has
 * stopped. This module is the console's reading of that exact rule: the form
 * explains what the next run will do, and the explanation cannot promise a
 * session the daemon would refuse (or hide one it would continue).
 */
import type { Routine, Task } from "../api/client";

export type ConversationMode = "continue" | "fresh";

/** The signed default: runs keep one session going unless asked otherwise. */
export const DEFAULT_CONVERSATION_MODE: ConversationMode = "continue";

/**
 * A routine's mode. Anything that is not exactly "fresh" is the default —
 * the same direction the daemon reads, including rows written before the
 * column existed.
 */
export function conversationModeOf(
  routine: Pick<Routine, "conversation_mode"> | null | undefined,
): ConversationMode {
  return routine?.conversation_mode === "fresh" ? "fresh" : "continue";
}

/** Statuses a session may be resumed from; a live run still owns its session. */
const FINISHED_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

/**
 * The run whose session the next run will resume, if any.
 *
 * Only the newest run of *this* routine decides, exactly as the daemon reads
 * one row: an older run is history, not continuity. The newest row must still
 * match the routine it would run for — same agent (a session does not transfer
 * between agents), same directory (agents look sessions up per project), same
 * model (some adapters ignore the model flag on resume) — must have stopped
 * (never attach a second process to a live session), and must carry a local,
 * non-empty ref. Anything else means the daemon starts a new session, so this
 * returns nothing rather than promising an older one.
 */
export function previousConversation(
  runs: Task[],
  routine:
    (Pick<Routine, "id"> & Partial<Pick<Routine, "agent" | "cwd" | "model">>) | null | undefined,
): Task | undefined {
  if (!routine?.id) return undefined;
  const newest = runs.find((run) => run.routine_id === routine.id);
  if (!newest) return undefined;
  if ((routine.agent ?? "") !== newest.agent) return undefined;
  if (routine.cwd !== undefined && (newest.cwd ?? "") !== routine.cwd) return undefined;
  if (routine.model !== undefined && routine.model.trim() !== (newest.model ?? "").trim()) {
    return undefined;
  }
  if (!FINISHED_RUN_STATUSES.has(newest.status)) return undefined;
  if (newest.session_ref_device_id) return undefined;
  const ref = newest.session_ref?.trim();
  return ref ? newest : undefined;
}

export type NextRunConversation = {
  /** The agent session the next run resumes; null means it starts a new one. */
  sessionRef: string | null;
  /** The directory the run starts in — the routine's project directory. */
  cwd: string;
};

/**
 * What the next run will start from, as the form explains it.
 *
 * Fresh mode never carries a ref, even when an earlier run has one: that is
 * the whole meaning of the choice. Continue mode carries the previous run's
 * trimmed ref, or none when there is nothing to resume yet (the first run, or
 * a run that never reported a session).
 */
export function nextRunConversation(
  mode: ConversationMode,
  previous: Pick<Task, "session_ref"> | null | undefined,
  cwd: string,
): NextRunConversation {
  if (mode === "fresh") return { sessionRef: null, cwd };
  const ref = previous?.session_ref?.trim();
  return { sessionRef: ref ? ref : null, cwd };
}
