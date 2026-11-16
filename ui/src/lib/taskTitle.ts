/**
 * What to call a session, in one place.
 *
 * The expression this replaces was written out at each surface that needed it
 * (the sidebar's rows, the palette's task rows, the shell's delete prompt), and
 * the tab strip made a fourth. `displayUserPrompt` is already where the
 * "prompt is only attachments" case is handled, so what is left here is the
 * field order and the trim — small, but the kind of small that drifts.
 *
 * Deliberately no fallback to the task id: a surface that wants one (the shell's
 * delete prompt does) can add it, and a surface that does not would rather show
 * its own generic name than a UUID.
 */

import type { Task } from "../api/client";
import { displayUserPrompt } from "./attachments";

export function taskDisplayTitle(task: Pick<Task, "title" | "prompt"> | null | undefined): string {
  if (!task) return "";
  return (task.title || displayUserPrompt(task.prompt || "")).trim();
}
