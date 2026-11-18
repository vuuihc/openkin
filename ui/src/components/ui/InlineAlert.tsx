import type { ReactNode } from "react";

/**
 * The console's inline error surface.
 *
 * A read that fails inside one block must say so where the missing content
 * would have been, without blanking the rest of the screen. `role="alert"`
 * announces it to assistive tech the moment it appears; callers own the retry
 * action and any extra copy inside.
 *
 * The project cover's summary, its work-instructions block and its conflict
 * state all used the same hand-written recipe, which is why this exists as a
 * primitive rather than a fourth copy (KIN-PROJECT-003).
 */
export default function InlineAlert({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={[
        "rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}
