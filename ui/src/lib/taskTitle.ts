/**
 * What to call a session, in one place.
 *
 * The expression this replaces was written out at each surface that needed it
 * (the sidebar's rows, the palette's task rows, the shell's delete prompt), and
 * the tab strip made a fourth. `displayUserPrompt` is already where the
 * "prompt is only attachments" case is handled, so what is left here is the
 * field order and the trim — small, but the kind of small that drifts.
 *
 * A local rename (`taskTitles.ts`) is this browser's name for the conversation
 * and wins over everything: a title that reads like the first line of a prompt
 * was the reason a rename existed in the first place. It is the first term
 * here so every surface that draws a name spells the precedence the same way.
 *
 * Deliberately no fallback to the task id: a surface that wants one (the shell's
 * delete prompt does) can add it, and a surface that does not would rather show
 * its own generic name than a UUID.
 */

import type { Task } from "../api/client";
import { displayUserPrompt } from "./attachments";
import { getLocalTaskTitles, localTaskTitle } from "./taskTitles";

/**
 * The one name expression. Callers that hold a subscribed copy of the map pass
 * it, so their repaint is React's; a one-shot call (a delete prompt, a tab
 * label, the project cover's row builder) reads the store at the moment it is
 * asked and gets whatever rename is current then.
 *
 * `id` is optional because not every task-shaped value has one (a fixture, a
 * row being previewed); without it there is no rename to look up.
 */
export function taskDisplayTitle(
  task: (Partial<Pick<Task, "id">> & Pick<Task, "title" | "prompt">) | null | undefined,
  localTitles: Record<string, string> = getLocalTaskTitles(),
): string {
  if (!task) return "";
  const renamed = localTaskTitle(task.id, localTitles);
  // A title of spaces is no title: trim it before it can beat the prompt, the
  // way the project cover's rows have always read it.
  return (renamed || (task.title ?? "").trim() || displayUserPrompt(task.prompt || "")).trim();
}
