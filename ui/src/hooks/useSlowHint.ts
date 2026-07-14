import { useEffect, useState } from "react";

/** True after `ms` while `active` remains true (default 10s for slow Funnel links). */
export function useSlowHint(active: boolean, ms = 10_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    setSlow(false);
    const id = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(id);
  }, [active, ms]);
  return slow;
}
