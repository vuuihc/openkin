import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isAuthenticated, listProjects, type Project } from "../api/client";
import { t } from "../i18n";
import { useMinWidth } from "../hooks/useMinWidth";
import { canLeaveScreen, runGuardedNavigation } from "../lib/leaveGuard";
import { phonePush } from "../lib/phoneNavigation";
import { useT } from "../i18n/react";
import { paletteEntries, type PaletteEntry } from "../lib/palette";
import type { Area } from "../lib/areas";
import type { PanelContext, PanelId } from "../lib/panels";
import { listRecipes, type RecipeId } from "../recipes/catalog";
import { launchRecipe } from "../recipes/launch";
import { PANEL_ICONS, PLACE_ICONS } from "./placeIcons";
import { IconFolder, IconSearch, type IconProps } from "./icons";
import { useAppStore } from "../store/appStore";

/**
 * One icon per area, keyed by the table's icon id.
 *
 * A `Record` over the union the table derives, like `PLACE_ICONS`: a new area
 * cannot ship as a grey question mark, because the compiler refuses this module
 * until its glyph exists. `projects` has no place glyph — it was not a place
 * before N2 — so it borrows the folder the shell already draws for a project.
 */
const AREA_ICONS: Record<Area["icon"], (p: IconProps) => ReactNode> = {
  sessions: PLACE_ICONS.sessions,
  projects: IconFolder,
  routines: PLACE_ICONS.routines,
  settings: PLACE_ICONS.settings,
};

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * Retained for the shell's signature; the palette no longer lists the draft.
   * The four areas own destinations and the draft is not one, so the row is
   * gone. Removing the prop touches `AppShell.tsx`, outside this slice's
   * footprint — it can go with the next shell change.
   */
  onNewChat: (approved?: boolean) => void;
  /** Opens (or closes) a panel, in whichever view the shell owns. */
  onTogglePanel: (id: PanelId) => void;
  /** What the panel table is asked about: the shell's own place, not a session. */
  panelCtx: PanelContext;
};

type Item = {
  kind: "action";
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
};

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <b className="font-bold">{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * ⌘K / Ctrl+K command palette (design 2b).
 * Sections: Actions · Project recipes.
 *
 * The palette is commands, not a second conversation list. It used to append
 * the newest chats and a transcript search under the actions, which meant a
 * Mac window had the sidebar list, the `/tasks` table and this list — three
 * places to type the same word. The one list is the sidebar; a conversation is
 * opened there, and the palette only goes places and runs commands.
 *
 * The Actions section is not written here. It is `paletteEntries(panelCtx)` — every
 * area the navigation lists, then every panel this context offers — so an area or
 * a panel added to its table turns up in this list by existing, rather than by
 * being remembered. The context is the shell's (no session in front), so the panel
 * rows here are the shell's panels; a session's own are opened from its header,
 * for the reason `paletteEntries` gives. What stays local is what a table cannot
 * hold: the copy (asked of the locale by the key the table names), the icons
 * (the area table's icon id, mapped by `AREA_ICONS`), and the closures a row
 * needs to actually go somewhere.
 */
export default function CommandPalette({
  open,
  onClose,
  onTogglePanel,
  panelCtx,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useMinWidth(768);
  const tr = useT();

  /**
   * Go somewhere, keeping the phone's history one level deep.
   *
   * Every phone screen's parent is the list (D2/R5), but the palette can open
   * a place or a conversation from any screen. Pushing there would make Back
   * return to the screen the reader just hopped from — the exact counterexample
   * R5 names — so on a phone, moving from anything but the list replaces the
   * current entry with the list first and pushes on top of it. The Mac keeps
   * ordinary browser history.
   */
  const go = useCallback(
    (to: string, approved = false) => {
      // Replacing the screen is still leaving it: a page holding unsaved text
      // gets the same question the back button asks. `approved` is only set by
      // a caller that already asked, so a confirm does not open twice.
      runGuardedNavigation(
        () => phonePush(navigate, location, to, { phone: !wide }),
        approved === true,
      );
    },
    [location, navigate, wide],
  );
  const pushToast = useAppStore((s) => s.pushToast);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState(0);
  const [launchingRecipe, setLaunchingRecipe] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated()) {
      setProjects([]);
      return;
    }
    try {
      const projectList = await listProjects("active").catch(() => [] as Project[]);
      setProjects(Array.isArray(projectList) ? projectList : []);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    void load();
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, load]);

  const items = useMemo((): Item[] => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);

    // The palette's own rows, from the tables. `hint` is the row's own shortcut
    // where one exists (`Ctrl+\`` on the terminal), which is why it travels with
    // the entry rather than being decided per kind here.
    const entryRuns = (entry: PaletteEntry): (() => void) => {
      if (entry.kind === "area") {
        return () => {
          // Ask before anything moves: leaving the screen through a destination
          // row is still leaving it, and a page holding unsaved text gets the
          // same question the back button asks.
          if (!canLeaveScreen()) return;
          onClose();
          go(entry.path, true);
        };
      }
      return () => {
        onClose();
        onTogglePanel(entry.id);
      };
    };

    const baseActions: Item[] = paletteEntries(panelCtx).map((entry) => {
      // Namespaced so an area and a panel that share a word cannot collide in
      // the React key list or in the icon lookup.
      const Icon = entry.kind === "area" ? AREA_ICONS[entry.icon] : PANEL_ICONS[entry.id];
      return {
        kind: "action" as const,
        id: `${entry.kind}:${entry.id}`,
        label: tr(entry.labelKey),
        hint: entry.kind === "panel" ? entry.hint : undefined,
        icon: <Icon size={16} />,
        run: entryRuns(entry),
      };
    });

    const actions: Item[] = baseActions.filter((a) => match(a.label));

    // Most recently active project with a root — recipes launch normal tasks (ADR 0013).
    const recipeProject = [...projects]
      .filter((p) => (p.roots?.[0] || "").trim())
      .sort((a, b) => (b.last_active_at || 0) - (a.last_active_at || 0))[0];

    const runRecipe = (id: RecipeId) => {
      if (!recipeProject || launchingRecipe) return;
      const cwd = (recipeProject.roots?.[0] || "").trim();
      if (!cwd) {
        pushToast(tr("projects.continueNeedRoot"), "error");
        return;
      }
      setLaunchingRecipe(true);
      void launchRecipe({
        id,
        cwd,
        project_id: recipeProject.id,
        ctx: {
          project_name: recipeProject.name,
          project_id: recipeProject.id,
          cwd,
          mode: recipeProject.mode,
        },
      })
        .then((task) => {
          onClose();
          go(`/tasks/${task.id}`);
        })
        .catch((e) => {
          pushToast(e instanceof Error ? e.message : tr("projects.recipeLaunchFailed"), "error");
        })
        .finally(() => setLaunchingRecipe(false));
    };

    const recipeActions: Item[] = recipeProject
      ? listRecipes()
          .map((r) => ({
            kind: "action" as const,
            id: `recipe:${r.id}`,
            label: `${(tr as (k: string) => string)(r.titleKey)} · ${recipeProject.name}`,
            hint: tr("projects.recipeSection"),
            // A recipe is a prompt with a name, not a place; the search glyph is
            // what it has always been drawn as.
            icon: <IconSearch size={16} />,
            run: () => runRecipe(r.id),
          }))
          .filter((a) => match(a.label) || match(a.hint || "") || match(recipeProject.name))
      : [];

    return [...actions, ...recipeActions];
  }, [
    go,
    launchingRecipe,
    onClose,
    onTogglePanel,
    panelCtx,
    projects,
    pushToast,
    query,
    tr,
  ]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[active];
        if (!item) return;
        item.run();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, navigate, onClose, query]);

  if (!open) return null;

  // The rows filter on the trimmed query, so the highlight has to look for the
  // same words -- a search typed with a trailing space would otherwise draw no
  // emphasis at all.
  const highlightQuery = query.trim();
  const actionItems = items.filter((i) => i.kind === "action");

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4 bg-black/55 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={tr("palette.title")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-palette rounded-2xl overflow-hidden bg-kin-panel/90 backdrop-blur-[50px] shadow-e3">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--kin-hairline)]">
          <IconSearch size={18} className="text-kin-muted flex-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("palette.search")}
            className="flex-1 bg-transparent text-title text-kin-text outline-none placeholder:text-kin-muted"
          />
          <kbd className="text-caption text-kin-muted border border-[var(--kin-hairline-strong)] rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>

        <div className="max-h-[min(360px,50vh)] overflow-y-auto kin-scroll p-2">
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-strong leading-5 text-kin-muted">
              {tr("palette.noMatches")}
            </p>
          )}

          {actionItems.length > 0 && (
            <>
              <div className="text-caption font-semibold uppercase tracking-label text-kin-muted px-2.5 pt-2 pb-1">
                {tr("palette.actions")}
              </div>
              {actionItems.map((item) => {
                flatIndex += 1;
                const idx = flatIndex;
                return (
                  <PaletteRow
                    key={item.id}
                    active={idx === active}
                    onHover={() => setActive(idx)}
                    onClick={() => item.run()}
                    icon={item.icon}
                    label={highlight(item.label, highlightQuery)}
                    hint={item.hint}
                  />
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  active,
  onHover,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onHover: () => void;
  onClick: () => void;
  icon: ReactNode;
  label: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={[
        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-strong",
        active ? "bg-kin-blue text-kin-on-brand" : "text-kin-text hover:bg-[var(--kin-fill)]",
      ].join(" ")}
    >
      <span className={active ? "text-kin-on-brand" : "text-kin-muted"}>{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && (
        <span
          className={[
            "text-caption flex-none",
            active ? "text-kin-on-brand opacity-70" : "text-kin-muted",
          ].join(" ")}
        >
          {active ? `↵ ${t("palette.open")}` : hint}
        </span>
      )}
    </button>
  );
}
