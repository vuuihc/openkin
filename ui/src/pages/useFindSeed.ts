import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * The words a palette search sent to this conversation, consumed once.
 *
 * The seed is removed from the URL as soon as it has been handed over, because
 * the page is what owns the read. Keeping it there would make the same hit
 * impossible to pick twice — same task, same words, same URL, so nothing would
 * change — and a back/forward visit would reopen a bar the reader had closed.
 */
export function useFindSeed(active: boolean): string | undefined {
  const [params, setParams] = useSearchParams();
  const raw = active ? params.get("find") : null;
  const seed = raw && raw.trim() ? raw : undefined;

  useEffect(() => {
    if (!seed) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("find");
        return next;
      },
      { replace: true },
    );
  }, [seed, setParams]);

  return seed;
}
