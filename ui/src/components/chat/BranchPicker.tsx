import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ApiError,
  checkoutGitBranch,
  listGitBranches,
  type GitBranchStatus,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { branchAnswerApplies, isDirtyRefusal } from "../../lib/devices";
import { useAppStore } from "../../store/appStore";

/**
 * Viewport coordinates for the branch list.
 *
 * The list cannot be laid out relative to its trigger: the trigger lives in the
 * composer's `overflow-x-auto` strip, and in CSS an `overflow-x` other than
 * `visible` forces `overflow-y` to compute to `auto` too — so a ~44px-tall strip
 * clipped the 313px panel away entirely, and tapping the branch chip on a phone
 * opened a list that painted nowhere (measured: the panel's rect was
 * [342,531,288,313] while `elementFromPoint` inside it hit the chat behind).
 * Fixed positioning is measured from the viewport and escapes that clipping;
 * nothing between here and <body> sets a transform, filter or `contain`, so
 * `fixed` really does mean the viewport.
 */
type Anchor = { left: number; bottom: number; width: number; maxHeight: number };

/** The panel's design width, and the least gutter we will leave at a screen edge. */
const PANEL_WIDTH = 288;
const EDGE = 8;

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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => filterRef.current?.focus(), 20);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open]);

  /**
   * Where to put the list, in viewport coordinates.
   *
   * Measured in a layout effect so the first painted frame is already in place
   * — a `useEffect` would show one frame of the panel at 0,0. Re-measured on
   * resize and on scroll *in the capture phase*, because the strip the trigger
   * sits in scrolls independently of the window.
   */
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const vw = window.innerWidth;
      const width = Math.min(PANEL_WIDTH, vw - EDGE * 2);
      const next = {
        width,
        left: Math.min(Math.max(EDGE, trigger.left), Math.max(EDGE, vw - width - EDGE)),
        // `bottom` rather than `top`: the list opens upward from a footer, and
        // anchoring the far edge keeps it attached when it has to shrink.
        bottom: window.innerHeight - trigger.top + 6,
        // The room above the trigger, so the list is wholly on screen; it
        // scrolls inside whatever height is left. The 120px floor wins only in
        // a window under ~270px tall, where the panel can overhang the top
        // edge — a two-row list is worse than an overhang at that size.
        maxHeight: Math.max(120, trigger.top - 14),
      };
      // `scroll` fires per frame while a finger is moving; returning the same
      // object lets React skip the re-render when the anchor has not moved.
      setAnchor((prev) =>
        prev &&
        prev.left === next.left &&
        prev.bottom === next.bottom &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

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
          compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-[11.5px]",
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
      ref={rootRef}
      className={[
        "relative flex items-center min-w-0",
        compact ? "gap-1" : "gap-1.5",
        className ?? "",
      ].join(" ")}
    >
      {!compact && (
        <span className="text-[11.5px] text-kin-muted flex-none">{tr("branch.label")}</span>
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
            ? "gap-1 px-1.5 py-0.5 text-[11px] font-medium transition-colors"
            : "gap-1.5 px-2 py-0.5 text-[11.5px] font-medium transition-colors",
          "hover:border-kin-blue/40 hover:text-kin-secondary",
          open ? "border-kin-blue/50 text-kin-blue" : "text-kin-secondary",
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

      {open && anchor && (
        <div
          style={{
            left: anchor.left,
            bottom: anchor.bottom,
            width: anchor.width,
            maxHeight: anchor.maxHeight,
          }}
          className={[
            "fixed z-50 flex flex-col",
            "rounded-xl border border-[var(--kin-hairline-strong)]",
            "bg-[var(--kin-elevated)] shadow-lg overflow-hidden",
          ].join(" ")}
          role="listbox"
          aria-label={tr("branch.listLabel")}
        >
          <div className="flex-none p-1.5 border-b border-[var(--kin-hairline)]">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={tr("branch.filter")}
              className={[
                "w-full rounded-md border border-[var(--kin-hairline)]",
                "bg-[var(--kin-fill)] px-2 py-1 text-[12px] font-mono",
                "text-kin-primary placeholder:text-kin-muted outline-none",
                "focus:border-kin-blue/50",
              ].join(" ")}
              disabled={locked || busy}
            />
          </div>
          <ul className="flex-1 min-h-0 max-h-56 overflow-y-auto py-1">
            {branches.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-kin-muted">{tr("branch.empty")}</li>
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
                        "w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px]",
                        "font-mono transition-colors",
                        active
                          ? "bg-kin-blue-soft text-kin-blue"
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
            <div className="flex-none px-3 py-1.5 border-t border-[var(--kin-hairline)] text-[11px] text-kin-muted">
              {tr("branch.sessionLocked")}
            </div>
          )}
          {!locked && status.dirty && (
            <div className="flex-none px-3 py-1.5 border-t border-[var(--kin-hairline)] text-[11px] text-kin-orange">
              {tr("branch.dirty")}
            </div>
          )}
        </div>
      )}
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
