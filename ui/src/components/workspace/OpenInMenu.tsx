import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/react";
import {
  isKinDesktop,
  listExternalApps,
  openInExternalApp,
  type ExternalApp,
} from "../../lib/desktop";
import { toAbsoluteWorkspacePath } from "../../lib/paths";
import { IconChevron, IconExternal } from "../icons";

type Props = {
  /** Task workspace root (absolute). Prefer file.root when available. */
  root: string;
  /** Workspace-relative path currently shown in the viewer. */
  relativePath: string | null;
};

/**
 * Desktop-only "Open in…" menu. Detects installed editors / Finder and opens
 * the absolute file path. Hidden in the browser SPA.
 */
export default function OpenInMenu({ root, relativePath }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<ExternalApp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const desktop = isKinDesktop();
  const absPath =
    relativePath && root
      ? toAbsoluteWorkspacePath(root, relativePath)
      : null;

  const ensureApps = useCallback(async () => {
    if (apps) return apps;
    const next = await listExternalApps();
    setApps(next);
    return next;
  }, [apps]);

  useEffect(() => {
    if (!open) return;
    void ensureApps();
  }, [open, ensureApps]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!desktop || !absPath) return null;

  const labelFor = (app: ExternalApp): string => {
    const key = `workspace.openWith.${app.labelKey}`;
    const translated = t(key);
    // useT returns the key path when missing — fall back to probe label.
    if (!translated || translated === key) return app.label;
    return translated;
  };

  const handleOpen = async (app: ExternalApp) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await openInExternalApp(absPath, app.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
  };

  return (
    <div className="relative flex-none" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!absPath}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-[11.5px] text-kin-secondary hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-colors disabled:opacity-40"
        title={t("workspace.openWith.title")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconExternal size={12} />
        <span className="hidden sm:inline">{t("workspace.openWith.button")}</span>
        <IconChevron size={12} className={open ? "rotate-[-90deg]" : "rotate-90"} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[168px] max-w-[240px] rounded-lg border border-kin-border bg-kin-elevated shadow-window py-1"
        >
          {apps === null && (
            <div className="px-3 py-2 text-[12px] text-kin-muted">
              {t("workspace.openWith.detecting")}
            </div>
          )}
          {apps && apps.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-kin-muted">
              {t("workspace.openWith.none")}
            </div>
          )}
          {apps?.map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void handleOpen(app)}
              className="w-full text-left px-3 py-1.5 text-[12.5px] text-kin-text hover:bg-[var(--kin-fill-strong)] transition-colors disabled:opacity-50"
            >
              {labelFor(app)}
            </button>
          ))}
          {error && (
            <div className="px-3 py-1.5 text-[11px] text-kin-red border-t border-[var(--kin-hairline)]">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
