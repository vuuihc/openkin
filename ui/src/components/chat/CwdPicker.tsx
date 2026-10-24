import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { recentCwds } from "../../api/client";
import { useT } from "../../i18n/react";
import { cwdPickerMode } from "../../lib/devices";
import { isKinDesktop, pickDirectory } from "../../lib/desktop";
import { projectLabel, shortPath } from "../../lib/paths";
import { useAppStore } from "../../store/appStore";
import MachineBrowser from "./MachineBrowser";

function sameDirs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((dir, i) => dir === b[i]);
}

type Props = {
  cwd: string;
  onChange: (cwd: string) => void;
  /** Once a real task has started, cwd is locked. */
  locked?: boolean;
  /** Single-row footer: tighter path chip. */
  compact?: boolean;
  className?: string;
  /**
   * Directories to offer instead of this console's recent ones. A cwd is only
   * meaningful on the machine that owns it, so a form aimed at another machine
   * passes that machine's own roots.
   */
  suggestions?: string[];
  /**
   * The machine this directory is on. Empty or "self" is the daemon serving this
   * console.
   *
   * It decides which of the two ways of choosing a directory is offered, and the
   * rule is not "desktop or not" but "can this console see that filesystem or
   * not". The native dialog reads the filesystem the console is running on, so
   * it can only answer for this machine; for any other machine the question goes
   * to that machine instead, and the answer is what it says its own directories
   * are.
   */
  device?: string;
};

/**
 * Working-directory control under the composer (Claude/Codex-style).
 * - Electron on this machine: native macOS/Windows/Linux folder dialog
 * - Anywhere else (browser, phone, another machine): browse that machine's own
 *   directories, with a manual path as the way out for anyone who knows it
 */
export default function CwdPicker({
  cwd,
  onChange,
  locked,
  compact,
  className,
  suggestions,
  device,
}: Props) {
  const tr = useT();
  const [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [draft, setDraft] = useState(cwd);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const desktop = isKinDesktop();
  // A native dialog answers about this machine's filesystem and no other, so a
  // form aimed at a remote machine browses even on the desktop.
  const native = cwdPickerMode(desktop, device) === "native";

  useEffect(() => {
    setDraft(cwd);
  }, [cwd]);

  useEffect(() => {
    if (suggestions) {
      // Keep the previous array when the contents match: a fresh identity every
      // render would re-render forever.
      setDirs((prev) => (sameDirs(prev, suggestions) ? prev : suggestions));
      return;
    }
    recentCwds()
      .then(setDirs)
      .catch(() => setDirs([]));
  }, [suggestions]);

  useEffect(() => {
    if (!editing) return;
    if (!suggestions) {
      recentCwds()
        .then(setDirs)
        .catch(() => setDirs([]));
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [editing, suggestions]);

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
          compact ? "gap-1.5 text-caption px-0" : "gap-2 text-body px-0.5",
          className,
        ].join(" ")}
      >
        <FolderIcon />
        {/* The label keeps its width and the path tag beside it truncates: a
            directory's own name is the part worth reading in a tight row. */}
        <span className="font-medium text-kin-secondary shrink-0">{projectLabel(cwd)}</span>
        {cwd && <PathHoverTag cwd={cwd} compact={compact} />}
        {!compact && (
          <span className="ml-auto text-caption uppercase tracking-label opacity-70">
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
          placeholder={native ? "/Users/… or use Browse" : processPlaceholder()}
          className="flex-1 min-w-0 rounded-md border border-kin-blue/40 bg-[var(--kin-fill)] px-2 py-1 text-body font-mono text-kin-text outline-none"
        />
        <datalist id="kin-cwd-suggestions">
          {dirs.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        {native ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openNativePicker()}
            className="flex-none text-caption font-medium text-kin-blue-ink px-1.5 py-1"
          >
            {tr("cwd.browseEllipsis")}
          </button>
        ) : (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setEditing(false);
              setBrowsing(true);
            }}
            className="flex-none text-caption font-medium text-kin-blue-ink px-1.5 py-1"
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
        compact ? "gap-1.5 text-caption px-0" : "gap-2 text-body px-0.5",
        className,
      ].join(" ")}
    >
      {browsing && (
        <MachineBrowser
          device={device}
          initialPath={cwd}
          onClose={() => setBrowsing(false)}
          onTypePath={() => {
            setBrowsing(false);
            setEditing(true);
          }}
          onPick={(path) => {
            setBrowsing(false);
            onChange(path);
          }}
        />
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (native) void openNativePicker();
          else setBrowsing(true);
        }}
        className={[
          "min-w-0 flex items-center text-left rounded-md hover:text-kin-secondary hover:bg-[var(--kin-fill)] transition-colors disabled:opacity-50",
          compact ? "gap-1.5 py-0.5 px-1 flex-none" : "gap-2 py-1 flex-none",
        ].join(" ")}
        title={
          cwd
            ? tr("cwd.workingDir", { path: cwd })
            : native
              ? tr("cwd.browseForFolder")
              : tr("cwd.setCwd")
        }
      >
        <FolderIcon />
        {cwd ? (
          <span className="font-medium text-kin-secondary">{projectLabel(cwd)}</span>
        ) : (
          <span className="text-kin-orange-ink">
            {native ? tr("cwd.chooseFolder") : tr("cwd.chooseCwd")}
          </span>
        )}
      </button>
      {cwd && <PathHoverTag cwd={cwd} compact={compact} />}

      {native ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void openNativePicker()}
            className="flex-none text-caption font-medium text-kin-blue-ink hover:underline disabled:opacity-50"
          >
            {busy ? "…" : tr("cwd.browse")}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-none text-caption text-kin-muted hover:text-kin-secondary"
            title={tr("cwd.typePath")}
          >
            {tr("cwd.edit")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            className="flex-none text-caption font-medium text-kin-blue-ink hover:underline"
          >
            {tr("cwd.browse")}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-none text-caption text-kin-muted hover:text-kin-secondary"
            title={tr("cwd.typePath")}
          >
            {tr("cwd.edit")}
          </button>
        </>
      )}

      {dirs.length > 0 && !cwd && <div className="hidden" />}
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
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - cardWidth - 8));
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
      className="relative min-w-0 flex-1 truncate rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kin-focus-ring"
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
      <span className="truncate font-mono opacity-80 text-caption">
        {shortPath(cwd, compact ? 18 : 48)}
      </span>
      {rect &&
        createPortal(
          <span
            className="fixed z-50 flex max-w-[340px] items-center gap-1.5 rounded-lg border border-[var(--kin-hairline-strong)] bg-kin-panel px-2 py-1 shadow-e2"
            style={{ left: rect.left, bottom: rect.bottom }}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
            onFocus={cancelHide}
            onBlur={scheduleHide}
          >
            <span className="max-w-[280px] truncate font-mono text-caption text-kin-secondary">
              {cwd}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void copy();
              }}
              className="flex-none text-caption font-medium text-kin-blue-ink hover:underline"
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
