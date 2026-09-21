import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useRef,
} from "react";

export type SettingsTabId =
  | "general"
  | "agents"
  | "providers"
  | "routing"
  | "remote"
  | "notifications"
  | "advanced";

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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSettingsTabId(tabs, activeTab, event.key);
    if (next === activeTab) return;
    event.preventDefault();
    onTabChange(next);
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="space-y-1">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-kin-secondary">{subtitle}</p>
        </div>
        <div
          role="tablist"
          aria-label={title}
          onKeyDown={onKeyDown}
          className="flex max-w-full gap-2 overflow-x-auto rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/50 p-1 kin-scroll"
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
                  "min-h-[40px] shrink-0 rounded-lg px-3 text-[13px] font-medium outline-none transition",
                  "focus-visible:ring-2 focus-visible:ring-kin-blue/50",
                  selected
                    ? "bg-kin-blue text-white"
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
    <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {title}
          </h2>
          {description ? (
            <p className="text-[12px] leading-relaxed text-kin-secondary">{description}</p>
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
        <div className="text-xs font-medium text-kin-secondary">{label}</div>
        {description ? (
          <div className="text-[11px] leading-relaxed text-kin-muted">{description}</div>
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
        "inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
        tone === "success" && "bg-kin-green/15 text-kin-green",
        tone === "warning" && "bg-kin-warning/15 text-kin-warning",
        tone === "danger" && "bg-kin-red/15 text-kin-red",
        tone === "info" && "bg-kin-blue-soft text-kin-blue",
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
        "rounded-lg border px-3 py-2 text-xs leading-relaxed",
        tone === "info" && "border-kin-blue/30 bg-kin-blue-soft/40 text-kin-secondary",
        tone === "warning" && "border-kin-orange/30 bg-kin-orange/10 text-kin-secondary",
        tone === "danger" && "border-kin-red/30 bg-kin-red/10 text-kin-red",
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
        "rounded-lg border px-3 py-4 text-sm",
        state === "error"
          ? "border-kin-red/30 bg-kin-red/10 text-kin-red"
          : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 text-kin-secondary",
      )}
    >
      <div className="font-medium">{title}</div>
      {description ? <div className="mt-1 text-xs text-kin-muted">{description}</div> : null}
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
        variant === "danger" && "text-kin-red",
        "disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={classes(
        "inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-blue/50 disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}
