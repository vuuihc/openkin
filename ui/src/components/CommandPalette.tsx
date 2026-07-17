import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  getToken,
  isTerminal,
  listTasks,
  type Task,
} from "../api/client";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { projectLabel } from "../lib/paths";
import { IconPlus, IconSearch, IconSettings, IconTasks, IconUsage } from "./icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
};

type Item =
  | { kind: "action"; id: string; label: string; hint?: string; run: () => void }
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
 * Sections: Actions · Chats (tasks) · Navigation.
 */
export default function CommandPalette({ open, onClose, onNewChat }: Props) {
  const navigate = useNavigate();
  const tr = useT();
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      setTasks(await listTasks({ limit: 80 }));
    } catch {
      setTasks([]);
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

    const actions: Item[] = (
      [
        {
          kind: "action" as const,
          id: "new",
          label: tr("palette.newChat"),
          hint: "⌘N",
          run: () => {
            onClose();
            onNewChat();
            navigate("/new");
          },
        },
        {
          kind: "action" as const,
          id: "inbox",
          label: tr("palette.openInbox"),
          run: () => {
            onClose();
            navigate("/inbox");
          },
        },
        {
          kind: "action" as const,
          id: "tasks",
          label: tr("palette.openTasks"),
          run: () => {
            onClose();
            navigate("/tasks");
          },
        },
        {
          kind: "action" as const,
          id: "artifacts",
          label: tr("palette.openArtifacts"),
          run: () => {
            onClose();
            navigate("/artifacts");
          },
        },
        {
          kind: "action" as const,
          id: "usage",
          label: tr("palette.openUsage"),
          run: () => {
            onClose();
            navigate("/usage");
          },
        },
        {
          kind: "action" as const,
          id: "settings",
          label: tr("palette.openSettings"),
          run: () => {
            onClose();
            navigate("/settings");
          },
        },
      ] satisfies Item[]
    ).filter((a) => match(a.label));

    const chats: Item[] = tasks
      .filter((t) => {
        const title = t.title || t.prompt;
        const proj = projectLabel(t.cwd);
        return match(title) || match(proj) || match(t.agent) || match(t.status);
      })
      .slice(0, 12)
      .map((t) => ({
        kind: "task" as const,
        id: t.id,
        task: t,
        label: `${projectLabel(t.cwd)}: ${t.title || t.prompt}`,
        hint: isTerminal(t.status)
          ? t.status
          : `${t.status} · ${t.agent}`,
      }));

    return [...actions, ...chats];
  }, [query, tasks, navigate, onClose, onNewChat, tr]);

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
      <div className="w-full max-w-[600px] rounded-2xl overflow-hidden border border-[var(--kin-hairline-strong)] bg-[rgba(44,44,48,.92)] backdrop-blur-[50px] shadow-[0_40px_100px_-20px_rgba(0,0,0,.8)]">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--kin-hairline)]">
          <IconSearch size={18} className="text-kin-tertiary flex-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("palette.search")}
            className="flex-1 bg-transparent text-[17px] text-kin-text outline-none placeholder:text-kin-muted"
          />
          <kbd className="text-[11px] text-kin-muted border border-[var(--kin-hairline-strong)] rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>

        <div className="max-h-[min(360px,50vh)] overflow-y-auto kin-scroll p-2">
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-kin-muted">{tr("palette.noMatches")}</p>
          )}

          {actionItems.length > 0 && (
            <>
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted px-2.5 pt-2 pb-1">
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
                    icon={
                      item.id === "new" ? (
                        <IconPlus size={16} />
                      ) : item.id === "tasks" ? (
                        <IconTasks size={16} />
                      ) : item.id === "usage" ? (
                        <IconUsage size={16} />
                      ) : item.id === "settings" ? (
                        <IconSettings size={16} />
                      ) : (
                        <IconSearch size={16} />
                      )
                    }
                    label={highlight(item.label, query)}
                    hint={item.hint}
                  />
                );
              })}
            </>
          )}

          {taskItems.length > 0 && (
            <>
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted px-2.5 pt-3 pb-1">
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
        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[9px] text-left text-[14px]",
        active ? "bg-kin-blue text-white" : "text-kin-text hover:bg-[var(--kin-fill)]",
      ].join(" ")}
    >
      <span className={active ? "text-white" : "text-kin-tertiary"}>{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && (
        <span
          className={[
            "text-[11px] flex-none",
            active ? "text-white/70" : "text-kin-muted",
          ].join(" ")}
        >
          {active ? `↵ ${t("palette.open")}` : hint}
        </span>
      )}
    </button>
  );
}
