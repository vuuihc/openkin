/**
 * KIN-MOBILE-002 R4b — the activity spine's decision table.
 *
 * Every agent turn carries a 3pt left edge whose colour says what the round
 * is doing (DESIGN.md "活动脊"), so a long transcript can be scanned by the
 * spine alone. The first matching row wins:
 *
 * | # | Turn                        | Context            | Tone     |
 * |---|-----------------------------|--------------------|----------|
 * | 1 | the person's or standalone  | —                  | none     |
 * | 2 | agent holding an error item or stop note | —       | failed   |
 * | 3 | the live agent turn         | `awaitingApproval` | approval |
 * | 4 | the live agent turn         | `running`          | running  |
 * | 5 | the live agent turn         | `failed`           | failed   |
 * | 6 | every other agent turn      | —                  | done     |
 *
 * A standalone turn never carries a spine: an error or stop note is a line
 * about the transcript, not a piece of work. `failed` is the newest round's
 * outcome, computed by `roundEndedUncleanly`. Approval outranks running: a
 * round blocked on the person is orange, not blue.
 */

import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";

export type SpineTone = "running" | "done" | "failed" | "approval";

export type SpineContext = {
  /** Index of the live agent turn, or -1 when a newer turn is waiting for it. */
  lastAgentIndex: number;
  /** The thread's own running flag (`ThreadState.running`). */
  running: boolean;
  /** Whether the newest round ended in a failure or a stop. */
  failed: boolean;
  /** Whether this task has an approval or question still pending. */
  awaitingApproval: boolean;
  /** The catalogue sentence a stop leaves inside its agent turn. */
  stoppedNote: string;
};

/** The tone one turn's spine paints, or null when it carries no spine. */
export function spineFor(
  turn: Turn,
  index: number,
  ctx: SpineContext,
): SpineTone | null {
  if (turn.kind !== "agent") return null;
  if (
    turn.items.some(
      (item) =>
        item.kind === "error" ||
        (item.kind === "meta" && item.label === ctx.stoppedNote),
    )
  ) {
    return "failed";
  }
  if (index === ctx.lastAgentIndex) {
    if (ctx.awaitingApproval) return "approval";
    if (ctx.running) return "running";
    if (ctx.failed) return "failed";
  }
  return "done";
}

/**
 * Index of the agent turn the live flags may paint, or -1 when the transcript
 * has moved past it. A trailing person/standalone turn is a newer round that
 * has no agent work yet; repainting the previous answer as running would say
 * the old round came back to life.
 */
export function lastAgentTurnIndex(turns: Turn[]): number {
  const last = turns.length - 1;
  return turns[last]?.kind === "agent" ? last : -1;
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
