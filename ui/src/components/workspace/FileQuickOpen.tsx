/**
 * Jump to a file in a task's checkout, by typing part of its name.
 *
 * The tree is how you browse; this is how you go somewhere you already know.
 * The search is the daemon's own (`GET /api/tasks/{id}/source/files?q=`), the
 * same one the composer's @ menu uses, so a task on another machine is answered
 * by the machine that holds the files. It searches the *checkout*: a generation
 * view is a snapshot with no search route, and the page opens the chosen path in
 * the source view for exactly that reason.
 *
 * A query is not a listing. The daemon requires a non-space query and bounds the
 * answer, so every state the search can be in says so out loud: the idle hint
 * asks for a name, an empty answer says nothing matched, and a capped answer
 * says it stopped early rather than pretending that is the whole list. An old
 * answer is never allowed to sit under a newer query: both what is rendered and
 * what is stored are keyed by the query they answer, and a late response for a
 * query the person has typed past is dropped.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchTaskSourceFiles } from "../../api/client";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { IconSearch, IconSpinner } from "../icons";

/**
 * Long enough that a typed word is one question, short enough that the list
 * feels like it follows the caret. The composer's @ menu landed on 200ms; a
 * dedicated finder is the surface being watched, so it gets the tighter one.
 */
export const QUICK_OPEN_DEBOUNCE_MS = 150;

/**
 * The daemon's cap on a file query, in bytes (`worker.MaxFileQuery`). The
 * input's `maxLength` counts characters, which is the same bound for ASCII and
 * looser for anything else — so `queryTooLong` re-measures in bytes and the
 * overlay refuses locally rather than sending a request the server must reject.
 */
export const QUICK_OPEN_MAX_QUERY = 200;

/**
 * The combobox's list and its row ids.
 *
 * Fixed rather than `useId`: the page mounts one finder, and an id that changes
 * between renders would break the `aria-activedescendant` reference for a
 * screen reader mid-keystroke.
 */
const LIST_ID = "kin-file-quick-open-list";
const rowId = (index: number) => `${LIST_ID}-${index}`;

/** The same list `Sheet` and `ShareDialog` trap Tab with. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog that currently holds focus, if any.
 *
 * Focus — not the event target — is what says which layer is in front. The
 * command palette paints above this overlay and takes focus when it opens, but
 * it does not return focus when it closes: the next Escape has a target on
 * `<body>` while this dialog is the only thing left on screen.
 */
function focusedDialog(): Element | null {
  const active = document.activeElement;
  return active instanceof Element ? active.closest('[role="dialog"], [role="alertdialog"]') : null;
}

/**
 * Whether the daemon would refuse this query for its length.
 *
 * Its limit is bytes and the input's `maxLength` is characters, so a CJK query
 * reaches the ceiling well before the field stops accepting it. Asking anyway
 * would paint a server complaint with a Retry button that could only fail
 * again; the overlay says what to do instead.
 */
export function queryTooLong(query: string): boolean {
  return new TextEncoder().encode(query).length > QUICK_OPEN_MAX_QUERY;
}

type Props = {
  taskId: string;
  open: boolean;
  onClose: () => void;
  onOpenPath: (path: string) => void;
};

type Answer = { query: string; files: string[]; truncated: boolean };
type Failure = { query: string; message: string };

/** A repo-relative path split the way a finder row draws it. */
export function splitFilePath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/** The daemon's own complaint when it sent one, the surface's sentence otherwise. */
function searchErrorMessage(error: unknown, fallback: string): string {
  // `apiFetch` already unwraps the daemon's `{"error": "…"}` into the message,
  // so the sentence to show is simply the one on the error.
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function FileQuickOpen({ taskId, open, onClose, onOpenPath }: Props) {
  const tr = useT();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  // Every open starts a fresh question. The sequence bump is what retires an
  // answer still in flight from the previous open: it must not land in the new
  // one, where the person has not asked anything yet. On the way out, focus
  // goes back where it came from — the composer, usually — so the shortcut
  // leaves the page exactly as it found it.
  useEffect(() => {
    seqRef.current += 1;
    setQuery("");
    setAnswer(null);
    setFailure(null);
    setActive(0);
    setRetry(0);
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open, taskId]);

  const trimmed = query.trim();
  const tooLong = queryTooLong(trimmed);

  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    if (!trimmed || tooLong) {
      setAnswer(null);
      setFailure(null);
      return;
    }
    // A shorter query's rows are not selectable under a longer one.
    setAnswer(null);
    setFailure(null);
    const timer = window.setTimeout(() => {
      void searchTaskSourceFiles(taskId, trimmed)
        .then((res) => {
          if (seq !== seqRef.current) return;
          setAnswer({
            query: trimmed,
            files: Array.isArray(res.files) ? res.files : [],
            truncated: res.truncated === true,
          });
          setActive(0);
        })
        .catch((err) => {
          if (seq !== seqRef.current) return;
          setFailure({
            query: trimmed,
            message: searchErrorMessage(err, tr("workspace.find.failed")),
          });
          setActive(0);
        });
    }, QUICK_OPEN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, taskId, trimmed, tooLong, retry, tr]);

  // What is on screen answers the query on screen, or nothing does. The stored
  // answer is cleared a render late by the effect above; reading it through
  // this check is what keeps one painted frame from showing rows for a query
  // that has already moved on.
  const current = answer && answer.query === trimmed ? answer : null;
  const currentFailure = failure && failure.query === trimmed ? failure : null;
  const files = current?.files ?? [];
  // Asking, debouncing, or about to ask — all the same thing to the reader, and
  // none of them are "no matches". A query the daemon would refuse is neither:
  // it is its own sentence below.
  const loading = trimmed !== "" && !tooLong && !current && !currentFailure;

  // A new answer is a new list, so the highlight starts at its first row rather
  // than at an index that pointed into the old one.
  useEffect(() => {
    setActive(0);
  }, [current]);

  // The chosen row has to be on screen; a phone's keyboard leaves the list
  // short. `closest`/`scrollIntoView` are absent in jsdom, hence the guards.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  // Escape and Tab belong to the front layer — this one, unless another dialog
  // holds focus. Capture phase, so a later-registered bubble handler on the
  // page cannot act first on a key that is ours. Escape closes from anywhere
  // once nothing above is focused: the palette leaves focus on the page when it
  // closes, and a click on the dialog's own chrome blurs the field, so a
  // containment test would strand the reader with a visible modal that ignores
  // its only exit.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isImeKeyEvent(event) || event.defaultPrevented) return;
      if (event.key !== "Escape" && event.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const layer = focusedDialog();
      if (layer && layer !== root && !root.contains(layer)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      // A modal that lets Tab walk into the page behind it is a modal only
      // visually — and the page behind this one answers single letters.
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeElement = document.activeElement;
      if (!(activeElement instanceof Node) || !root.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (activeElement === first || activeElement === root)) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Cheap enough to rebuild per render, and a memo here would only make the
  // lint ask for the fallback empty array to be memoized as well.
  const rows = files.map((path) => ({ path, ...splitFilePath(path) }));

  if (!open) return null;

  function choose(path: string) {
    onClose();
    onOpenPath(path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Escape during IME composition cancels the composition, not the dialog.
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rows.length > 0) setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length > 0) setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      if (rows.length === 0) return;
      event.preventDefault();
      const row = rows[Math.min(active, rows.length - 1)];
      if (row) choose(row.path);
    }
  }

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[90] flex items-start justify-center pt-[10vh] px-4 bg-black/55 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={tr("workspace.find.title")}
      // Where focus lands when the dialog has nothing focusable to hold it.
      tabIndex={-1}
      // What the page's shortcut checks before claiming ⌘P: a dialog that is
      // this one may take the key again, any other dialog keeps its own.
      data-file-quick-open=""
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-palette rounded-2xl overflow-hidden bg-kin-panel/90 backdrop-blur-[50px] shadow-e3">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--kin-hairline)]">
          <IconSearch size={18} className="text-kin-muted flex-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("workspace.find.placeholder")}
            aria-label={tr("workspace.find.placeholder")}
            // A combobox, because that is what this is: the caret stays in the
            // field and the highlight travels the list. `aria-activedescendant`
            // is how a screen reader follows it without moving focus.
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={rows.length > 0 ? LIST_ID : undefined}
            aria-activedescendant={rows.length > 0 ? rowId(active) : undefined}
            aria-autocomplete="list"
            maxLength={QUICK_OPEN_MAX_QUERY}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-title text-kin-text outline-none placeholder:text-kin-muted"
          />
          {loading && <IconSpinner size={14} className="text-kin-muted flex-none" />}
          <kbd className="text-caption text-kin-muted border border-[var(--kin-hairline-strong)] rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[min(420px,55vh)] overflow-y-auto kin-scroll p-2">
          {/*
            The list is not announced row by row — fifty paths read aloud is
            noise. This says how many matched, which is the one thing a reader
            needs before deciding to arrow into the list.
          */}
          <p className="sr-only" role="status">
            {tooLong
              ? tr("workspace.find.tooLong")
              : loading
                ? tr("workspace.find.searching")
                : currentFailure
                  ? currentFailure.message
                  : current
                    ? tr("workspace.find.resultCount", { count: rows.length })
                    : ""}
          </p>
          {tooLong ? (
            <p className="px-3 py-8 text-center text-strong leading-5 text-kin-muted">
              {tr("workspace.find.tooLong")}
            </p>
          ) : currentFailure ? (
            <div className="px-3 py-8 text-center">
              <p className="text-strong leading-5 text-kin-muted">{currentFailure.message}</p>
              <button
                type="button"
                onClick={() => setRetry((n) => n + 1)}
                className="mt-3 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2.5 py-1 text-caption text-kin-text hover:bg-[var(--kin-fill-strong)]"
              >
                {tr("workspace.find.retry")}
              </button>
            </div>
          ) : trimmed === "" ? (
            <p className="px-3 py-8 text-center text-strong leading-5 text-kin-muted">
              {tr("workspace.find.hint")}
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-strong leading-5 text-kin-muted">
              {loading ? tr("workspace.find.searching") : tr("workspace.find.noMatches")}
            </p>
          ) : (
            <div role="listbox" id={LIST_ID} aria-label={tr("workspace.find.title")}>
              {rows.map((row, index) => (
                <div
                  key={row.path}
                  role="option"
                  id={rowId(index)}
                  aria-selected={index === active}
                  data-row-index={index}
                  onMouseEnter={() => setActive(index)}
                  // Keep the caret in the input: the row is a target, not a stop.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(row.path)}
                  className={[
                    "w-full flex items-baseline gap-2 px-2.5 py-1.5 max-md:py-3 rounded-lg text-left text-strong cursor-pointer",
                    index === active
                      ? "bg-kin-blue text-kin-on-brand"
                      : "text-kin-text hover:bg-[var(--kin-fill)]",
                  ].join(" ")}
                >
                  <span className="min-w-0 truncate">{row.name}</span>
                  {row.dir && (
                    <span
                      className={[
                        "min-w-0 truncate text-caption",
                        index === active ? "text-kin-on-brand opacity-70" : "text-kin-muted",
                      ].join(" ")}
                    >
                      {row.dir}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {current?.truncated && (
            <p className="px-3 pt-1 pb-2 text-caption text-kin-muted">
              {tr("workspace.find.truncated")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--kin-hairline)] text-caption text-kin-muted">
          <span className="inline-flex items-center gap-1">
            <kbd className="border border-[var(--kin-hairline-strong)] rounded px-1">↑</kbd>
            <kbd className="border border-[var(--kin-hairline-strong)] rounded px-1">↓</kbd>
            {tr("workspace.find.navigate")}
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="border border-[var(--kin-hairline-strong)] rounded px-1">↵</kbd>
            {tr("workspace.find.open")}
          </span>
        </div>
      </div>
    </div>
  );
}
