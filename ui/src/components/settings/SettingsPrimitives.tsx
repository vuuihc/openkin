import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export type SettingsTabId =
  "general" | "agents" | "providers" | "routing" | "remote" | "notifications" | "advanced";

export type SettingsTabItem = {
  id: SettingsTabId;
  label: string;
  description: string;
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function nextSettingsTabId(
  tabs: readonly SettingsTabItem[],
  activeId: SettingsTabId,
  key: string,
): SettingsTabId {
  const current = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  );
  if (key === "Home") return tabs[0]?.id ?? activeId;
  if (key === "End") return tabs[tabs.length - 1]?.id ?? activeId;
  if (key !== "ArrowRight" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowUp") {
    return activeId;
  }
  const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
  const next = (current + direction + tabs.length) % tabs.length;
  return tabs[next]?.id ?? activeId;
}

/**
 * Which ends of a horizontally scrolling strip have something off-screen.
 *
 * The tab strip at a phone width holds about five of its seven tabs, and iOS
 * draws no persistent scrollbar, so "there is a seventh tab" had no way of being
 * visible — the selected tab could sit half-cut at the edge and read as the last
 * one. The strip fades at whichever edge still has tabs behind it, and this is
 * the whole of the decision, kept as a function so it can be tested without a
 * layout engine. The 1px slack is for fractional scroll positions.
 */
export function offscreenEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { start: boolean; end: boolean } {
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

export function settingsTabFromSearch(search: string): SettingsTabId {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (
    tab === "general" ||
    tab === "agents" ||
    tab === "providers" ||
    tab === "routing" ||
    tab === "remote" ||
    tab === "notifications" ||
    tab === "advanced"
  ) {
    return tab;
  }
  if (params.has("cloudflare") || params.has("relay")) return "remote";
  return "general";
}

export function SettingsLayout({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  children,
}: {
  title: string;
  subtitle: string;
  tabs: readonly SettingsTabItem[];
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  children: ReactNode;
}) {
  const tabRefs = useRef<Partial<Record<SettingsTabId, HTMLButtonElement | null>>>({});
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // Measured, not assumed from a tab count: whether the strip overflows depends
  // on the labels, the language and the width, and the answer changes when any
  // of them does. ResizeObserver covers the window and the font both.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => {
      const next = offscreenEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  // A tab can become active without anyone clicking it: the phone block jumps
  // to Remote or Notifications, and `?tab=` opens one directly. At a phone width
  // that tab may be scrolled out of the strip, which then shows no selected tab
  // at all. `nearest` moves the strip only when it has to, so a tab that is
  // already visible stays exactly where it is.
  useEffect(() => {
    tabRefs.current[activeTab]?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTab]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSettingsTabId(tabs, activeTab, event.key);
    if (next === activeTab) return;
    event.preventDefault();
    onTabChange(next);
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="mx-auto flex w-full max-w-page flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="space-y-1">
          {/* The shell's header already names this screen on the phone, and the
              prototype gives every phone screen one nav bar — so the grid of
              tabs starts where the h1 was, not 30px lower. */}
          <h1 className="hidden text-hero font-semibold tracking-tight md:block">{title}</h1>
          <p className="text-strong leading-5 text-kin-secondary">{subtitle}</p>
        </div>
        <div
          role="tablist"
          aria-label={title}
          ref={stripRef}
          data-more-start={edges.start ? "true" : "false"}
          data-more-end={edges.end ? "true" : "false"}
          onKeyDown={onKeyDown}
          className="kin-tabs-fade flex max-w-full gap-2 overflow-x-auto rounded-xl bg-kin-elevated/50 p-1 kin-scroll"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                title={tab.description}
                onClick={() => onTabChange(tab.id)}
                className={classes(
                  // `scroll-margin-inline` keeps the fade (see `.kin-tabs-fade`)
                  // from landing on top of the tab the strip just scrolled to.
                  "min-h-11 shrink-0 rounded-lg px-3 text-strong font-medium outline-none transition sm:min-h-10 [scroll-margin-inline:var(--tabs-fade)]",
                  "focus-visible:ring-2 focus-visible:ring-kin-focus-ring",
                  selected
                    ? "bg-kin-blue text-kin-on-brand"
                    : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        {children}
      </div>
    </div>
  );
}

export function SettingsTabPanel({
  id,
  active,
  children,
}: {
  id: SettingsTabId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={`settings-panel-${id}`}
      role="tabpanel"
      hidden={!active}
      tabIndex={0}
      aria-labelledby={`settings-tab-${id}`}
      className="space-y-5 outline-none"
    >
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {title}
          </h2>
          {description ? (
            <p className="text-body leading-prose text-kin-secondary">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-t border-[var(--kin-hairline)] pt-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] sm:gap-4">
      <div className="space-y-1">
        <div className="text-body leading-4 font-medium text-kin-secondary">{label}</div>
        {description ? (
          <div className="text-caption leading-prose text-kin-muted">{description}</div>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <span
      className={classes(
        "inline-flex shrink-0 items-center rounded-full px-2 py-1 text-micro font-semibold uppercase tracking-label",
        tone === "success" && "bg-kin-green/15 text-kin-green-ink",
        tone === "warning" && "bg-kin-orange/15 text-kin-orange-ink",
        tone === "danger" && "bg-kin-red/15 text-kin-red-ink",
        tone === "info" && "bg-kin-blue/15 text-kin-blue-ink",
        tone === "neutral" && "bg-[var(--kin-fill)] text-kin-muted",
      )}
    >
      {children}
    </span>
  );
}

export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={classes(
        "rounded-lg border px-3 py-2 text-body leading-prose",
        tone === "info" && "border-kin-blue/30 bg-kin-blue/15 text-kin-secondary",
        tone === "warning" && "border-kin-orange/30 bg-kin-orange/10 text-kin-secondary",
        tone === "danger" && "border-kin-red/30 bg-kin-red/10 text-kin-red-ink",
      )}
    >
      {children}
    </div>
  );
}

export function SettingsState({
  state,
  title,
  description,
}: {
  state: "loading" | "empty" | "error";
  title: string;
  description?: ReactNode;
}) {
  return (
    <div
      role={state === "error" ? "alert" : "status"}
      aria-busy={state === "loading"}
      className={classes(
        "rounded-lg border px-3 py-4 text-strong leading-5",
        state === "error"
          ? "border-kin-red/30 bg-kin-red/10 text-kin-red-ink"
          : "border-[var(--kin-hairline)] bg-[var(--kin-fill)] text-kin-secondary",
      )}
    >
      <div className="font-medium">{title}</div>
      {description ? (
        <div className="mt-1 text-body leading-4 text-kin-muted">{description}</div>
      ) : null}
    </div>
  );
}

export function ActionButton({
  variant = "secondary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={classes(
        variant === "primary" ? "kin-btn-primary" : "kin-btn-secondary",
        variant === "danger" && "text-kin-red-ink",
        "disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}
