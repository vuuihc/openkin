import type { ChangedFileAction } from "../lib/changedFiles";

/**
 * How a changed file is presented, in the three places that present one: the
 * workspace list, the workspace bar, and the round evidence card in the chat.
 *
 * It lives here rather than in each of them because the two questions a reader
 * asks of any of those rows — what happened to this file, and how much — have to
 * have the same answer in all three, or the same file reads as a different
 * change depending on where it is looked at.
 */

/** The i18n key for a file's action. Callers resolve it, so this stays pure. */
export function actionLabelKey(action: ChangedFileAction): string {
  switch (action) {
    case "write":
      return "workspace.changed.write";
    case "edit":
      return "workspace.changed.edit";
    case "delete":
      return "workspace.changed.delete";
    default:
      return "workspace.changed.other";
  }
}

/**
 * The status dot for a file's action.
 *
 * The fill tier, like every other status dot in the console: an `-ink` value is
 * a *foreground* — dark in the light scheme, where a dot wants the status
 * family's own pigment.
 */
export function actionDotClass(action: ChangedFileAction): string {
  switch (action) {
    case "write":
      return "bg-kin-green";
    case "edit":
      return "bg-kin-blue";
    case "delete":
      return "bg-kin-red";
    default:
      return "bg-kin-muted";
  }
}

/** Added / removed line counts. Counts the payload could not reconstruct are absent, not zero. */
export default function DeltaInline({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) {
    return <span className="text-kin-muted">±0</span>;
  }
  return (
    <span>
      {additions > 0 && <span className="text-kin-green-ink">+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="text-kin-muted"> </span>}
      {deletions > 0 && <span className="text-kin-red-ink">−{deletions}</span>}
    </span>
  );
}
