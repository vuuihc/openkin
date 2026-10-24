import { useEffect, useState } from "react";
import { useT } from "../i18n/react";

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
        <div className="truncate text-[12px] font-semibold text-kin-text">{name}</div>
        <div className="truncate font-mono text-[11px] text-kin-muted">{value || "—"}</div>
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
      <div className="text-[12px] font-semibold" style={{ color: `var(${name})` }}>
        {name} on {ink}
      </div>
      <div className="mt-1 text-[11px]" style={{ color: `var(${name})` }}>
        The quick brown fox jumps over the lazy dog — 0123456789
      </div>
      <div className="mt-1 font-mono text-[10px] text-kin-muted">{value || "—"}</div>
    </div>
  );
}

/** The surfaces an ink step is actually drawn on, so the sample is the real pair. */
const INK_BACKDROPS = ["--kin-bg", "--kin-elevated", "--kin-panel", "--kin-sidebar"] as const;

export default function DesignSystemPage() {
  const tr = useT();
  const values = useResolvedValues(PRESENTED_TOKENS);

  return (
    <div className="h-full overflow-y-auto kin-scroll px-5 py-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-[22px] font-bold text-kin-text">{tr("design.title")}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-kin-muted">{tr("design.lede")}</p>

        <div className="mt-6 space-y-6">
          {TOKEN_GROUPS.map((group) => (
            <section key={group.labelKey}>
              <h2 className="text-[13px] font-semibold text-kin-text">{tr(group.labelKey)}</h2>
              <p className="mb-3 mt-1 text-[12px] text-kin-muted">{tr(group.noteKey)}</p>
              {group.labelKey === "design.groupInk" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {group.tokens.flatMap((name) =>
                    INK_BACKDROPS.map((ink) => (
                      <InkSample
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
          ))}
        </div>
      </div>
    </div>
  );
}
