import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { recentCwds } from "../../api/client";
import { useT } from "../../i18n/react";
import { isKinDesktop, pickDirectory } from "../../lib/desktop";
import { projectLabel, shortPath } from "../../lib/paths";
import { useAppStore } from "../../store/appStore";

type Props = {
  cwd: string;
  onChange: (cwd: string) => void;
  /** Once a real task has started, cwd is locked. */
  locked?: boolean;
  /** Single-row footer: tighter path chip. */
  compact?: boolean;
  className?: string;
};

/**
 * Working-directory control under the composer (Claude/Codex-style).
 * - Electron: native macOS/Windows/Linux folder dialog via window.kinDesktop
 * - Browser: manual path + recent cwds (web cannot expose absolute paths)
 */
export default function CwdPicker({ cwd, onChange, locked, compact, className }: Props) {
  const tr = useT();
  const [editing, setEditing] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [draft, setDraft] = useState(cwd);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const desktop = isKinDesktop();

  useEffect(() => {
    setDraft(cwd);
  }, [cwd]);

  useEffect(() => {
    recentCwds()
      .then(setDirs)
      .catch(() => setDirs([]));
  }, []);

  useEffect(() => {
    if (!editing) return;
    recentCwds()
      .then(setDirs)
      .catch(() => setDirs([]));
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [editing]);

  function commit(value: string) {
    const v = value.trim();
    if (v) onChange(v);
    setEditing(false);
  }

  async function openNativePicker() {
    if (locked || busy) return;
    setBusy(true);
    try {
      const path = await pickDirectory({
        defaultPath: cwd || undefined,
        title: tr("cwd.selectTitle"),
      });
      if (path) onChange(path);
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <div
        className={[
          "flex items-center text-kin-muted min-w-0",
          compact ? "gap-1.5 text-[11px] px-0" : "gap-2 text-[12px] px-0.5",
          className,
        ].join(" ")}
      >
        <FolderIcon />
        <span className="font-medium text-kin-secondary shrink-0">
          {projectLabel(cwd)}
        </span>
        {cwd && <PathHoverTag cwd={cwd} compact={compact} />}
        {!compact && (
          <span className="ml-auto text-[10.5px] uppercase tracking-wide opacity-70">
            {tr("cwd.locked")}
          </span>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div className={["flex items-center gap-2", className].join(" ")}>
        <FolderIcon />
        <input
          ref={inputRef}
          list="kin-cwd-suggestions"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            }
            if (e.key === "Escape") {
              setDraft(cwd);
              setEditing(false);
            }
          }}
          onBlur={() => commit(draft)}
          placeholder={
            desktop
              ? "/Users/… or use Browse"
              : processPlaceholder()
          }
          className="flex-1 min-w-0 rounded-md border border-kin-blue/40 bg-[var(--kin-fill)] px-2 py-1 text-[12.5px] font-mono text-kin-text outline-none"
        />
        <datalist id="kin-cwd-suggestions">
          {dirs.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        {desktop && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openNativePicker()}
            className="flex-none text-[11.5px] font-medium text-kin-blue px-1.5 py-1"
          >
            {tr("cwd.browseEllipsis")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={[
        "flex items-center text-kin-muted rounded-md min-w-0",
        compact ? "gap-1.5 text-[11px] px-0" : "gap-2 text-[12px] px-0.5",
        className,
      ].join(" ")}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (desktop) void openNativePicker();
          else setEditing(true);
        }}
        className={[
          "min-w-0 flex items-center text-left rounded-md hover:text-kin-secondary hover:bg-[var(--kin-fill)] transition-colors disabled:opacity-50",
          compact ? "gap-1.5 py-0.5 px-1 flex-none" : "gap-2 py-1 flex-none",
        ].join(" ")}
        title={
          cwd
            ? tr("cwd.workingDir", { path: cwd })
            : desktop
              ? tr("cwd.browseForFolder")
              : tr("cwd.setCwd")
        }
      >
        <FolderIcon />
        {cwd ? (
          <span className="font-medium text-kin-secondary">
            {projectLabel(cwd)}
          </span>
        ) : (
          <span className="text-kin-orange">
            {desktop ? tr("cwd.chooseFolder") : tr("cwd.chooseCwd")}
          </span>
        )}
      </button>
      {cwd && <PathHoverTag cwd={cwd} compact={compact} />}

      {desktop ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void openNativePicker()}
            className="flex-none text-[11px] font-medium text-kin-blue hover:underline disabled:opacity-50"
          >
            {busy ? "…" : tr("cwd.browse")}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-none text-[11px] text-kin-muted hover:text-kin-secondary"
            title={tr("cwd.typePath")}
          >
            {tr("cwd.edit")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex-none text-[11px] text-kin-blue opacity-80"
        >
          {tr("cwd.change")}
        </button>
      )}

      {dirs.length > 0 && !cwd && (
        <div className="hidden" />
      )}
    </div>
  );
}

function processPlaceholder(): string {
  // Best-effort hint by user agent (browser only).
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Win/i.test(ua)) return "C:\\Users\\…\\project";
  return "/Users/…/project";
}

/**
 * Abbreviated path with a hover card showing the full, copyable path.
 * Portaled to <body> — the footer row scrolls horizontally
 * (overflow-x-auto), which would otherwise clip an absolutely-positioned
 * child on the vertical axis too.
 */
function PathHoverTag({ cwd, compact }: { cwd: string; compact?: boolean }) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [rect, setRect] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  function cancelHide() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function show() {
    cancelHide();
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) {
      const cardWidth = 340;
      const left = Math.min(
        Math.max(8, r.left),
        Math.max(8, window.innerWidth - cardWidth - 8),
      );
      setRect({ left, bottom: window.innerHeight - r.top + 4 });
    }
  }

  function scheduleHide() {
    cancelHide();
    closeTimerRef.current = window.setTimeout(() => setRect(null), 120);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(cwd);
      pushToast(tr("cwd.copied"), "info");
    } catch {
      pushToast(tr("cwd.copyFailed"), "error");
    }
  }

  return (
    <span
      ref={anchorRef}
      className="relative min-w-0 flex-1 truncate rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kin-blue/50"
      role="button"
      tabIndex={0}
      aria-label={`${tr("cwd.workingDir", { path: cwd })}. ${tr("cwd.copy")}`}
      title={cwd}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
      onClick={() => void copy()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void copy();
        } else if (event.key === "Escape") {
          cancelHide();
          setRect(null);
        }
      }}
    >
      <span
        className={[
          "truncate font-mono opacity-80",
          compact ? "text-[10.5px]" : "text-[11px]",
        ].join(" ")}
      >
        {shortPath(cwd, compact ? 18 : 48)}
      </span>
      {rect &&
        createPortal(
          <span
            className="fixed z-50 flex max-w-[340px] items-center gap-1.5 rounded-lg border border-[var(--kin-hairline-strong)] bg-kin-panel px-2 py-1 shadow-lg"
            style={{ left: rect.left, bottom: rect.bottom }}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
            onFocus={cancelHide}
            onBlur={scheduleHide}
          >
            <span className="max-w-[280px] truncate font-mono text-[11px] text-kin-secondary">
              {cwd}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void copy();
              }}
              className="flex-none text-[10.5px] font-medium text-kin-blue hover:underline"
            >
              {tr("cwd.copy")}
            </button>
          </span>,
          document.body,
        )}
    </span>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none opacity-70"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}
