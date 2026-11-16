import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  checkoutGitBranch,
  listGitBranches,
  type GitBranchStatus,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { branchAnswerApplies, isDirtyRefusal } from "../../lib/devices";
import { useAppStore } from "../../store/appStore";
import Popover from "../ui/Popover";

type Props = {
  cwd: string;
  /**
   * The machine `cwd` is on. Omitted or "self" is the daemon serving this
   * console; anything else is a machine the Hub forwards the question to, and
   * the answer is then about that machine's checkout rather than this one's.
   */
  device?: string;
  /** When true, branch can be viewed but not switched (e.g. task already started). */
  locked?: boolean;
  /** Single-row footer: hide branch label. */
  compact?: boolean;
  className?: string;
};

/** One answer about one checkout, kept together with the question it answered. */
type Answered = {
  cwd: string;
  device?: string;
  status: GitBranchStatus | null;
  unreadable: string;
};

/**
 * Git branch display + switcher next to the working-directory control.
 * Hidden when cwd is empty or not a git repository.
 */
export default function BranchPicker({ cwd, device, locked, compact, className }: Props) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Which question is the current one.
   *
   * Two answers can be in the air at once — the machine is switched while the
   * first question is still out — and the machine that answers last is not
   * necessarily the machine that was asked last. A counter, not a flag: an
   * answer is only the answer if nothing has been asked since.
   */
  const asked = useRef(0);

  const load = useCallback(
    async (path: string) => {
      const seq = (asked.current += 1);
      if (!path.trim()) {
        setAnswered(null);
        return;
      }
      try {
        const st = await listGitBranches(path.trim(), device);
        if (seq !== asked.current) return;
        setAnswered({ cwd: path, device, status: st, unreadable: "" });
      } catch (e) {
        if (seq !== asked.current) return;
        // Kept, not dropped. "This directory is not a repository" and "the
        // machine holding it did not answer" draw the same way on screen — as
        // nothing — and only one of them is a fact. On a phone the second is
        // the common one: the machine was switched, or went to sleep.
        setAnswered({
          cwd: path,
          device,
          status: null,
          unreadable: e instanceof ApiError ? e.message : tr("branch.unreadableHint"),
        });
      }
    },
    [device, tr],
  );

  useEffect(() => {
    void load(cwd);
    setOpen(false);
    setFilter("");
  }, [cwd, load]);

  // An answer is only good for the checkout it was about. While the new question
  // is in flight — another directory, or the same path on another machine —
  // there is nothing to draw yet, and drawing the previous answer would describe
  // a checkout nobody asked about: on a path that exists on both machines, that
  // is a branch name with no error and no reason to doubt it.
  const live = answered && branchAnswerApplies(answered, { cwd, device }) ? answered : null;
  const status = live?.status ?? null;
  const unreadable = live?.unreadable ?? "";

  if (!cwd.trim()) {
    return null;
  }
  if (!status?.is_git) {
    // A directory that is not a repository is answered and stays hidden — most
    // directories are not, and a chip saying so would be noise. A directory
    // nobody answered about is not the same thing, and on the one client that
    // cannot open a terminal, silence would read as "no branches here".
    if (!unreadable) {
      return null;
    }
    return (
      <span
        className={[
          "inline-flex items-center gap-1 min-w-0 max-w-full flex-none",
          "rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)]",
          compact ? "px-1.5 py-0.5 text-caption" : "px-2 py-0.5 text-caption",
          "text-kin-muted",
          className ?? "",
        ].join(" ")}
        title={unreadable}
      >
        <BranchIcon />
        <span className="truncate">{tr("branch.unreadable")}</span>
      </span>
    );
  }

  const label = status.detached
    ? tr("branch.detached", { rev: status.current || "?" })
    : status.current || tr("branch.unknown");

  const q = filter.trim().toLowerCase();
  const branches = (status.branches ?? []).filter((b) =>
    q ? b.name.toLowerCase().includes(q) : true,
  );

  async function switchTo(name: string) {
    if (locked || busy || name === status?.current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await checkoutGitBranch(cwd.trim(), name, device);
      await load(cwd);
      setOpen(false);
      setFilter("");
      pushToast(tr("branch.switched", { name }), "info");
    } catch (e) {
      let msg = tr("branch.switchFailed");
      if (e instanceof ApiError) {
        try {
          const body = JSON.parse(e.message) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          if (e.message) msg = e.message;
        }
        // 409 from this machine is its dirty checkout — the one refusal worth
        // rewording, because it is this daemon's own sentence and the toast is
        // translated. From another machine 409 is that machine being away, and
        // its answer is already the right words for it.
        if (isDirtyRefusal(e.status, device)) {
          msg = tr("branch.dirty");
        }
      } else if (e instanceof Error && e.message) {
        msg = e.message;
      }
      pushToast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={[
        "relative flex items-center min-w-0",
        compact ? "gap-1" : "gap-1.5",
        className ?? "",
      ].join(" ")}
    >
      {!compact && (
        <span className="text-caption text-kin-muted flex-none">{tr("branch.label")}</span>
      )}
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setOpen((v) => !v);
          void load(cwd);
        }}
        className={[
          "inline-flex items-center min-w-0 max-w-full rounded-lg border",
          "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)]",
          compact
            ? "gap-1 px-1.5 py-0.5 text-caption font-medium transition-colors"
            : "gap-1.5 px-2 py-0.5 text-caption font-medium transition-colors",
          "hover:border-kin-blue/40 hover:text-kin-secondary",
          open ? "border-kin-blue/50 text-kin-blue-ink" : "text-kin-secondary",
          busy ? "opacity-60" : "",
        ].join(" ")}
        title={
          status.dirty
            ? tr("branch.dirtyHint")
            : locked
              ? tr("branch.lockedHint")
              : tr("branch.switchHint")
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <BranchIcon />
        <span className="truncate font-mono">{busy ? "…" : label}</span>
        {status.dirty && (
          <span
            className="flex-none w-1.5 h-1.5 rounded-full bg-kin-orange"
            title={tr("branch.dirtyHint")}
            aria-hidden
          />
        )}
        <ChevronIcon open={open} />
      </button>

      {/*
        The composer's control row is an `overflow-x-auto` strip, which in CSS
        also clips the vertical axis. The shared layer portals to <body> and
        measures from the viewport, so the list escapes that strip; it also owns
        outside press, one-layer Escape, focus into the filter and Tab
        containment, so this file no longer carries any of them.
      */}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFilter("");
        }}
        triggerRef={triggerRef}
        label={tr("branch.listLabel")}
        placement="above"
        align="right"
        width={288}
        maxHeight={360}
        padded={false}
        className="flex flex-col overflow-hidden"
      >
        <div
          // eslint-disable-next-line kin/no-raw-overlay-role -- the branch list owns its option navigation inside the anchored picker
          role="listbox"
          aria-label={tr("branch.listLabel")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex-none p-1.5 border-b border-[var(--kin-hairline)]">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={tr("branch.filter")}
              className={[
                "w-full rounded-md border border-[var(--kin-hairline)]",
                "bg-[var(--kin-fill)] px-2 py-1 text-body font-mono",
                // Typed text is text, not a warning: `-orange-ink` here put the
                // filter in the same hue as the dirty-branch notice below it.
                "text-kin-text placeholder:text-kin-muted outline-none",
                "focus:border-kin-blue/50",
              ].join(" ")}
              disabled={locked || busy}
            />
          </div>
          <ul className="flex-1 min-h-0 max-h-56 overflow-y-auto py-1">
            {branches.length === 0 ? (
              <li className="px-3 py-2 text-body text-kin-muted">{tr("branch.empty")}</li>
            ) : (
              branches.map((b) => {
                const active = b.current || b.name === status.current;
                return (
                  <li key={b.name}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={locked || busy || active}
                      onClick={() => void switchTo(b.name)}
                      className={[
                        "w-full flex items-center gap-2 px-3 py-1.5 text-left text-body",
                        "font-mono transition-colors",
                        active
                          ? "bg-kin-blue/15 text-kin-blue-ink"
                          : "text-kin-secondary hover:bg-[var(--kin-fill)]",
                        locked || busy ? "cursor-default opacity-80" : "cursor-pointer",
                      ].join(" ")}
                    >
                      <span className="flex-none w-3 text-center opacity-70">
                        {active ? "●" : ""}
                      </span>
                      <span className="truncate flex-1 min-w-0">{b.name}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {locked && (
            <div className="flex-none px-3 py-1.5 border-t border-[var(--kin-hairline)] text-caption text-kin-muted">
              {tr("branch.sessionLocked")}
            </div>
          )}
          {!locked && status.dirty && (
            <div className="flex-none px-3 py-1.5 border-t border-[var(--kin-hairline)] text-caption text-kin-orange-ink">
              {tr("branch.dirty")}
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none opacity-80"
      aria-hidden
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={["flex-none opacity-60 transition-transform", open ? "rotate-180" : ""].join(" ")}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
