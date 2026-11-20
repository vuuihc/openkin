import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { IconSearch, IconX } from "../icons";
import Button from "../ui/Button";

/**
 * The conversation search pill, bound to `?search=`.
 *
 * Not `q` or `find`: `/new?q=` is the composer's prompt prefill, and
 * `/tasks/:id?find=` is the transcript's find seed, which the conversation
 * page consumes and deletes. Both surfaces can be mounted on those routes at
 * desktop width.
 *
 * One component because the same query is edited in two places: the phone's bar
 * and — where that bar is hidden — the page's own desktop header. A second copy
 * of the binding would be a second chance to write the param differently; the
 * `replace: true` below is behaviour, not a detail, and it is the half that
 * keeps the back button from walking through "c", "ch", "cha".
 *
 * The query lives in the URL rather than in state so the field and the list
 * cannot disagree, a reload keeps the search, and a deep link can carry one.
 *
 * `autoFocus` and `onDismiss` are for the phone header's magnifier
 * (KIN-CONTINUE-004): the field is disclosed by a button, so opening it has to
 * put the caret in it, and Escape on an empty field is the surface's signal to
 * put the field away. Both are optional: the toolbar and the desktop header
 * mount the field in place and neither discloses it.
 */
export default function SessionsSearch({
  className = "",
  id,
  autoFocus = false,
  onDismiss,
}: {
  className?: string;
  /** The element an opener's `aria-controls` names. */
  id?: string;
  autoFocus?: boolean;
  /** Escape with an empty field: the surface that disclosed it may close it. */
  onDismiss?: () => void;
}) {
  const tr = useT();
  const [params, setParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const query = params.get("search") ?? "";

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function setQuery(next: string) {
    const following = new URLSearchParams(params);
    if (next) following.set("search", next);
    else following.delete("search");
    setParams(following, { replace: true });
  }

  /** Clearing is not leaving: the clear control disappears with the query, so
   *  hand the keyboard back to the field instead of dropping it to the body. */
  function clear() {
    setQuery("");
    inputRef.current?.focus();
  }

  /** Escape empties the filter before it leaves: a field that closes while it
   *  is still filtering would hide the reason the list is short. */
  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || isImeKeyEvent(event.nativeEvent)) return;
    if (query) {
      event.preventDefault();
      setQuery("");
      return;
    }
    if (!onDismiss) return;
    event.preventDefault();
    onDismiss();
  }

  return (
    <div
      id={id}
      className={[
        // The field itself draws no outline, so the pill carries the focus
        // state — in the focus-ring token, which is the only colour the tree
        // allows a focus indicator to use.
        "flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--kin-fill)] pl-2.5 pr-1 text-left focus-within:ring-2 focus-within:ring-kin-focus-ring",
        className,
      ].join(" ")}
    >
      <IconSearch size={14} className="flex-none text-kin-muted" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={tr("sessions.searchPlaceholder")}
        aria-label={tr("sessions.searchPlaceholder")}
        type="search"
        enterKeyHint="search"
        className="min-h-9 min-w-0 flex-1 appearance-none bg-transparent text-body text-kin-text outline-none placeholder:text-kin-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <Button
          variant="quiet"
          onClick={clear}
          aria-label={tr("common.clear")}
          title={tr("common.clear")}
          className="-my-1 -mr-1 h-11 w-11 flex-none items-center justify-center rounded-full p-0 text-kin-muted! md:my-0 md:mr-0 md:h-7 md:w-7"
        >
          <IconX size={13} />
        </Button>
      ) : null}
    </div>
  );
}
