/**
 * KIN-MOBILE-002 R4b — the activity spine's decision table.
 *
 * Every agent turn carries a 3pt left edge whose colour says what the round
 * is doing (DESIGN.md "活动脊"), so a long transcript can be scanned by the
 * spine alone. The helper is DOM-free: the view maps a tone to a palette
 * pigment and draws the border; this module owns only which tone a turn has.
 *
 * The decision table, in order — the first matching row wins:
 *
 * | # | Turn                        | Context                    | Tone     |
 * |---|-----------------------------|----------------------------|----------|
 * | 1 | the person's or standalone  | —                          | none     |
 * | 2 | agent holding an error item | —                          | failed   |
 * | 3 | the last agent turn         | `awaitingApproval`         | approval |
 * | 4 | the last agent turn         | `running`                  | running  |
 * | 5 | the last agent turn         | `failed`                   | failed   |
 * | 6 | every other agent turn      | —                          | done     |
 *
 * A standalone turn never carries a spine: an error or stop note is a line
 * about the transcript, not a piece of work. `failed` is the newest round's
 * outcome — the caller computes it with `roundEndedUncleanly`, which reads
 * the stop note and error items the projection already placed. Rows 3 and 4
 * are ordered so a round waiting on an approval is orange even if the task
 * still reports running while it waits.
 */

import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";

export type SpineTone = "running" | "done" | "failed" | "approval";

export type SpineContext = {
  /** Index of the newest agent turn, or -1 when the thread has none. */
  lastAgentIndex: number;
  /** The thread's own running flag (`ThreadState.running`). */
  running: boolean;
  /** Whether the newest round ended in a failure or a stop. */
  failed: boolean;
  /** Whether this task has an approval or question still pending. */
  awaitingApproval: boolean;
};

/** The tone one turn's spine paints, or null when it carries no spine. */
export function spineFor(
  turn: Turn,
  index: number,
  ctx: SpineContext,
): SpineTone | null {
  if (turn.kind !== "agent") return null;
  if (turn.items.some((item) => item.kind === "error")) return "failed";
  if (index === ctx.lastAgentIndex) {
    if (ctx.awaitingApproval) return "approval";
    if (ctx.running) return "running";
    if (ctx.failed) return "failed";
  }
  return "done";
}

/** Index of the newest agent turn, or -1 when the thread has none. */
export function lastAgentTurnIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]!.kind === "agent") return i;
  }
  return -1;
}

/**
 * Whether the transcript's newest round ended in a failure or a stop.
 *
 * Only a round whose agent turn is the transcript's last turn qualifies: a
 * standalone stop note belongs to a newer ask with no agent work of its own,
 * so it must not repaint the older answer red. The stop note is matched by
 * the catalogue sentence the projection wrote onto the meta item
 * (`chat.stoppedNote`), because that label is the only durable signal a stop
 * leaves in a loaded transcript.
 */
export function roundEndedUncleanly(
  turns: Turn[],
  stoppedNote: string,
): boolean {
  const last = turns[turns.length - 1];
  if (last === undefined || last.kind !== "agent") return false;
  return last.items.some(
    (item) =>
      item.kind === "error" ||
      (item.kind === "meta" && item.label === stoppedNote),
  );
}
