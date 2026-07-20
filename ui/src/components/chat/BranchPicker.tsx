import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  checkoutGitBranch,
  listGitBranches,
  type GitBranchStatus,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { useAppStore } from "../../store/appStore";

type Props = {
  cwd: string;
  /** When true, branch can be viewed but not switched (e.g. task already started). */
  locked?: boolean;
  className?: string;
};

/**
 * Git branch display + switcher next to the working-directory control.
 * Hidden when cwd is empty or not a git repository.
 */
export default function BranchPicker({ cwd, locked, className }: Props) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [status, setStatus] = useState<GitBranchStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path: string) => {
    if (!path.trim()) {
      setStatus(null);
      return;
    }
    try {
      const st = await listGitBranches(path.trim());
      setStatus(st);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load(cwd);
    setOpen(false);
    setFilter("");
  }, [cwd, load]);

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

  if (!cwd.trim() || !status?.is_git) {
    return null;
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
      await checkoutGitBranch(cwd.trim(), name);
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
        if (e.status === 409) {
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
      className={["relative flex items-center gap-1.5 min-w-0", className ?? ""].join(
        " ",
      )}
    >
      <span className="text-[11.5px] text-kin-muted flex-none">
        {tr("branch.label")}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setOpen((v) => !v);
          void load(cwd);
        }}
        className={[
          "inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-lg border",
          "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)]",
          "px-2 py-0.5 text-[11.5px] font-medium transition-colors",
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

      {open && (
        <div
          className={[
            "absolute left-0 bottom-full mb-1.5 z-50",
            "w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-[var(--kin-hairline-strong)]",
            "bg-[var(--kin-elevated)] shadow-lg overflow-hidden",
          ].join(" ")}
          role="listbox"
          aria-label={tr("branch.listLabel")}
        >
          <div className="p-1.5 border-b border-[var(--kin-hairline)]">
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
          <ul className="max-h-56 overflow-y-auto py-1">
            {branches.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-kin-muted">
                {tr("branch.empty")}
              </li>
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
            <div className="px-3 py-1.5 border-t border-[var(--kin-hairline)] text-[11px] text-kin-muted">
              {tr("branch.sessionLocked")}
            </div>
          )}
          {!locked && status.dirty && (
            <div className="px-3 py-1.5 border-t border-[var(--kin-hairline)] text-[11px] text-kin-orange">
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
      className={[
        "flex-none opacity-60 transition-transform",
        open ? "rotate-180" : "",
      ].join(" ")}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
