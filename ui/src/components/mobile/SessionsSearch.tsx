import { useSearchParams } from "react-router-dom";
import { useT } from "../../i18n/react";
import { IconSearch, IconX } from "../icons";

/**
 * The conversation search pill, bound to `?q=`.
 *
 * One component because the same query is edited in two places: the phone's bar
 * and — where that bar is hidden — the page's own desktop header. A second copy
 * of the binding would be a second chance to write the param differently; the
 * `replace: true` below is behaviour, not a detail, and it is the half that
 * keeps the back button from walking through "c", "ch", "cha".
 *
 * The query lives in the URL rather than in state so the field and the list
 * cannot disagree, a reload keeps the search, and a deep link can carry one.
 */
export default function SessionsSearch({ className = "" }: { className?: string }) {
  const tr = useT();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";

  function setQuery(next: string) {
    const following = new URLSearchParams(params);
    if (next) following.set("q", next);
    else following.delete("q");
    setParams(following, { replace: true });
  }

  return (
    <div
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
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={tr("sessions.searchPlaceholder")}
        aria-label={tr("sessions.searchPlaceholder")}
        type="search"
        enterKeyHint="search"
        className="min-h-9 min-w-0 flex-1 appearance-none bg-transparent text-body text-kin-text outline-none placeholder:text-kin-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label={tr("common.clear")}
          title={tr("common.clear")}
          data-touch-mini
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-kin-muted transition-colors hover:text-kin-text"
        >
          <IconX size={13} />
        </button>
      ) : null}
    </div>
  );
}
