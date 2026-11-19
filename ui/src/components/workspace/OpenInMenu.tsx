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
import Button from "../ui/Button";
import Menu, { type MenuItem } from "../ui/Menu";

type Props = {
  /** Task workspace root (absolute). Prefer file.root when available. */
  root: string;
  /** Workspace-relative path currently shown in the viewer. */
  relativePath: string | null;
  /**
   * Keep the text label at every width. The panel's file headers are tight and
   * drop the word below `sm`; the download pane has room, and an icon pair with
   * no word would say less than the button it sits beside.
   */
  alwaysShowLabel?: boolean;
};

/** A row that exists only to say something; the menu will not let it be chosen. */
function note(id: string, label: string): MenuItem {
  return { id, label, disabled: true, onSelect: () => {} };
}

/**
 * Desktop-only "Open in…" menu. Detects installed editors / Finder and opens
 * the absolute file path. Hidden in the browser SPA.
 *
 * The layer is the console's shared `Menu`, so Escape, outside pointers,
 * viewport flipping and focus return are the same as every other picker —
 * this component keeps only the desktop knowledge: which apps exist, which
 * one the reader chose, and what to do when the bridge refuses.
 */
export default function OpenInMenu({ root, relativePath, alwaysShowLabel = false }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<ExternalApp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const desktop = isKinDesktop();
  const absPath = relativePath && root ? toAbsoluteWorkspacePath(root, relativePath) : null;

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

  const appRows: MenuItem[] =
    apps === null
      ? [note("detecting", t("workspace.openWith.detecting"))]
      : apps.length === 0
        ? [note("none", t("workspace.openWith.none"))]
        : apps.map((app) => ({
            id: app.id,
            label: labelFor(app),
            disabled: busy,
            onSelect: () => void handleOpen(app),
          }));

  // The failure note sits above the rows rather than replacing them: a bridge
  // that refused once must not cost the reader the rest of the menu session.
  const items: MenuItem[] = error !== null ? [note("error", error), ...appRows] : appRows;

  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        onClick={() => setOpen((v) => !v)}
        disabled={!absPath}
        title={t("workspace.openWith.title")}
        aria-label={t("workspace.openWith.button")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex-none gap-1 px-2 py-1 text-caption"
      >
        <IconExternal size={12} />
        <span className={alwaysShowLabel ? undefined : "hidden sm:inline"}>
          {t("workspace.openWith.button")}
        </span>
        <IconChevron size={12} className={open ? "rotate-[-90deg]" : "rotate-90"} />
      </Button>
      <Menu
        // Keyed on "the list is still loading": the layer moves focus only
        // when the panel first appears, and on the first open it appears with
        // nothing but the inert detecting row. Remounting when the rows land
        // lets the layer put focus on the first real row, so arrows, Home/End,
        // Enter and typeahead work immediately instead of after a Tab.
        key={apps === null ? "detecting" : "ready"}
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        label={t("workspace.openWith.button")}
        items={items}
        align="right"
      />
    </>
  );
}
