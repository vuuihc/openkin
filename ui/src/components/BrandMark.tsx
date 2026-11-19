/**
 * The Kin tile: the 64px near-black square with the white K that
 * `ui/index.html` paints before any script runs.
 *
 * A cold entry draws this while the console restores a conversation, so the
 * boot screen and the first console paint are one identity. It replaces the
 * console's blue accent mark there: blue now means "the action on this screen",
 * and a brand wait painted in it read as an unrelated spinner.
 *
 * The boot screen cannot import this file — it has to render before the bundle
 * loads — so the K path exists in both places by necessity.
 * `BrandMark.dom.test.tsx` reads `ui/index.html` and fails when the two drift,
 * and it pins that file's tile colour against the `--brand-tile` token the
 * stylesheet paints this component with. The tile's paint and the ring's
 * motion live in `index.css`.
 */
export const BRAND_MARK_PATH = "M116 116H219V210L396 23V116L263 256L396 396V489L219 302V396H116Z";

export default function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`relative flex h-16 w-16 flex-none items-center justify-center ${className}`}>
      {/* Outside the tile and behind it, as on the boot screen: 88px around a
          64px square. `m-auto` with `inset-0` centres it even though it is
          larger than its parent. */}
      <span
        aria-hidden="true"
        className="kin-brand-ring absolute inset-0 m-auto h-[88px] w-[88px]"
      />
      <span className="kin-brand-mark relative flex h-16 w-16 items-center justify-center overflow-hidden">
        <svg viewBox="0 0 512 512" width="64" height="64" aria-hidden="true">
          <path d={BRAND_MARK_PATH} />
        </svg>
      </span>
    </span>
  );
}
