import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  isAuthenticated,
  isTerminal,
  listProjects,
  listTasks,
  type Project,
  type Task,
} from "../api/client";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { projectLabel } from "../lib/paths";
import { paletteEntries, type PaletteEntry } from "../lib/palette";
import type { PanelContext, PanelId } from "../lib/panels";
import { listRecipes, type RecipeId } from "../recipes/catalog";
import { launchRecipe } from "../recipes/launch";
import { PANEL_ICONS, PLACE_ICONS } from "./placeIcons";
import { IconSearch } from "./icons";
import { taskDisplayTitle } from "../lib/taskTitle";
import { useAppStore } from "../store/appStore";

type Props = {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  /** Opens (or closes) a panel, in whichever view the shell owns. */
  onTogglePanel: (id: PanelId) => void;
  /** What the panel table is asked about: the shell's own place, not a session. */
  panelCtx: PanelContext;
};

type Item =
  | {
      kind: "action";
      id: string;
      label: string;
      hint?: string;
      icon: ReactNode;
      run: () => void;
    }
  | { kind: "task"; id: string; task: Task; label: string; hint?: string };

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
 * Sections: Actions · Project recipes · Chats.
 *
 * The Actions section is not written here. It is `paletteEntries(panelCtx)` — every
 * place the shell can go, then every panel this context offers — so a place or a
 * panel added to its table turns up in this list by existing, rather than by being
 * remembered. What stays local is what a table cannot hold: the copy (asked of the
 * locale by the key the table names), the icons (`placeIcons`), and the two
 * closures a row needs to actually go somewhere.
 */
export default function CommandPalette({
  open,
  onClose,
  onNewChat,
  onTogglePanel,
  panelCtx,
}: Props) {
  const navigate = useNavigate();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState(0);
  const [launchingRecipe, setLaunchingRecipe] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated()) {
      setTasks([]);
      setProjects([]);
      return;
    }
    try {
      const [taskList, projectList] = await Promise.all([
        listTasks({ limit: 80 }),
        listProjects("active").catch(() => [] as Project[]),
      ]);
      setTasks(Array.isArray(taskList) ? taskList : []);
      setProjects(Array.isArray(projectList) ? projectList : []);
    } catch {
      setTasks([]);
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
    // where one exists (`⌘N` on the draft, `Ctrl+\`` on the terminal), which is
    // why it travels with the entry rather than being decided per kind here.
    const entryRuns = (entry: PaletteEntry): (() => void) => {
      if (entry.kind === "place") {
        return () => {
          onClose();
          // The draft goes through the shell's own entry point: it focuses the
          // existing draft instead of navigating to a second one.
          if (entry.id === "new") onNewChat();
          navigate(entry.path);
        };
      }
      return () => {
        onClose();
        onTogglePanel(entry.id);
      };
    };

    const baseActions: Item[] = paletteEntries(panelCtx).map((entry) => {
      // Namespaced so a place and a panel that share a word cannot collide in the
      // React key list or in the icon lookup.
      const Icon = entry.kind === "place" ? PLACE_ICONS[entry.id] : PANEL_ICONS[entry.id];
      return {
        kind: "action" as const,
        id: `${entry.kind}:${entry.id}`,
        label: tr(entry.labelKey),
        hint: entry.hint,
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
          navigate(`/tasks/${task.id}`);
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

    const chats: Item[] = tasks
      .filter((t) => {
        const title = taskDisplayTitle(t);
        const proj = projectLabel(t.cwd);
        return match(title) || match(proj) || match(t.agent) || match(t.status);
      })
      .slice(0, 12)
      .map((t) => ({
        kind: "task" as const,
        id: t.id,
        task: t,
        label: `${projectLabel(t.cwd)}: ${taskDisplayTitle(t)}`,
        hint: isTerminal(t.status) ? t.status : `${t.status} · ${t.agent}`,
      }));

    return [...actions, ...recipeActions, ...chats];
  }, [
    launchingRecipe,
    navigate,
    onClose,
    onNewChat,
    onTogglePanel,
    panelCtx,
    projects,
    pushToast,
    query,
    tasks,
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
        if (item.kind === "action") item.run();
        else {
          onClose();
          navigate(`/tasks/${item.task.id}`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, navigate, onClose]);

  if (!open) return null;

  const actionItems = items.filter((i) => i.kind === "action");
  const taskItems = items.filter((i) => i.kind === "task");

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
                    label={highlight(item.label, query)}
                    hint={item.hint}
                  />
                );
              })}
            </>
          )}

          {taskItems.length > 0 && (
            <>
              <div className="text-caption font-semibold uppercase tracking-label text-kin-muted px-2.5 pt-3 pb-1">
                {tr("palette.chats")}
              </div>
              {taskItems.map((item) => {
                flatIndex += 1;
                const idx = flatIndex;
                const running = !isTerminal(item.task.status);
                return (
                  <PaletteRow
                    key={item.id}
                    active={idx === active}
                    onHover={() => setActive(idx)}
                    onClick={() => {
                      onClose();
                      navigate(`/tasks/${item.task.id}`);
                    }}
                    icon={
                      running ? (
                        <span className="w-2 h-2 rounded-full bg-kin-blue animate-breathe mx-1" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-kin-muted/40 mx-1" />
                      )
                    }
                    label={highlight(item.label, query)}
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
