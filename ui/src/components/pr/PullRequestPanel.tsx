import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getTaskPullRequest,
  refreshTaskPullRequest,
  type PullRequestObservation,
  type TaskPullRequestSnapshot,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { overlayOwnsKeyboard } from "../../lib/overlayOwnsKeyboard";
import { formatRelativeTime } from "../../lib/relativeTime";
import PanelSurface from "../layout/PanelSurface";
import {
  absentRepoLabel,
  ciLabel,
  headerLabel,
  leadObservation,
  shouldAskForRead,
  otherPullRequests,
  parseCISummary,
  parseReviews,
  reviewStateLabel,
  stateLabel,
  unobservedLabel,
  type Elsewhere,
  type Review,
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
import Button from "../ui/Button";

type Props = {
  taskId: string;
  /**
   * Whether this task's pane is the one on screen. The host keeps recent tasks
   * mounted and hides the rest, so a panel can be open and invisible.
   */
  active?: boolean;
  /**
   * The machine this task runs on, when that is not the machine showing the
   * page. The read behind every row was made by that machine, so this is what
   * says where the work is before anything has been read (see absentRepoLabel)
   * and what gives the panel something to ask about at all (shouldAskForRead).
   */
  elsewhere?: Elsewhere;
  onClose?: () => void;
  /**
   * Drawn as the pull-request tab of the workspace panel rather than as a
   * surface of its own.
   *
   * The container then owns the skin, the tab strip and the one close button,
   * so this pane renders its body only: a second `PanelSurface` inside the
   * workspace panel would be two landmarks at one z-index, and a second close
   * would be two controls for one act.
   */
  embedded?: boolean;
};

/**
 * Pull-request state for a task's branch, read-only.
 *
 * Reading is a cache lookup, so the panel's job is to be honest about the age of
 * what it shows: a number with no "last seen" would read as live, and a failed
 * read that blanked the card would lose the pull request the user came here to
 * find. The one action that spends rate limit is the explicit refresh.
 *
 * `snapshot.gh` is deliberately not rendered. The user-facing part of a
 * degraded read is the sentence in `notice`; which binary was missing is an
 * implementation detail they cannot act on from this screen.
 */
export default function PullRequestPanel({
  taskId,
  active = true,
  elsewhere = null,
  onClose,
  embedded = false,
}: Props) {
  const tr = useT();
  const [snapshot, setSnapshot] = useState<TaskPullRequestSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Which read is allowed to publish. The panel's first read and a refresh the
  // user asked for while it was still running can both be in flight, and the
  // answer to the older one is not the newer state: without this, a refresh that
  // just fetched a pull request can be erased by the read that started before it.
  const latest = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++latest.current;
      const mine = () => seq === latest.current;
      try {
        const next = await getTaskPullRequest(taskId, signal);
        if (signal?.aborted || !mine()) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (signal?.aborted || !mine()) return;
        setError(describe(err));
      } finally {
        // The panel's first paint is what this flag is about, not whether this
        // particular read won: a read superseded by the refresh still settles
        // the question of whether there is anything to wait for.
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

  // The age is computed while rendering, so a panel left open would go on
  // saying "just now" about an observation that is hours old.
  //
  // Only while the panel is on screen: a task the user navigated away from
  // stays mounted and hidden, and eight hidden panels ticking once a second is
  // a re-render per second of DOM nobody is looking at. Coming back re-renders
  // this panel, which is what makes the age correct again the moment it is
  // visible.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Escape closes, as it does for the console's other overlays.
  //
  // Only the pane on screen and only when no floating layer owns the keyboard:
  // recent tasks stay mounted and hidden, and a menu or sheet drawn over this
  // pane is the reader's Escape target, not the panel underneath it.
  useEffect(() => {
    if (!active || !onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (overlayOwnsKeyboard()) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  // Options rather than a positional flag: this is handed to `onClick`
  // elsewhere, and a stray event object must not be able to mean "implicit" and
  // silence the answer the user is waiting for.
  const onRefresh = useCallback(
    async (options?: { implicit?: boolean }) => {
      const implicit = options?.implicit === true;
      // Supersedes any read in flight, including the panel's first one.
      const seq = ++latest.current;
      setBusy(true);
      try {
        const next = await refreshTaskPullRequest(taskId);
        if (seq !== latest.current) return;
        // Landing, this is the newest answer there is, so the reads that raced
        // it are moot: they were answered from the cache this replaced, and
        // letting one publish afterwards would put the older card back and
        // throw away what the user just spent rate limit on.
        latest.current += 1;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (seq !== latest.current) return;
        // Same on the way out: a read that raced a failed refresh would clear
        // the sentence explaining why there is nothing new to show.
        latest.current += 1;
        // An ask the user did not make reports nothing to the user. Querying is
        // operator-only, so on a paired phone the one this panel fires on open
        // is refused outright — and a red line saying "only the owner can query
        // GitHub" on a screen nobody asked anything of is noise they cannot act
        // on. A failed attempt is not hidden by this: it is written to the
        // branch's own row, and the row's `last_error` is where this panel reads
        // it from on the next look.
        if (!implicit) setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [taskId, describe],
  );

  // A branch nobody has ever looked at gets one query, asked once per open.
  //
  // Nothing else would ask it. Reading is a cache lookup, and the daemon's
  // background pass only walks pull requests that already exist — a branch with
  // no pull request has nothing that changes on its own. So without this, a
  // first look at every unpublished branch would sit on "not checked yet" until
  // the user found the refresh button, which is precisely the moment they are
  // asking the question. One request for a branch that has no row of its own;
  // an answer that does exist, however old, is shown as it is, with its age.
  //
  // Which cases those are is `shouldAskForRead`'s to say, including the one this
  // panel cannot see for itself: a task on another machine whose branch has not
  // been recorded yet still has a checkout, and asking is how its branch arrives.
  //
  // Not asking leaves the question open rather than marking it asked, so a
  // workspace that arrives later still gets its one query.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    if (!shouldAskForRead(snapshot, elsewhere)) return;
    asked.current = true;
    // Implicit: whatever this refresh has to say about itself, it says to the
    // row, not to the user (see `onRefresh`).
    void onRefresh({ implicit: true });
  }, [snapshot, elsewhere, onRefresh]);

  const lead = leadObservation(snapshot?.observations, snapshot?.branch);
  const others = otherPullRequests(snapshot?.observations, lead);

  const body = (
    <>
      {/* Header — matches the workspace and publish panels */}
      <div className="flex flex-none items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
        <IconPullRequest size={14} className="flex-none text-kin-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-kin-text">{tr("pr.title")}</div>
          <div className="truncate font-mono text-caption text-kin-muted">
            {headerLabel(snapshot, lead) || absentRepoLabel(tr, elsewhere)}
          </div>
        </div>
        {/*
          The refresh is offered for every task, including one whose checkout is
          on another machine: the read is made there, by that machine, and this
          button is what asks it to. A machine that cannot be reached answers
          with its own reason, which lands under the card.
        */}
        <Button
          variant="secondary"
          onClick={() => void onRefresh()}
          disabled={busy}
          aria-label={tr("pr.refresh")}
          className="flex-none gap-1.5 rounded-md px-2 py-1 text-body font-normal text-kin-text"
          title={tr("pr.refreshHint")}
        >
          {busy ? <IconSpinner size={13} strokeWidth={2} /> : <IconRefresh size={13} />}
          <span className="hidden sm:inline">{tr("pr.refresh")}</span>
        </Button>
        {onClose && !embedded && (
          <Button
            variant="quiet"
            onClick={onClose}
            className="group min-w-[44px] flex-none rounded-md p-1.5 sm:min-w-0"
            aria-label={tr("pr.close")}
            title={tr("pr.close")}
          >
            <span className="text-kin-muted transition-colors group-hover:text-kin-text">
              <IconX size={14} />
            </span>
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto kin-scroll px-3 py-3">
        <div className="mx-auto max-w-conversation space-y-2">
          {snapshot?.notice && (
            <p className="flex items-start gap-1.5 text-caption text-kin-muted">
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
            <p className="flex items-start gap-1.5 text-body text-kin-red-ink">
              <IconAlert size={13} className="mt-0.5 flex-none" />
              <span>{error}</span>
            </p>
          )}

          {!snapshot ? (
            loading ? (
              <Loading />
            ) : null
          ) : !lead ? (
            // Asking is what this branch needs, and while that request is out
            // "not checked yet" would read as a settled answer.
            busy ? (
              <Checking />
            ) : (
              <p className="text-body text-kin-muted">{unobservedLabel(tr)}</p>
            )
          ) : (
            <ObservationCard lead={lead} busy={busy} />
          )}

          {others.length > 0 && (
            <div className="pt-1">
              <div className="mb-1 text-caption font-medium text-kin-muted">
                {tr("pr.earlierBranches")}
              </div>
              <ul className="space-y-1">
                {others.map((o) => (
                  <li
                    key={`${o.repo}/${o.head_branch}`}
                    className="flex items-center gap-2 text-body"
                  >
                    <span className="flex-none text-kin-muted">#{o.number}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-kin-muted">
                      {o.head_branch}
                    </span>
                    {o.url && (
                      <a
                        href={o.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-h-11 min-w-[44px] flex-none items-center gap-1 text-kin-blue-ink hover:underline sm:min-h-0 sm:min-w-0"
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
    </>
  );

  // Embedded is the workspace panel's PR tab: the container draws the skin,
  // the strip and the one close, so this pane draws neither. Still a flex
  // column, so the header holds still and the body is what scrolls.
  if (embedded) return <div className="h-full min-h-0 flex flex-col">{body}</div>;

  return (
    <PanelSurface label={tr("pr.title")} className="flex flex-col" shape="column">
      {body}
    </PanelSurface>
  );
}

/**
 * The line that stands in for an answer while a query is running.
 *
 * It exists so that "not checked yet" is not shown while the question is still
 * open, which reads as a settled answer.
 */
function Checking() {
  const tr = useT();
  return (
    <p className="flex items-start gap-1.5 text-body text-kin-muted">
      <IconSpinner size={13} className="mt-0.5 flex-none" />
      <span>{tr("pr.checking")}</span>
    </p>
  );
}

function Loading() {
  const tr = useT();
  return (
    <div className="flex items-center gap-2 text-strong text-kin-muted">
      <IconSpinner size={14} strokeWidth={2} />
      {tr("pr.loading")}
    </div>
  );
}

/** How many reviews the card lists before folding the rest into one line. */
const REVIEWS_SHOWN = 5;

/**
 * The reviews the cached snapshot carries, under the checks.
 *
 * `null` and `[]` are different answers and get different sentences: never
 * read, versus read and found none. The cap is a render rule because the panel
 * has to stay scannable; nothing is dropped from the cache.
 */
function Reviews({ reviews }: { reviews: Review[] | null }) {
  const tr = useT();
  if (reviews === null) {
    return <p className="mt-2 text-caption text-kin-muted">{tr("pr.reviewsNeverRead")}</p>;
  }
  if (reviews.length === 0) {
    return <p className="mt-2 text-caption text-kin-muted">{tr("pr.reviewsNone")}</p>;
  }
  const shown = reviews.slice(0, REVIEWS_SHOWN);
  return (
    <ul className="mt-2 divide-y divide-[var(--kin-hairline)] border-t border-[var(--kin-hairline)] text-caption">
      {shown.map((review, index) => (
        <li key={`${review.author}-${index}`} className="py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-kin-text">{review.author}</span>
            {review.state && (
              <span className="text-kin-muted">{reviewStateLabel(tr, review.state)}</span>
            )}
          </div>
          {review.body && (
            // Three lines keeps the card scannable; the title carries the rest
            // for a hover, and the pull request link is one click away.
            <p className="mt-0.5 line-clamp-3 text-kin-muted" title={review.body}>
              {review.body}
            </p>
          )}
        </li>
      ))}
      {reviews.length > shown.length && (
        <li className="py-1.5 text-kin-muted">
          {tr("pr.reviewsMore", { more: String(reviews.length - shown.length) })}
        </li>
      )}
    </ul>
  );
}

function ObservationCard({ lead, busy }: { lead: PullRequestObservation; busy: boolean }) {
  const tr = useT();
  const ci = parseCISummary(lead.ci_summary);

  return (
    <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
      {lead.observed_at === undefined ? (
        busy ? (
          <Checking />
        ) : (
          <p className="text-body text-kin-muted">{tr("pr.neverChecked")}</p>
        )
      ) : lead.number === undefined ? (
        <p className="text-body text-kin-muted">{tr("pr.none")}</p>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <IconPullRequest size={14} className={`mt-0.5 flex-none ${stateColor(lead.state)}`} />
            <div className="min-w-0 flex-1">
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-1 text-strong font-medium text-kin-text hover:underline"
                title={lead.title}
              >
                {/* Two lines on a phone rather than one ellipsised line; the
                    icon sits beside the text so the clamp never pushes it onto
                    a line of its own. */}
                <span className="line-clamp-2 min-w-0">
                  <span className="text-kin-muted">#{lead.number}</span>{" "}
                  {lead.title || tr("pr.untitled")}
                </span>
                <IconExternal size={11} className="mt-1 flex-none" />
              </a>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-kin-muted">
                <span>{stateLabel(tr, lead)}</span>
                {lead.base_branch && lead.head_branch && (
                  // Branch names are `kin/task/<id>/g<N>`, so the source branch
                  // can be wider than a phone: truncate that side only. The
                  // target starting with `→` is the smaller, more important
                  // half — where the change lands — and never gets cut off.
                  <span className="flex min-w-0 max-w-full items-baseline gap-1 font-mono">
                    <span className="truncate">{lead.head_branch}</span>
                    <span className="flex-none">→ {lead.base_branch}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {lead.ci_state && lead.ci_state !== "none" && (
            <div className="mt-2 flex items-start gap-1.5 text-caption">
              {lead.ci_state === "success" ? (
                <IconCheck size={12} className="mt-0.5 flex-none text-kin-green-ink" />
              ) : lead.ci_state === "failure" ? (
                <IconAlert size={12} className="mt-0.5 flex-none text-kin-red-ink" />
              ) : (
                <IconSpinner size={12} className="mt-0.5 flex-none" />
              )}
              <span className={lead.ci_state === "failure" ? "text-kin-red-ink" : "text-kin-muted"}>
                {ciLabel(tr, lead.ci_state, ci)}
              </span>
            </div>
          )}

          <Reviews reviews={parseReviews(lead.reviews)} />
        </>
      )}

      {/* The age and the last failure, which are what make the card above
          trustworthy rather than merely present. */}
      <div className="mt-2 border-t border-[var(--kin-hairline)] pt-1.5 text-caption text-kin-muted">
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
          <div className="mt-0.5 text-kin-red-ink">
            {tr("pr.lastAttemptFailed", { reason: lead.last_error })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function stateColor(state: string | undefined): string {
  switch (state) {
    case "merged":
      return "text-kin-blue-ink";
    case "closed":
      return "text-kin-muted";
    default:
      return "text-kin-green-ink";
  }
}
