import { useEffect, useState } from "react";
import { useT } from "../i18n/react";
import { ROLE_PREVIEW, TYPE_ROLES } from "../design/type";

/**
 * Every named token, grouped by the ladder it belongs to.
 *
 * This list is the page's content *and* the test's expectation: `tokens.test.ts`
 * reads `theme.css`, compares the two sets, and fails in both directions — a
 * token declared but never presented here (a token nobody renders is a token
 * nobody would notice breaking), and a name here that the stylesheet no longer
 * defines.
 */
export const TOKEN_GROUPS = [
  {
    labelKey: "design.groupSurfaces",
    noteKey: "design.noteSurfaces",
    tokens: [
      "--kin-page",
      "--kin-sidebar",
      "--kin-bg",
      "--kin-inspector",
      "--kin-elevated",
      "--kin-panel",
    ],
  },
  {
    labelKey: "design.groupInk",
    noteKey: "design.noteInk",
    tokens: ["--kin-text", "--kin-secondary", "--kin-muted"],
  },
  {
    labelKey: "design.groupLines",
    noteKey: "design.noteLines",
    tokens: ["--kin-hairline", "--kin-hairline-strong", "--kin-fill", "--kin-fill-strong"],
  },
  {
    labelKey: "design.groupFocus",
    noteKey: "design.noteFocus",
    tokens: ["--kin-focus-ring"],
  },
  {
    labelKey: "design.groupStatus",
    noteKey: "design.noteStatus",
    tokens: ["--kin-warning", "--kin-bubble-user", "--kin-bubble-user-fg"],
  },
] as const;

export const PRESENTED_TOKENS: string[] = TOKEN_GROUPS.flatMap((g) => [...g.tokens]);

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
        style={{ background: `var(${name})` }}
      />
      <div className="min-w-0">
        <div className="truncate text-body font-semibold text-kin-text">{name}</div>
        <div className="truncate font-mono text-caption text-kin-muted">{value || "—"}</div>
      </div>
    </div>
  );
}

function InkSample({ name, value, ink }: { name: string; value: string; ink: string }) {
  return (
    <div
      className="rounded-lg border border-[var(--kin-hairline)] p-3"
      style={{ background: `var(${ink})` }}
    >
      <div className="text-body font-semibold" style={{ color: `var(${name})` }}>
        {name} on {ink}
      </div>
      <div className="mt-1 text-caption" style={{ color: `var(${name})` }}>
        The quick brown fox jumps over the lazy dog — 0123456789
      </div>
      <div className="mt-1 font-mono text-micro text-kin-muted">{value || "—"}</div>
    </div>
  );
}

/** The surfaces an ink step is actually drawn on, so the sample is the real pair. */
const INK_BACKDROPS = ["--kin-bg", "--kin-elevated", "--kin-panel", "--kin-sidebar"] as const;

/**
 * The ring is measured one surface further out. `--kin-page` is the window
 * backdrop that `AppShell` paints on its root, and `<main>` inside it paints
 * nothing — so a page that does not paint its own surface (most of them: the
 * agents search field, the session detail page, the provider settings fields)
 * has its focused controls sitting directly on `--kin-page`. It is also the
 * surface that decided the light value. Ink does not get this one: no label is
 * drawn on the backdrop, and showing one there would be a pair that does not
 * exist.
 */
const FOCUS_BACKDROPS = ["--kin-page", ...INK_BACKDROPS] as const;

/**
 * A colour chip would not answer the question this token exists to answer, so
 * the ring is drawn — at `ring-1`, the width 14 of the 16 real styles use, on
 * each surface a focused control actually sits on.
 */
function FocusSample({ name, value, ink }: { name: string; value: string; ink: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: `var(${ink})` }}>
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
            // Two groups are drawn on the surfaces they appear on rather than
            // as colour chips: ink is measured against them, and the focus ring
            // is only a ring when there is something behind it.
            const Sample =
              group.labelKey === "design.groupInk"
                ? InkSample
                : group.labelKey === "design.groupFocus"
                  ? FocusSample
                  : null;
            const backdrops =
              group.labelKey === "design.groupFocus" ? FOCUS_BACKDROPS : INK_BACKDROPS;
            return (
              <section key={group.labelKey}>
                <h2 className="text-strong font-semibold text-kin-text">{tr(group.labelKey)}</h2>
                <p className="mb-3 mt-1 text-body text-kin-muted">{tr(group.noteKey)}</p>
                {Sample ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.tokens.flatMap((name) =>
                      backdrops.map((ink) => (
                        <Sample
                          key={`${name}@${ink}`}
                          name={name}
                          value={values[name] ?? ""}
                          ink={ink}
                        />
                      )),
                    )}
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
