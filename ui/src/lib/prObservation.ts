/**
 * Reading the daemon's pull-request cache.
 *
 * The wire shape is deliberately "everything that was true when it was read,
 * plus how the last read went" (see `internal/store/pr_observations.go`), so
 * the console has to make two decisions per render: which of the task's rows is
 * the one to lead with, and how to say a failed read without losing the answer
 * that came before it. Both live here rather than in the component so they can
 * be tested without rendering.
 */
import type { PullRequestObservation } from "../api/client";

/** The translator, narrowed so these helpers can be tested without React. */
export type Translate = (
  key: string,
  params?: Record<string, string | number | undefined | null>,
) => string;

export type CISummary = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failing: string[];
};

/**
 * `ci_summary` is a JSON string written by the daemon. Parse it defensively:
 * it is a cache of somebody else's API, and a console that throws on an
 * unexpected shape would lose the pull-request number along with the check
 * counts.
 */
export function parseCISummary(raw: string | undefined): CISummary | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const count = (key: string): number => {
    const n = record[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const failing = Array.isArray(record.failing)
    ? record.failing.filter((name): name is string => typeof name === "string")
    : [];
  return {
    total: count("total"),
    passed: count("passed"),
    failed: count("failed"),
    pending: count("pending"),
    failing,
  };
}

/**
 * The row to lead with: the current branch's, which is what the diff and the
 * publish button belong to.
 *
 * An exact branch match wins even when that row has never been observed — a
 * failed check on this branch is this branch's answer, and substituting an
 * older generation's pull request would put a number on screen that belongs to
 * another branch.
 *
 * Only when the branch matches nothing does the most recently observed row
 * stand in, so that a task whose checkout has since been removed still shows
 * the pull request it opened rather than going blank. The observation outlives
 * the worktree on purpose.
 */
export function leadObservation(
  observations: PullRequestObservation[] | undefined,
  branch: string | undefined,
): PullRequestObservation | null {
  if (!observations || observations.length === 0) return null;
  if (branch) {
    const exact = observations.find((o) => o.head_branch === branch);
    if (exact) return exact;
  }
  let best: PullRequestObservation | null = null;
  for (const o of observations) {
    if (o.observed_at === undefined) continue;
    if (!best || (best.observed_at ?? 0) < o.observed_at) best = o;
  }
  return best ?? observations[0];
}

/**
 * This branch's own row, or nothing.
 *
 * Not the same question as `leadObservation`, which falls back to another
 * branch's row so the card is never empty. The fallback is for showing; asking
 * GitHub is decided on this. A task whose workspace moved from `g1` to `g2`
 * shows the older generation's pull request — labelled with the branch it
 * belongs to — while the branch on screen has still never been asked about.
 */
export function observedBranch(
  observations: PullRequestObservation[] | undefined,
  branch: string | undefined,
): PullRequestObservation | undefined {
  if (!observations || !branch) return undefined;
  return observations.find((o) => o.head_branch === branch);
}

/**
 * Branches other than the lead's that have a pull request.
 *
 * A task gets a new branch per workspace generation, so an earlier generation
 * can have its own pull request. Those are unreachable from the current branch
 * and would otherwise never be shown.
 *
 * Identity is the pair, not the branch name: two repositories could name a
 * branch the same way, and dropping one of them would hide a pull request.
 *
 * Ordered by branch name, as the daemon returns them — which is not creation
 * order once a task passes nine generations, and is not claimed to be.
 */
export function otherPullRequests(
  observations: PullRequestObservation[] | undefined,
  lead: PullRequestObservation | null,
): PullRequestObservation[] {
  if (!observations) return [];
  return observations.filter(
    (o) => o.number !== undefined && !sameRow(o, lead),
  );
}

function sameRow(
  a: PullRequestObservation,
  b: PullRequestObservation | null,
): boolean {
  return !!b && a.repo === b.repo && a.head_branch === b.head_branch;
}

/** github.com/owner/name → owner/name. The host is the same for every row. */
export function shortRepo(canonical: string): string {
  const parts = canonical.split("/");
  return parts.length >= 3 ? parts.slice(1).join("/") : canonical;
}

/**
 * The repository and branch line for the panel header.
 *
 * `snapshot.repo` is only set while the task still has a workspace on a GitHub
 * remote, so a task whose checkout has been removed would otherwise be labelled
 * "not in a GitHub repository" while showing a pull request from one. The row's
 * own repository is the durable answer.
 */
export function headerLabel(
  snapshot: { repo?: string; branch?: string } | null,
  lead: PullRequestObservation | null,
): string {
  const repo = snapshot?.repo || lead?.repo || "";
  if (!repo) return "";
  const short = shortRepo(repo);
  const branch = snapshot?.branch || lead?.head_branch || "";
  return branch ? `${short} · ${branch}` : short;
}

/** The machine a task runs on, when that is not the machine showing the page. */
export type Elsewhere = { text: string; known: boolean } | null;

/**
 * What the header says where the repository and branch would go.
 *
 * `headerLabel` names them when there is something to name, and its fallback is
 * a claim: "this task is not in a GitHub repository". That claim is only the
 * daemon's to make about a checkout it can see. For a task that runs elsewhere,
 * the pair is whatever the task row was created with and the other machine has
 * not been asked yet, so an empty header is "the checkout is over there", not
 * "there is no repository" — and the sentence a person reads decides whether
 * they go and look at the other machine or conclude there is nothing to look at.
 *
 * The branch the work is on is not lost by saying so: it is on the other
 * machine, where the person can see it.
 */
export function absentRepoLabel(tr: Translate, elsewhere: Elsewhere): string {
  if (!elsewhere) return tr("pr.noRepo");
  return elsewhere.known
    ? tr("pr.repoElsewhere", { name: elsewhere.text })
    : tr("pr.repoElsewhereUnknown", { name: elsewhere.text });
}

/**
 * What the body says where a pull request would go, before one has been read.
 *
 * The same sentence whichever machine holds the checkout. It used to say that no
 * answer was coming for another machine's checkout, because none was: the read
 * resolved the task's directory here. It is made by the machine that holds it
 * now, so "not checked yet" is a wait again — and the wait ends either in an
 * answer or in that machine's own reason, which is written on the row.
 */
export function unobservedLabel(tr: Translate): string {
  return tr("pr.notChecked");
}

/**
 * Whether opening the panel should ask for a read.
 *
 * A branch on screen that has never been observed is the case this is for: no
 * other path asks about it, because the background pass only walks pull requests
 * that already exist and a branch with none has nothing that changes on its own.
 *
 * The branchless case used to be nothing to ask about, on the grounds that no
 * branch means no GitHub repository behind the task. That was true while the
 * daemon answering this panel resolved every task's directory itself. It is not
 * true for a task that runs elsewhere: the branch there is the other machine's to
 * report, and a session that started while that machine was away — or that was
 * forked from one — has none recorded until somebody asks. Those are exactly the
 * sessions with something to find, so the machine's presence is what decides, and
 * the ask is what turns "not checked yet" into an answer or a reason.
 */
export function shouldAskForRead(
  snapshot: {
    branch?: string;
    observations?: PullRequestObservation[];
  } | null,
  elsewhere: Elsewhere,
): boolean {
  if (!snapshot) return false;
  if (snapshot.branch) return !observedBranch(snapshot.observations, snapshot.branch);
  return elsewhere !== null;
}

/** How the pull request reads: draft first, because it is the actionable part. */
export function stateLabel(
  tr: Translate,
  lead: Pick<PullRequestObservation, "is_draft" | "state">,
): string {
  if (lead.is_draft) return tr("pr.stateDraft");
  switch (lead.state) {
    case "merged":
      return tr("pr.stateMerged");
    case "closed":
      return tr("pr.stateClosed");
    default:
      return tr("pr.stateOpen");
  }
}

/**
 * The check-run line.
 *
 * A state the daemon reported outranks counts that are missing: a corrupt or
 * legacy cache row can carry `success` with no summary, and rendering that as
 * "checks running" is the worst of the three wrong answers available.
 */
export function ciLabel(
  tr: Translate,
  state: string,
  ci: CISummary | null,
): string {
  const total = ci?.total ?? 0;
  if (state === "success") {
    return total > 0
      ? tr("pr.ciSuccess", { total: String(total) })
      : tr("pr.ciSuccessPlain");
  }
  if (total === 0) {
    return state === "failure" ? tr("pr.ciFailure") : tr("pr.ciPending");
  }
  const counts = { total: String(total) };
  if (state === "failure") {
    return ci!.failing.length > 0
      ? tr("pr.ciFailureNamed", {
          ...counts,
          failed: String(ci!.failed),
          names: ci!.failing.slice(0, 3).join(", "),
        })
      : tr("pr.ciFailureCount", { ...counts, failed: String(ci!.failed) });
  }
  return tr("pr.ciPendingCount", {
    ...counts,
    passed: String(ci!.passed),
  });
}
