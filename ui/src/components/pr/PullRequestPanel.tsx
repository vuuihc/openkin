import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getTaskPullRequest,
  refreshTaskPullRequest,
  type PullRequestObservation,
  type TaskPullRequestSnapshot,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { formatRelativeTime } from "../../lib/relativeTime";
import {
  ciLabel,
  headerLabel,
  leadObservation,
  otherPullRequests,
  parseCISummary,
  pollDecision,
  stateLabel,
  type PollDecision,
} from "../../lib/prObservation";
import {
  IconAlert,
  IconCheck,
  IconExternal,
  IconPullRequest,
  IconRefresh,
  IconSpinner,
  IconX,
} from "../icons";

type Props = {
  taskId: string;
  onClose?: () => void;
};

/** How often, and how many times, to follow a query the daemon is running. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 12;

/**
 * Pull-request state for a task's branch, read-only.
 *
 * Everything here is a cached observation, so the panel's job is to be honest
 * about its age: a number with no "last seen" would read as live, and a failed
 * read that blanked the card would lose the pull request the user is looking
 * for. The one action that spends rate limit is the explicit refresh.
 *
 * `snapshot.gh` is deliberately not rendered. The user-facing part of a
 * degraded read is the sentence in `notice`; which binary was missing is an
 * implementation detail they cannot act on from this screen.
 */
export default function PullRequestPanel({ taskId, onClose }: Props) {
  const tr = useT();
  const [snapshot, setSnapshot] = useState<TaskPullRequestSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polls, setPolls] = useState(0);

  const describe = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.status === 503) return tr("pr.unavailable");
        // Querying is operator-only while reading is not, so a member who owns
        // the task can reach this screen and still be refused the one button
        // that spends rate limit.
        if (err.status === 403) return tr("pr.forbidden");
      }
      return err instanceof Error ? err.message : String(err);
    },
    [tr],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await getTaskPullRequest(taskId);
        if (signal?.aborted) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(describe(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [taskId, describe],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refreshing = snapshot?.refreshing === true;
  const following = pollDecision(refreshing, polls, MAX_POLLS);

  // Follow the query the daemon started behind the response, so that "no pull
  // request yet" is not mistaken for an answer. The attempt is counted rather
  // than the success: a failed poll changes no snapshot, and a loop re-armed by
  // the snapshot would stop there — spinner turning, button disabled, and the
  // answer the daemon was still fetching unreachable without closing the panel.
  useEffect(() => {
    if (following === "idle") {
      setPolls(0);
      return;
    }
    if (following === "exhausted") return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      void load();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
    // `polls` belongs in this list even though nothing in the body reads it:
    // it is the only dependency that moves between the first attempt and the
    // last, so dropping it arms one timer and then goes quiet for the rest of
    // the budget. `following` looks like the signal and is not — it is derived
    // from `polls` and holds the same value across attempts.
  }, [following, polls, load]);

  // Escape closes, as it does for the console's other overlays.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await refreshTaskPullRequest(taskId));
      setError(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [taskId, describe]);

  const lead = leadObservation(snapshot?.observations, snapshot?.branch);
  const others = otherPullRequests(snapshot?.observations, lead);
  // While the panel is following, the button would only start a second query
  // for the same branch. Once the budget is spent the panel has stopped
  // following, so the user can ask again by hand.
  const followingNow = following === "poll";

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-[var(--kin-inspector)] safe-pad"
      role="complementary"
      aria-label={tr("pr.title")}
    >
      {/* Header — matches WorkspacePanel chrome */}
      <div className="flex flex-none items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
        <IconPullRequest size={14} className="flex-none text-kin-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-kin-text">
            {tr("pr.title")}
          </div>
          <div className="truncate font-mono text-[11px] text-kin-muted">
            {headerLabel(snapshot, lead) || tr("pr.noRepo")}
          </div>
        </div>
        <button
          type="button"
          className="flex flex-none items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-[12px] text-kin-text transition-colors hover:bg-[var(--kin-fill-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void onRefresh()}
          disabled={busy || followingNow}
          title={tr("pr.refreshHint")}
        >
          {busy || followingNow ? (
            <IconSpinner size={13} strokeWidth={2} />
          ) : (
            <IconRefresh size={13} />
          )}
          <span className="hidden sm:inline">{tr("pr.refresh")}</span>
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-md p-1.5 text-kin-muted transition-colors hover:bg-[var(--kin-fill)] hover:text-kin-text"
            aria-label={tr("pr.close")}
            title={tr("pr.close")}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto kin-scroll px-3 py-3">
        <div className="mx-auto max-w-[720px] space-y-2">
          {snapshot?.notice && (
            <p className="flex items-start gap-1.5 text-[11.5px] text-kin-muted">
              <IconAlert size={12} className="mt-0.5 flex-none" />
              <span>{snapshot.notice}</span>
            </p>
          )}

          {/*
            A failed read keeps its own line and leaves the card standing. The
            card is the last thing that was true, and replacing it with an error
            would lose the number and link the user opened this panel to find.
          */}
          {error && (
            <p className="flex items-start gap-1.5 text-[12px] text-kin-red">
              <IconAlert size={13} className="mt-0.5 flex-none" />
              <span>{error}</span>
            </p>
          )}

          {!snapshot ? (
            loading ? <Loading /> : null
          ) : !lead ? (
            // A first look at a branch reaches here with no rows at all, which
            // is the case the daemon's refreshing flag exists for: saying "not
            // checked yet" while a query is in flight reads as an answer.
            <Checking following={following} fallback={tr("pr.notChecked")} />
          ) : (
            <ObservationCard lead={lead} following={following} />
          )}

          {others.length > 0 && (
            <div className="pt-1">
              <div className="mb-1 text-[11px] font-medium text-kin-muted">
                {tr("pr.earlierBranches")}
              </div>
              <ul className="space-y-1">
                {others.map((o) => (
                  <li
                    key={`${o.repo}/${o.head_branch}`}
                    className="flex items-center gap-2 text-[12px]"
                  >
                    <span className="flex-none text-kin-muted">
                      #{o.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-kin-muted">
                      {o.head_branch}
                    </span>
                    {o.url && (
                      <a
                        href={o.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-h-[44px] min-w-[44px] flex-none items-center gap-1 text-kin-blue hover:underline sm:min-h-0 sm:min-w-0"
                      >
                        <IconExternal size={12} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The line that stands in for an answer while the daemon is still querying, and
 * the one that admits the panel has stopped waiting for it.
 *
 * `fallback` is what to say when nothing is in flight. It is a parameter rather
 * than a sibling because "not checked yet" reads as a settled answer, and it
 * must not be shown while a query is running: a first look at an unpublished
 * branch is precisely when the daemon's refreshing flag earns its keep.
 */
function Checking({
  following,
  fallback,
}: {
  following: PollDecision;
  fallback?: string;
}) {
  const tr = useT();
  if (following === "idle") {
    return fallback ? (
      <p className="text-[12.5px] text-kin-muted">{fallback}</p>
    ) : null;
  }
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-kin-muted">
      {following === "poll" && (
        <IconSpinner size={13} className="mt-0.5 flex-none" />
      )}
      <span>
        {following === "poll" ? tr("pr.checking") : tr("pr.checkingSlow")}
      </span>
    </p>
  );
}

function Loading() {
  const tr = useT();
  return (
    <div className="flex items-center gap-2 text-[13px] text-kin-muted">
      <IconSpinner size={14} strokeWidth={2} />
      {tr("pr.loading")}
    </div>
  );
}

function ObservationCard({
  lead,
  following,
}: {
  lead: PullRequestObservation;
  following: PollDecision;
}) {
  const tr = useT();
  const ci = parseCISummary(lead.ci_summary);

  return (
    <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 px-3 py-2.5">
      {lead.observed_at === undefined ? (
        <Checking following={following} fallback={tr("pr.neverChecked")} />
      ) : lead.number === undefined ? (
        <p className="text-[12.5px] text-kin-muted">{tr("pr.none")}</p>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <IconPullRequest
              size={14}
              className={`mt-0.5 flex-none ${stateColor(lead.state)}`}
            />
            <div className="min-w-0 flex-1">
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-[13px] font-medium text-kin-text hover:underline"
                title={lead.title}
              >
                <span className="text-kin-muted">#{lead.number}</span>{" "}
                {lead.title || tr("pr.untitled")}
                <IconExternal size={11} className="ml-1 inline-flex" />
              </a>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-kin-muted">
                <span>{stateLabel(tr, lead)}</span>
                {lead.base_branch && lead.head_branch && (
                  // Branch names are `kin/task/<id>/g<N>`, so this line can be
                  // wider than a phone: truncate rather than escape the card.
                  <span className="min-w-0 max-w-full truncate font-mono">
                    {lead.head_branch} → {lead.base_branch}
                  </span>
                )}
              </div>
            </div>
          </div>

          {lead.ci_state && lead.ci_state !== "none" && (
            <div className="mt-2 flex items-start gap-1.5 text-[11.5px]">
              {lead.ci_state === "success" ? (
                <IconCheck
                  size={12}
                  className="mt-0.5 flex-none text-kin-green"
                />
              ) : lead.ci_state === "failure" ? (
                <IconAlert size={12} className="mt-0.5 flex-none text-kin-red" />
              ) : (
                <IconSpinner size={12} className="mt-0.5 flex-none" />
              )}
              <span
                className={
                  lead.ci_state === "failure" ? "text-kin-red" : "text-kin-muted"
                }
              >
                {ciLabel(tr, lead.ci_state, ci)}
              </span>
            </div>
          )}
        </>
      )}

      {/* The age and the last failure, which are what make the card above
          trustworthy rather than merely present. */}
      <div className="mt-2 border-t border-[var(--kin-hairline)] pt-1.5 text-[11px] text-kin-muted">
        {lead.observed_at !== undefined ? (
          <span>
            {tr("pr.lastSeen", {
              // Age against the real clock, never against the row's own
              // attempt: measuring from there makes every answer look like it
              // arrived just now, which is the one thing this line exists to
              // prevent.
              when: formatRelativeTime(lead.observed_at),
            })}
          </span>
        ) : null}
        {lead.last_error ? (
          <div className="mt-0.5 text-kin-red">
            {tr("pr.lastAttemptFailed", { reason: lead.last_error })}
          </div>
        ) : null}
        {/* A row with an observation has a card that reads as settled — a
            number, or "no pull request for this branch yet" — so the only place
            left to say the daemon is still working, or has stopped and given up
            the budget, is here. Guarded on `following` as well as the row, so
            that a settled card keeps the footer it had. */}
        {lead.observed_at !== undefined && following !== "idle" && (
          <div className="mt-0.5">
            <Checking following={following} />
          </div>
        )}
      </div>
    </div>
  );
}

function stateColor(state: string | undefined): string {
  switch (state) {
    case "merged":
      return "text-kin-purple";
    case "closed":
      return "text-kin-muted";
    default:
      return "text-kin-green";
  }
}
