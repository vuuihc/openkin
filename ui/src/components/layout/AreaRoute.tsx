import { useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { routeTransition, transitionMotion, type TransitionKind } from "../../lib/areaTransition";

/**
 * The content region: the one element a navigation animates.
 *
 * `App` puts this around `<Routes>` only. The session keep-alive host, the
 * sidebar, the tabs and every portaled panel stay outside it, so a route
 * change moves the arriving page and nothing else (TASTE 15).
 *
 * The kind is latched during render, not in an effect. React's "adjust state
 * during render" re-runs this component before it commits, which is what makes
 * `data-motion` part of the *same* commit as the new page: the first painted
 * frame already animates. An effect would paint one frame of the new page with
 * the previous (or no) motion and then restart it — a visible stutter, and on
 * a fast machine sometimes no animation at all.
 *
 * The location object is the signal because React Router hands out one stable
 * object per navigation; a re-render for any other reason keeps the same
 * reference and changes nothing.
 */
export default function AreaRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  const [seen, setSeen] = useState(location);
  const [kind, setKind] = useState<TransitionKind>("none");

  if (seen !== location) {
    // Same component, adjusted before children render. Two setters in one
    // render are batched into a single re-render.
    setSeen(location);
    setKind(routeTransition(seen, location));
  }

  return (
    <div
      className="kin-route flex min-h-0 min-w-0 flex-1 flex-col empty:hidden"
      data-motion={transitionMotion(kind, reducedMotion)}
    >
      {children}
    </div>
  );
}
