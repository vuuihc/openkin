import { useEffect, useState } from "react";
import { useT } from "../i18n/react";
import {
  ELEVATION_CLASS,
  FILL_INK,
  PRESENTED_TOKENS,
  SURFACE_TOKENS,
  TOKEN_GROUPS,
  cssValue,
} from "../design/colors";
import { ROLE_PREVIEW, TYPE_ROLES } from "../design/type";

/**
 * Every named token, drawn as the thing it is.
 *
 * The inventory lives in `design/colors.ts` rather than here, because
 * `tokens.test.ts` reads the same list and compares it against `theme.css` in
 * both directions — a token declared but never presented here (a token nobody
 * renders is a token nobody would notice breaking), and a name that the
 * stylesheet no longer defines. A pairing that only the page knew about would
 * be a pairing the test could not hold.
 */

/** The value as the browser resolved it — the file is the source, not a copy. */
function useResolvedValues(names: readonly string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setValues(Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()])));
    };
    read();
    // Switching the theme in settings rewrites these without a remount.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, [names]);
  return values;
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--kin-hairline)] p-2">
      <div
        className="h-9 w-9 flex-none rounded-md border border-[var(--kin-hairline)]"
        style={{ background: cssValue(name) }}
      />
      <div className="min-w-0">
        <div className="truncate text-body font-semibold text-kin-text">{name}</div>
        {/* A triplet resolves to three numbers, and showing them is the point:
            it is why the name carries the suffix. */}
        <div className="truncate font-mono text-caption text-kin-muted">{value || "—"}</div>
      </div>
    </div>
  );
}

/**
 * A fill with the foreground it was assigned, at the size a label is actually
 * drawn. The pairing is the thing being shown: which of the two near-white /
 * near-black inks a pigment takes is a decision, and a chip alone would hide it.
 */
function FillSample({
  name,
  value,
  ink,
  inkValue,
}: {
  name: string;
  value: string;
  ink: string;
  inkValue: string;
}) {
  return (
    <div
      className="rounded-lg border border-[var(--kin-hairline)] p-3"
      style={{ background: cssValue(name) }}
    >
      <div className="text-body font-semibold" style={{ color: cssValue(ink) }}>
        {ink} on {name}
      </div>
      <div className="mt-1 text-caption" style={{ color: cssValue(ink) }}>
        The quick brown fox jumps over the lazy dog — 0123456789
      </div>
      <div className="mt-1 font-mono text-micro" style={{ color: cssValue(ink) }}>
        {name} {value || "—"} · {ink} {inkValue || "—"}
      </div>
    </div>
  );
}

function InkSample({ name, value, ink }: { name: string; value: string; ink: string }) {
  return (
    <div
      className="rounded-lg border border-[var(--kin-hairline)] p-3"
      style={{ background: cssValue(ink) }}
    >
      <div className="text-body font-semibold" style={{ color: cssValue(name) }}>
        {name} on {ink}
      </div>
      <div className="mt-1 text-caption" style={{ color: cssValue(name) }}>
        The quick brown fox jumps over the lazy dog — 0123456789
      </div>
      <div className="mt-1 font-mono text-micro text-kin-muted">{value || "—"}</div>
    </div>
  );
}

/**
 * The surfaces an ink step is actually drawn on, so the sample is the real pair.
 *
 * Read from `design/colors.ts` rather than listed again here: the guard measures
 * the same list, and a second copy is how the page and the test come to disagree.
 *
 * All six, `--kin-page` included. It is the window backdrop `AppShell` paints on
 * its root, and `<main>` inside paints nothing — so a page that does not paint
 * its own surface (most of them: the agents search field, the session detail
 * page, the provider settings fields) draws its captions *and* its focused
 * controls straight on the backdrop. A status chip drawn there measured 4.41:1
 * in the light scheme, which is what moved the `muted` step and the backdrop
 * itself; before that the page was measured for the ring alone, on the theory
 * that no label is drawn on it. A theory the screen disagreed with.
 */
const BACKDROPS = SURFACE_TOKENS;

/**
 * A colour chip would not answer the question this token exists to answer, so
 * the ring is drawn — at `ring-1`, the width 14 of the 16 real styles use, on
 * each surface a focused control actually sits on.
 */
function FocusSample({ name, value, ink }: { name: string; value: string; ink: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: cssValue(ink) }}>
      <div className="min-h-9 rounded-md px-3 py-2 text-body text-kin-text ring-1 ring-kin-focus-ring">
        {name}
      </div>
      <div className="mt-2 font-mono text-caption text-kin-muted">
        {ink} · {value || "—"}
      </div>
    </div>
  );
}

/**
 * An elevation step only reads as one once something is raised off something
 * else, so the sample is the raised surface with the drop under it. The chip is
 * `--kin-elevated` because that is what floats in this console, and it wears the
 * *class* rather than the token — the token is a colour and a `box-shadow` needs
 * geometry, so setting it directly renders `none`; see `ELEVATION_CLASS`.
 */
function ElevationSample({ name, value }: { name: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--kin-hairline)] p-4">
      <div className={`h-14 rounded-md bg-kin-elevated ${ELEVATION_CLASS[name] ?? ""}`} />
      {/* Two lines, not `name · value`: a black `rgba()` is long enough that
          the alpha — the whole point of the pair — was the part `truncate` cut
          off, and the alpha is what the two schemes are compared on. */}
      <div className="mt-3 truncate font-mono text-caption text-kin-muted">{name}</div>
      <div className="truncate font-mono text-caption text-kin-muted">{value || "—"}</div>
    </div>
  );
}

/**
 * The type ladder, rendered from the same array `tailwind.config.ts` assigns to
 * `theme.fontSize` — so a role that exists is a role that is shown here.
 */
function TypeLadder() {
  const tr = useT();
  return (
    <div className="space-y-2">
      {TYPE_ROLES.map((role) => (
        <div key={role.role} className="rounded-lg border border-[var(--kin-hairline)] px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <div className={ROLE_PREVIEW[role.role]}>
              The quick brown fox jumps over the lazy dog
            </div>
            <div className="flex-none font-mono text-micro text-kin-muted">
              text-{role.role} · {role.px}px · {role.weight} · {role.ink}
            </div>
          </div>
          <div className="mt-1 font-mono text-micro text-kin-muted">
            {tr("design.absorbed")}:{" "}
            {role.absorbed
              // A bare name is one of Tailwind's defaults; the ladder cannot
              // spell one out with its prefix, so it says where the name is from.
              .map((entry) =>
                entry.endsWith("px") ? entry : tr("design.absorbedDefault", { name: entry }),
              )
              .join(" · ")}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DesignSystemPage() {
  const tr = useT();
  const values = useResolvedValues(PRESENTED_TOKENS);
  return (
    <div className="h-full overflow-y-auto kin-scroll px-5 py-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-hero font-bold text-kin-text">{tr("design.title")}</h1>
        <p className="mt-2 text-strong leading-prose text-kin-muted">{tr("design.lede")}</p>

        <div className="mt-6 space-y-6">
          {TOKEN_GROUPS.map((group) => {
            // Every group is drawn as the thing it is, not as a chip. Ink is
            // measured against the surfaces it is drawn on, the focus ring is
            // only a ring when there is something behind it, and a fill is only
            // a fill once the foreground it was assigned is on it — so those
            // three are rendered, and the rest are chips.
            const pairs =
              group.kind === "on-fill"
                ? group.tokens.flatMap((ink) =>
                    FILL_INK.filter((p) => p.ink === ink).map((p) => ({ ...p, ink })),
                  )
                : [];
            return (
              <section key={group.labelKey}>
                <h2 className="text-strong font-semibold text-kin-text">{tr(group.labelKey)}</h2>
                <p className="mb-3 mt-1 text-body text-kin-muted">{tr(group.noteKey)}</p>
                {group.kind === "ink" || group.kind === "focus" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.tokens.flatMap((name) =>
                      BACKDROPS.map((ink) =>
                        group.kind === "focus" ? (
                          <FocusSample
                            key={`${name}@${ink}`}
                            name={name}
                            value={values[name] ?? ""}
                            ink={ink}
                          />
                        ) : (
                          <InkSample
                            key={`${name}@${ink}`}
                            name={name}
                            value={values[name] ?? ""}
                            ink={ink}
                          />
                        ),
                      ),
                    )}
                  </div>
                ) : group.kind === "on-fill" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {pairs.map((pair) => (
                      <FillSample
                        key={pair.fill}
                        name={pair.fill}
                        value={values[pair.fill] ?? ""}
                        ink={pair.ink}
                        inkValue={values[pair.ink] ?? ""}
                      />
                    ))}
                  </div>
                ) : group.kind === "elevation" ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {group.tokens.map((name) => (
                      <ElevationSample key={name} name={name} value={values[name] ?? ""} />
                    ))}
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.tokens.map((name) => (
                      <Swatch key={name} name={name} value={values[name] ?? ""} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          <section>
            <h2 className="text-strong font-semibold text-kin-text">{tr("design.groupType")}</h2>
            <p className="mb-3 mt-1 text-body text-kin-muted">{tr("design.noteType")}</p>
            <TypeLadder />
          </section>
        </div>
      </div>
    </div>
  );
}
