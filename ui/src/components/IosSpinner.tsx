/**
 * The standard iOS activity indicator: twelve spokes 30° apart, each a short
 * rounded bar with a fixed descending opacity, ticking around the centre.
 *
 * It is the wait surface for a conversation whose detail has not answered
 * (both the list-row entry and the no-row cold entry). The owner overruled
 * the boot screen's K tile here (2026-11-19): the in-console wait should read
 * as the familiar iOS spinner, not repeat the launch identity. The boot
 * splash in `ui/index.html` is untouched.
 *
 * The motion lives in `index.css`: one full turn in twelve `steps(12, end)`
 * ticks — a smooth sweep loses the iOS read — and `prefers-reduced-motion`
 * stops it while keeping the wheel visible. The wheel is `aria-hidden`; the
 * call site's status role carries the accessible name.
 */

const SPOKES = 12;
const LEAD_OPACITY = 1;
const TAIL_OPACITY = 0.15;

export default function IosSpinner({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  const spokeWidth = Math.max(2, size * 0.08);
  const spokeHeight = size * 0.25;
  const radius = size * 0.32;

  return (
    <span
      aria-hidden="true"
      className={`kin-ios-spinner relative inline-block flex-none text-kin-muted ${className}`}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: SPOKES }, (_, index) => (
        <span
          key={index}
          className="absolute left-1/2 top-1/2 rounded-full bg-current"
          style={{
            width: spokeWidth,
            height: spokeHeight,
            opacity: LEAD_OPACITY - ((LEAD_OPACITY - TAIL_OPACITY) * index) / (SPOKES - 1),
            transform: `translate(-50%, -50%) rotate(${index * (360 / SPOKES)}deg) translateY(${-radius}px)`,
          }}
        />
      ))}
    </span>
  );
}
