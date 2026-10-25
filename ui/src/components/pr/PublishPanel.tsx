import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createTaskBranch,
  publishTaskPullRequest,
  type PublishReport,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { shortRepo } from "../../lib/prObservation";
import { blockedHeadline, isSessionRunsHere } from "../../lib/publishBlocked";
import type { PublishDraft } from "../../lib/publishDraft";
import { MAX_TITLE_CHARS, publishWordsRefusal } from "../../lib/publishWords";
import { IconAlert, IconExternal, IconPullRequest, IconSend, IconSpinner, IconX } from "../icons";
import PanelSurface from "../layout/PanelSurface";

type Props = {
  taskId: string;
  /**
   * The machine this session runs on. The sheet is only ever opened for one:
   * publishing a checkout this daemon holds is refused by the Hub, so a sheet
   * for a local session would be a confirmation of something that cannot happen.
   */
  machine: { text: string; known: boolean };
  /** Where the Hub remembers the work being, which is what it draws before asking. */
  repo?: string;
  branch?: string;
  /** The agent's last answer, as the opening draft. Both boxes stay editable. */
  draft: PublishDraft;
  onClose?: () => void;
  /**
   * The Hub's row for this task has changed, so the page should read it again.
   *
   * Two of this sheet's answers change it: a publish (which records the branch
   * on the remote and the repository it landed in) and the escape below (which
   * moves the checkout and moves the row with it). The row is what this sheet
   * opens with — 仓库 and 分支, before anything has been asked — so without this
   * a reopened sheet goes back to naming the branch the session started on.
   */
  onRowChanged?: () => void;
};

/**
 * The publish sheet: the confirmation between a person and a branch appearing on
 * a forge under their name.
 *
 * It is a sheet rather than a button because the tap is irreversible in the way
 * that matters — a branch pushed and a pull request opened are public, and the
 * person's GitHub identity is on them. So the sheet says what will happen, in
 * whose words, on which machine, and takes an edit before it does.
 *
 * Everything hard about publishing happens on that machine (see internal/github
 * and internal/workspace): the boundary, the default branch, the uncommitted
 * work, the push that is never forced. The one of those the person can act on
 * from here is the default branch, and it is the one this sheet offers a way out
 * of.
 *
 * The report is drawn in place rather than as a toast, and a refusal is drawn
 * exactly like a success: both are answers to the question the sheet asked.
 */
export default function PublishPanel({
  taskId,
  machine,
  repo,
  branch,
  draft,
  onClose,
  onRowChanged,
}: Props) {
  const tr = useT();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [escaping, setEscaping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PublishReport | null>(null);
  /**
   * Where the machine says the checkout is, once it has answered.
   *
   * The row's answer is what the Hub remembers, and it can be out of date: a
   * person who ran `git checkout main` on that machine by hand, or a publish
   * this sheet refused, leaves the row describing a branch nobody is on. Every
   * answer carries the branch the machine actually read, refusal included, so
   * the line being read is the machine's rather than this Hub's memory.
   */
  const [seenBranch, setSeenBranch] = useState("");
  const shownBranch = seenBranch || branch || "";

  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const describe = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        // The daemon's own sentences for these are accurate and short; the two
        // that are not are the ones a person can be staring at without knowing
        // what to do next. 409 is both kinds at once, so it is told apart by the
        // code the Hub puts on the one this console has a line for.
        if (err.status === 503) return tr("publish.unavailable");
        if (isSessionRunsHere(err)) return tr("publish.notHere");
        return err.message;
      }
      return err instanceof Error ? err.message : String(err);
    },
    [tr],
  );

  const publish = useCallback(
    async (words: { title: string; body: string }) => {
      setBusy(true);
      setError(null);
      try {
        const answer = await publishTaskPullRequest(taskId, words);
        setReport(answer);
        // Where the machine found the checkout outranks the row, whether it
        // published or refused: it read the directory, the row remembers.
        if (answer.branch) setSeenBranch(answer.branch);
        if (answer.pushed) {
          onRowChanged?.();
        }
      } catch (err) {
        setReport(null);
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [taskId, describe, onRowChanged],
  );

  /**
   * The way out of a refusal on the default branch: a branch of this task's own,
   * on that machine, and then the publish the person was asking for.
   *
   * The label says both, because both happen. Starting the branch alone would
   * leave them one tap from where they were, and a button that pushed afterwards
   * without saying so would be a hidden write — the one thing this sheet exists
   * not to be.
   *
   * Which is also why it is enabled exactly when the publish below is: the second
   * half of it is that publish, title and all. A branch that moved the checkout
   * and then met a refusal about the title would be this sheet promising an
   * outcome it could not deliver — and the machine's own guard is what makes the
   * promise keepable, since a dirty checkout is refused for being dirty before
   * anybody is offered this.
   */
  const escape = useCallback(async () => {
    setEscaping(true);
    setError(null);
    try {
      const answer = await createTaskBranch(taskId);
      const current = answer.current ?? "";
      if (current) setSeenBranch(current);
      // The checkout moved, and the Hub moved its row with it. Read again even
      // if the publish below pushes too: that one reads again as well, and two
      // reads of one row a second apart cost less than a chip that lies.
      onRowChanged?.();
      await publish({ title, body });
    } catch (err) {
      setError(describe(err));
    } finally {
      setEscaping(false);
    }
  }, [taskId, title, body, publish, describe, onRowChanged]);

  const blocked = report?.blocked ?? "";
  const headline = blockedHeadline(blocked);
  // Why these words cannot be sent, in the wire's own terms — the same rule the
  // machine checks, so the sheet never offers a tap that would be refused, and
  // never disables one it cannot explain.
  const wordsRefusal = publishWordsRefusal({ title, body });
  const canPublish = wordsRefusal === "" && !busy && !escaping;
  const working = busy || escaping;

  return (
    <PanelSurface label={tr("publish.title")} className="flex flex-col">
      {/* Header — matches the workspace and pull-request panels */}
      <div className="flex flex-none items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
        <IconSend size={14} className="flex-none text-kin-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-kin-text">
            {tr("publish.title")}
          </div>
          <div className="truncate text-caption text-kin-muted" title={machine.text}>
            {machine.known
              ? tr("publish.on", { name: machine.text })
              : tr("publish.onUnknown", { name: machine.text })}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-md p-1.5 text-kin-muted transition-colors hover:bg-[var(--kin-fill)] hover:text-kin-text"
            aria-label={tr("publish.close")}
            title={tr("publish.close")}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto kin-scroll px-3 py-3">
        <div className="mx-auto max-w-conversation space-y-3">
          {/* What is about to happen, before it happens. */}
          <dl className="space-y-1 rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5 text-body">
            <Row label={tr("publish.repoLabel")} value={repo ? shortRepo(repo) : ""} full={repo} />
            <Row label={tr("publish.branchLabel")} value={shownBranch} mono />
          </dl>
          <p className="text-caption text-kin-muted">{tr("publish.what")}</p>

          <label className="block">
            <span className="mb-1 block text-caption font-medium text-kin-muted">
              {tr("publish.titleLabel")}
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr("publish.titlePlaceholder")}
              disabled={working}
              // The wire's bound, which the machine counts in characters rather
              // than bytes — so this stops at what would be refused and not before
              // it, and a title written in Chinese is not cut off at 85 of them.
              // (The box counts UTF-16 units, so a title of emoji stops at 128:
              // earlier than the wire would, and never later.)
              maxLength={MAX_TITLE_CHARS}
              className="w-full rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1.5 text-strong text-kin-text outline-none focus:border-kin-blue/50 disabled:opacity-60"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-caption font-medium text-kin-muted">
              {tr("publish.bodyLabel")}
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={tr("publish.bodyPlaceholder")}
              disabled={working}
              rows={10}
              className="w-full resize-y rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1.5 font-mono text-body leading-prose text-kin-text outline-none focus:border-kin-blue/50 disabled:opacity-60"
            />
          </label>

          {/* The answer, drawn where the question was asked. */}
          {report?.pushed && (
            <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
              {report.number ? (
                <a
                  href={report.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-strong font-medium text-kin-text hover:underline"
                >
                  <IconPullRequest size={14} className="flex-none text-kin-green-ink" />
                  <span>{tr("publish.published", { number: report.number })}</span>
                  <IconExternal size={11} className="flex-none" />
                </a>
              ) : (
                // The push landed and gh did not finish. Saying "published" here
                // would send the person looking for a pull request that is not
                // there; the branch really is on the remote, and that is what
                // this line claims.
                <p className="flex items-start gap-1.5 text-body text-kin-orange-ink">
                  <IconAlert size={13} className="mt-0.5 flex-none" />
                  <span>{tr("publish.pushedNoPR")}</span>
                </p>
              )}
              {report.reason && <p className="mt-1 text-caption text-kin-muted">{report.reason}</p>}
            </div>
          )}

          {blocked && (
            <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
              {headline && (
                <p className="flex items-start gap-1.5 text-body text-kin-text">
                  <IconAlert size={13} className="mt-0.5 flex-none text-kin-orange-ink" />
                  <span>{headline}</span>
                </p>
              )}
              {/*
                The machine's own sentence, kept under the headline: it names the
                branch and the files, which a sentence written here could only
                guess at. A code nobody has a sentence for is shown as itself,
                because inventing one for it would be this side guessing twice.
              */}
              <p
                className={
                  headline
                    ? "mt-1 text-caption leading-prose text-kin-muted"
                    : "flex items-start gap-1.5 text-body text-kin-text"
                }
              >
                {!headline && (
                  <IconAlert size={13} className="mt-0.5 flex-none text-kin-orange-ink" />
                )}
                <span>
                  {headline ? `${tr("publish.said")} ` : ""}
                  {report?.reason || tr("publish.blocked", { code: blocked })}
                </span>
              </p>
              {blocked === "default_branch" && (
                <button
                  type="button"
                  onClick={() => void escape()}
                  disabled={!canPublish}
                  className="kin-btn-primary mt-2 !min-h-0 !py-1.5 !px-3 text-body disabled:opacity-50"
                >
                  {escaping && <IconSpinner size={13} strokeWidth={2} />}
                  {tr("publish.escape")}
                </button>
              )}
            </div>
          )}

          {error && (
            <p className="flex items-start gap-1.5 text-body text-kin-red-ink">
              <IconAlert size={13} className="mt-0.5 flex-none" />
              <span>{error}</span>
            </p>
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void publish({ title: title.trim(), body })}
              disabled={!canPublish}
              className="kin-btn-primary !min-h-0 !py-1.5 !px-3.5 text-body disabled:opacity-50"
            >
              {busy && <IconSpinner size={13} strokeWidth={2} />}
              {busy ? tr("publish.publishing") : tr("publish.action")}
            </button>
            {wordsRefusal && (
              <span className="text-caption text-kin-muted">{tr(wordsRefusal)}</span>
            )}
          </div>
        </div>
      </div>
    </PanelSurface>
  );
}

/**
 * One line of the confirmation.
 *
 * A value the Hub does not know yet is drawn as not known rather than as empty:
 * "branch: (nothing)" reads as a fact about the checkout, and the honest answer
 * is that nobody has asked the machine holding it.
 */
function Row({
  label,
  value,
  full,
  mono = false,
}: {
  label: string;
  value: string;
  full?: string;
  mono?: boolean;
}) {
  const tr = useT();
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[68px] flex-none text-caption text-kin-muted">{label}</dt>
      <dd
        className={[
          "min-w-0 flex-1 truncate text-kin-text",
          mono ? "font-mono text-caption" : "",
        ].join(" ")}
        title={full || value}
      >
        {value || tr("publish.unknown")}
      </dd>
    </div>
  );
}
