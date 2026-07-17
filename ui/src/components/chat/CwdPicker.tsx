import { useEffect, useRef, useState } from "react";
import { recentCwds } from "../../api/client";
import { useT } from "../../i18n/react";
import { isKinDesktop, pickDirectory } from "../../lib/desktop";
import { projectLabel, shortPath } from "../../lib/paths";

type Props = {
  cwd: string;
  onChange: (cwd: string) => void;
  /** Once a real task has started, cwd is locked. */
  locked?: boolean;
  className?: string;
};

/**
 * Working-directory control under the composer (Claude/Codex-style).
 * - Electron: native macOS/Windows/Linux folder dialog via window.kinDesktop
 * - Browser: manual path + recent cwds (web cannot expose absolute paths)
 */
export default function CwdPicker({ cwd, onChange, locked, className }: Props) {
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
          "flex items-center gap-2 text-[12px] text-kin-muted px-0.5",
          className,
        ].join(" ")}
        title={cwd}
      >
        <FolderIcon />
        <span className="font-medium text-kin-secondary">{projectLabel(cwd)}</span>
        <span className="truncate font-mono text-[11px] opacity-80">
          {shortPath(cwd, 48)}
        </span>
        <span className="ml-auto text-[10.5px] uppercase tracking-wide opacity-70">
          {tr("cwd.locked")}
        </span>
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
        "flex items-center gap-2 text-[12px] text-kin-muted px-0.5 rounded-md",
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
        className="flex-1 min-w-0 flex items-center gap-2 text-left hover:text-kin-secondary py-1 rounded-md hover:bg-[var(--kin-fill)] transition-colors disabled:opacity-50"
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
          <>
            <span className="font-medium text-kin-secondary">
              {projectLabel(cwd)}
            </span>
            <span className="truncate font-mono text-[11px] opacity-80">
              {shortPath(cwd, 48)}
            </span>
          </>
        ) : (
          <span className="text-kin-orange">
            {desktop ? tr("cwd.chooseFolder") : tr("cwd.chooseCwd")}
          </span>
        )}
      </button>

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
