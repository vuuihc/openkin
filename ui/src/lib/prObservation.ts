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

export type PollDecision = "idle" | "poll" | "exhausted";

/**
 * Whether to keep following a query the daemon is running in the background.
 *
 * This is a function rather than a counter inside an effect because of what a
 * failed poll does: the loop used to be re-armed by the *snapshot changing*, so
 * one failed read — which changes no snapshot — left the timer unfired, the
 * spinner turning, and the refresh button disabled, with the answer the daemon
 * was still fetching unreachable without closing the panel. Attempts are
 * counted instead of successes, so a failed one still books the next inside the
 * budget; when the budget is spent the panel says so and hands the decision
 * back to the user rather than looking busy forever.
 */
export function pollDecision(
  refreshing: boolean,
  polls: number,
  max: number,
): PollDecision {
  if (!refreshing) return "idle";
  return polls >= max ? "exhausted" : "poll";
}
