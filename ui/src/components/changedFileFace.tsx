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

/**
 * One file's size, or the fact that nobody knows it.
 *
 * The third face of the same contract as `DeltaInline`: a count that never
 * arrived is absent, and absent has to be *said*, not drawn as blank. Both
 * counts missing is the bodyless delete and anything else whose payload only
 * named a path; "size unknown" is what the round card has always printed there,
 * and the workspace bar printing nothing instead is how one file read as two
 * different things depending on where it was looked at.
 *
 * The same sentence covers the half-missing pair that would otherwise print as
 * `±0` — see the guard below, which is about not stating a count nobody sent
 * rather than about which of the two is missing.
 *
 * `t` is passed in rather than read here so this stays usable from the places
 * that already hold a translator.
 */
export function FileSize({
  additions,
  deletions,
  label,
}: {
  additions?: number | null;
  deletions?: number | null;
  /** The translated "size unknown" text. */
  label: string;
}) {
  if (additions == null && deletions == null) {
    return <span className="text-kin-muted">{label}</span>;
  }
  const adds = additions ?? 0;
  const dels = deletions ?? 0;
  // `±0` is a claim that the edit changed no lines. When one count never
  // arrived, the zero standing in for it is this component's own filling-in, so
  // that claim would be made about a payload that did not say — and `±0` is the
  // one shape where the substituted value *is* the whole answer. The shapes that
  // keep a real count keep it: a delete that reported deletions and no additions
  // still reads `−5`, the same as it always has.
  if (adds === 0 && dels === 0 && (additions == null || deletions == null)) {
    return <span className="text-kin-muted">{label}</span>;
  }
  return <DeltaInline additions={adds} deletions={dels} />;
}
