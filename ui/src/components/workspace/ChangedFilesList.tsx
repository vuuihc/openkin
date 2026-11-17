import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { shortPath } from "../../lib/paths";
import { isImeKeyEvent } from "../../lib/ime";
import type { ChangedFile } from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { FileSize, actionDotClass, actionLabelKey } from "../changedFileFace";
import { IconFile } from "../icons";

type Props = {
  files: ChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

/**
 * Sidebar list of agent-written files for the workspace dual-pane.
 * Left column of the diff panel: only mutations (write/edit/delete).
 */
export default function ChangedFilesList({ files, selectedPath, onSelect }: Props) {
  const t = useT();

  const ordered = useMemo(() => {
    // Mutations only, newest first.
    const mut = files.filter((f) => f.action !== "read" && f.action !== "other");
    const bySeq = (a: ChangedFile, b: ChangedFile) => b.seq - a.seq || a.path.localeCompare(b.path);
    return [...mut].sort(bySeq);
  }, [files]);

  // Hooks must run unconditionally. Returning above these when the list is
  // empty caused React minified error #300 ("Rendered fewer hooks than
  // expected") as the list flipped between empty and non-empty.
  const selectedKey = selectedPath ? normalizeKey(selectedPath) : "";
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // The roving tab stop: the row a Tab returns to and the anchor the arrows
  // walk from. Null means nobody has focused a row since this list mounted, so
  // the selected row — or the first one — holds it.
  const [tabStop, setTabStop] = useState<string | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const rowElements = useCallback(
    () =>
      Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>("[data-workspace-row]") ?? [],
      ),
    [],
  );

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.defaultPrevented || isImeKeyEvent(event.nativeEvent)) return;
    const rows = rowElements();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(at + 1, rows.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(at - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      default:
        return;
    }
    // The list is taller than its pane, so the browser would otherwise scroll
    // the page on the same keystroke that moves focus.
    event.preventDefault();
    rows[next]?.focus();
  };

  if (ordered.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-4 text-center text-body text-kin-muted">
        {t("workspace.changed.empty")}
      </div>
    );
  }

  const selectedIndex =
    selectedKey === ""
      ? -1
      : ordered.findIndex((file) => matchesSelection(selectedKey, normalizeKey(file.path)));
  const fallback = ordered[selectedIndex >= 0 ? selectedIndex : 0];
  const tabStopKey =
    tabStop && ordered.some((file) => rowKey(file) === tabStop)
      ? tabStop
      : fallback
        ? rowKey(fallback)
        : null;

  return (
    <div className="h-full min-h-0 overflow-y-auto kin-scroll">
      <ul ref={listRef} className="py-1" onKeyDown={onListKeyDown}>
        {ordered.map((f) => {
          const key = normalizeKey(f.path);
          const id = rowKey(f);
          const active = selectedKey !== "" && matchesSelection(selectedKey, key);
          return (
            <li key={id}>
              <button
                type="button"
                ref={active ? activeRef : undefined}
                // The panel's back control finds this row to return focus to
                // when the list comes back on a phone.
                data-selected={active || undefined}
                data-workspace-row={id}
                tabIndex={id === tabStopKey ? 0 : -1}
                onFocus={() => setTabStop(id)}
                onClick={() => onSelect(f.path)}
                title={f.path}
                className={[
                  "w-full flex items-start gap-2 px-2.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kin-focus-ring",
                  active
                    ? "bg-kin-blue/15 text-kin-text"
                    : "text-kin-secondary  hover:bg-kin-fill hover:text-kin-text",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-1 w-1.5 h-1.5 rounded-full flex-none",
                    actionDotClass(f.action),
                  ].join(" ")}
                  aria-hidden
                />
                <IconFile size={13} className="mt-0.5 flex-none opacity-80" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-body leading-ui">
                    {shortPath(f.path, 36)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-micro uppercase tracking-label opacity-70">
                    <span>{t(actionLabelKey(f.action))}</span>
                    {/* The same face as the bar and the round card, from the same
                        component: a file whose payload carried no counts says "size
                        unknown" here too, instead of going quiet while the bar beside
                        it says it. Both-absent is the common case — a bodyless delete,
                        a binary file, an untracked path. */}
                    <span className="normal-case tabular-nums tracking-normal">
                      <FileSize
                        additions={f.additions}
                        deletions={f.deletions}
                        label={t("workspace.changed.noLineDelta")}
                      />
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function normalizeKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The change events name one path in absolute and relative forms; the row
 * that matches either end is the selected one. */
function matchesSelection(selected: string, key: string): boolean {
  return selected === key || selected.endsWith("/" + key) || key.endsWith("/" + selected);
}

/** One row per (action, path): the same path can be written and then deleted,
 * and each event keeps its own row and its own roving identity. */
function rowKey(file: ChangedFile): string {
  return `${file.action}:${file.path}`;
}
