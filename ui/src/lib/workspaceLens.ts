/**
 * Which of the workspace panel's two lenses is in front.
 *
 * `files` and `changes` are one panel seen two ways, not two panels: the tree
 * and the changes list share the selected file, the reader, and the fetched
 * diff, and the only thing that differs is which list does the navigating (see
 * the P3 plan §2.5, which settled this by measurement). What they do not share
 * is the answer to "which one should be in front", and that answer has three
 * inputs: whether the session has changes at all, which workspace generation is
 * being looked at, and what the person last asked for.
 *
 * Keeping the third one inside the panel is what this module undoes. A panel
 * private `useState` made the lens unaddressable: nothing outside the panel
 * could ask for a lens, so an entry point that meant "show me the changes" had
 * to open the panel and hope the default happened to agree. The value now lives
 * with the panel registry's `shownPanel` (see `lib/panels`) and is read here.
 *
 * The shape is `OpenPanel`'s — one value rather than a map — for the same
 * reason: a map can hold a lens for every generation a session has ever shown,
 * and every one of those entries is a place that no longer exists. The cost is
 * named there and is the same here: only one place's lens is remembered.
 */

export const WORKSPACE_LENSES = ["changes", "files"] as const;

export type WorkspaceLens = (typeof WORKSPACE_LENSES)[number];

/**
 * A lens somebody asked for, and the place they asked for it in.
 *
 * `taskId` and `view` together name one place. `view` is the workspace view's
 * identity (`kind:workspaceId`, see `components/workspace/workspaceView.ts`),
 * not the session, because the rule this preserves is that changing generation
 * forgets the manual pick: the changes of one generation say nothing about the
 * changes of the next, so somebody who chose "changes" while reading generation
 * 3 has not chosen anything about generation 4.
 */
export type LensPick = { taskId: string; view: string; lens: WorkspaceLens } | null;

/**
 * The lens a place opens on before anyone has picked: the changes when there
 * are any, the tree otherwise.
 *
 * This is also the whole of "opening a changed file from the chat lands on the
 * changes list". There was once a second rule for that in the panel — an effect
 * that set the lens to `changes` whenever a path was opened — and it could not
 * change the lens: it ran only when `hasChanges` was true, which is exactly when
 * this default already said `changes`, and it stood down when the person had
 * picked a lens, which is the other case. Two rules for one behaviour is one
 * rule too many, so the effect is gone and this is where the behaviour lives.
 */
export function derivedLens(hasChanges: boolean): WorkspaceLens {
  return hasChanges ? "changes" : "files";
}

/**
 * The lens to draw: the one picked for this exact place, else the derived one.
 *
 * A pick that is still current wins even when `hasChanges` has since gone false.
 * That is deliberate and is what the panel already did for a lens the person had
 * chosen: the changes tab is drawn disabled and empty rather than the reader's
 * list being swapped for a different one underneath them.
 */
export function lensForPick(
  pick: LensPick,
  taskId: string,
  view: string,
  hasChanges: boolean,
): WorkspaceLens {
  if (pick && pick.taskId === taskId && pick.view === view) return pick.lens;
  return derivedLens(hasChanges);
}
