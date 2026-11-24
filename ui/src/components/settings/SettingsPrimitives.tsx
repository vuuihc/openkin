import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import { MobileCard, MobileRow } from "../mobile/MobileList";
import { MobileChevron } from "../mobile/MobileHeader";
import Button from "../ui/Button";

export type SettingsTabId =
  "general" | "agents" | "operations" | "providers" | "routing" | "advanced";

export type SettingsTabItem = {
  id: SettingsTabId;
  label: string;
  description: string;
  /**
   * What the section is set to right now, when the page already knows it.
   *
   * The directory used to name six sections without saying anything about the
   * state behind them, so learning the theme or the active provider meant
   * opening each one. `undefined` is the honest answer for a value that has
   * not loaded (or does not exist): the section keeps its description instead
   * of showing a guess or an empty line.
   */
  summary?: string;
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
 * The tab strip can overflow at a phone width, and iOS draws no persistent
 * scrollbar, so "there are more tabs" had no way of being visible — the
 * selected tab could sit half-cut at the edge and read as the last one. The
 * strip fades at whichever edge still has tabs behind it, and this is the whole
 * of the decision, kept as a function so it can be tested without a layout
 * engine. The 1px slack is for fractional scroll positions.
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
    tab === "operations" ||
    tab === "providers" ||
    tab === "routing" ||
    tab === "advanced"
  ) {
    return tab;
  }
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
  /** The page's tagline. Every tab renders it: an absent one changes the
   *  header's height and moves the section list under it. */
  subtitle?: string;
  tabs: readonly SettingsTabItem[];
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  children: ReactNode;
}) {
  const tr = useT();
  // The floor follows the pointer, not the viewport: an iPad in portrait is
  // 820px wide and still a thumb, so `sm:min-h-10` shrank every tab to 40px
  // on the screen that needed 44. A mouse keeps the dense shape above 640px.
  const coarse = useCoarsePointer();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<SettingsTabId, HTMLButtonElement | null>>>({});
  // Operations hides the section column, and the selected tab with it, so the
  // quiet back row is the only visible control focus can recover onto.
  const backRef = useRef<HTMLButtonElement | null>(null);

  // A tab can become active without anyone clicking it: `?tab=` opens one
  // directly. If the section column is scrolled, that entry may be out of
  // view. `nearest` moves the column only when it has to, so an entry that is
  // already visible stays exactly where it is.
  // A *change* of tab, not "the effect ran": StrictMode runs a mount effect
  // twice, and a `mounted` flag reads true on the second pass and would put
  // focus on a tab nobody aimed at when settings opens.
  const prevTab = useRef<SettingsTabId | null>(null);
  /**
   * A phone directory tap wants focus inside the panel it opens.
   *
   * TASTE 16: focus belongs to the layer that just appeared. On a phone the
   * row that was tapped is unmounted with the directory, so the browser drops
   * focus to `<body>` and the new page opens with no visible focus. The Mac
   * tab strip is the opposite case — it stays on screen, and stealing focus
   * from the tab would break the ARIA tablist's arrow-key pattern — so the
   * intent is explicit and only the directory row asks for it.
   *
   * It is a ref, not a focus() in the click handler: at click time the panel
   * is still `hidden`, and an element inside a hidden subtree cannot take
   * focus. The effect below runs after the commit that flips it.
   */
  const focusPanelRef = useRef(false);
  useEffect(() => {
    const tab = tabRefs.current[activeTab];
    tab?.scrollIntoView({ inline: "nearest", block: "nearest" });
    // Selecting a tab from *outside* the strip loses focus: the panel holding
    // the button that did it is about to be `hidden`, which blurs to `<body>`.
    // The strip's own arrow-key path already moves focus with the selection
    // (`onKeyDown` below), so this one does too — but only when focus was
    // actually lost, because on a click the tab already has it.
    const changed = prevTab.current !== null && prevTab.current !== activeTab;
    prevTab.current = activeTab;
    // Read-and-clear even when nothing changed: a stale intent must not fire
    // on the next unrelated selection.
    const focusPanel = focusPanelRef.current;
    focusPanelRef.current = false;
    if (changed && focusPanel) {
      const panel = document.getElementById(`settings-panel-${activeTab}`);
      const first = panel?.querySelector<HTMLElement>(
        'button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      // The panel itself is the fallback: it carries tabIndex={0} for exactly
      // this, so a section that is still loading is not a dead end.
      (first ?? panel)?.focus({ preventScroll: true });
    } else if (changed && document.activeElement === document.body) {
      const target = activeTab === "operations" ? backRef.current : tab;
      target?.focus({ preventScroll: true });
    }
  }, [activeTab]);

  /**
   * Selecting a tab starts at the top of the panel. Without it, switching from
   * a long tab to a short one kept the scroll position, and the new panel
   * opened halfway down with its heading off-screen — which on a phone looked
   * like the tap had done nothing.
   */
  const selectTab = (id: SettingsTabId, options?: { focus?: "panel" }) => {
    focusPanelRef.current = options?.focus === "panel";
    onTabChange(id);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSettingsTabId(tabs, activeTab, event.key);
    if (next === activeTab) return;
    event.preventDefault();
    onTabChange(next);
    window.requestAnimationFrame(() =>
      (next === "operations" ? backRef.current : tabRefs.current[next])?.focus(),
    );
  };

  // Operations is the hosted agent console. Its 980px usage table cannot share
  // the page with the section column: at a 1100px window the 224px column and
  // its gap left ~708px, and the table lost its last four columns off-screen.
  // The table needs the width more than the page needs a second navigation, so
  // Operations drops the column and keeps the quiet back row (the phone's
  // shape) as the way to the section list.
  const operations = activeTab === "operations";

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden kin-scroll phone-footer-clearance"
    >
      <div
        className={classes(
          "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 md:py-7",
          operations ? "max-w-page-wide md:px-6" : "max-w-page md:px-10",
        )}
      >
        {/* A Mac gets the shell's two-column shape: the section list is a fixed
            224px column and the form is a 620px reading column beside it. A
            phone keeps the directory-then-page shape below `md`. */}
        <div
          className={classes("flex flex-col gap-5", operations ? null : "md:flex-row md:gap-10")}
        >
          <div className={classes(operations ? "hidden" : "md:w-56 md:shrink-0")}>
            <div className="space-y-1">
              {/* The shell's header already names this screen on the phone, and the
                  prototype gives every phone screen one nav bar — so the section
                  list starts where the h1 was, not 30px lower. */}
              <h1 className="hidden text-hero font-bold tracking-tight md:block">{title}</h1>
              {subtitle ? (
                <p className="text-strong leading-5 text-kin-secondary">{subtitle}</p>
              ) : null}
            </div>
            <div
              role="tablist"
              aria-label={title}
              aria-orientation="vertical"
              onKeyDown={onKeyDown}
              className="hidden md:mt-6 md:flex md:flex-col md:gap-1"
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
                    // eslint-disable-next-line kin/no-raw-overlay-role -- the settings tab strip owns its own roving focus and panels
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`settings-panel-${tab.id}`}
                    // The section name stays the tab's accessible name; the
                    // summary is a glance aid for the visual scan, and the
                    // same value is read out inside the panel it opens.
                    aria-label={tab.label}
                    tabIndex={selected ? 0 : -1}
                    title={tab.description}
                    onClick={() => onTabChange(tab.id)}
                    className={classes(
                      "min-h-11 w-full shrink-0 rounded-lg px-3 py-2 text-left text-strong font-medium outline-none transition",
                      coarse ? null : "sm:min-h-10",
                      "focus-visible:ring-2 focus-visible:ring-kin-focus-ring",
                      selected
                        ? "bg-kin-blue text-kin-on-brand"
                        : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
                    )}
                  >
                    <span className="block truncate">{tab.label}</span>
                    {/* The value in effect under the section it belongs to —
                        one list, not a second index (TASTE 1). On the selected
                        blue tab it keeps the on-brand ink rather than
                        switching to a muted grey that would fight the fill. */}
                    {tab.summary ? (
                      <span
                        className={classes(
                          "mt-0.5 block truncate text-caption font-normal",
                          // Caption size and the regular weight already make
                          // the line secondary. The ink stays at full opacity:
                          // dimming it drops the on-brand/blue pair under the
                          // 3:1 floor recorded in design/colors.ts, and an
                          // element opacity is invisible to the token guard.
                          selected ? "text-kin-on-brand" : "text-kin-muted",
                        )}
                      >
                        {tab.summary}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div
            className={classes(
              "flex min-w-0 flex-1 flex-col gap-5",
              operations ? null : "md:max-w-[620px]",
            )}
          >
            {/* A phone does not get a section column: the first screen keeps
                General, and the rest is a list under it — the iOS settings
                shape, where the home screen is a directory and each entry is a
                page with a back row. */}
            {activeTab !== "general" && (
              <Button
                ref={backRef}
                variant="quiet"
                aria-label={title}
                onClick={() => selectTab("general")}
                className={classes("-mt-2 self-start text-body", operations ? null : "md:hidden")}
              >
                <span className="inline-flex items-center gap-1">
                  <MobileChevron />
                  <span>{title}</span>
                </span>
              </Button>
            )}
            {children}
            {activeTab === "general" && (
              <div className="md:hidden">
                <div className="px-1 pb-1.5 text-strong font-medium text-kin-muted">
                  {tr("settings.moreSections")}
                </div>
                <MobileCard>
                  {tabs
                    .filter((tab) => tab.id !== "general")
                    .map((tab) => (
                      <MobileRow
                        key={tab.id}
                        onClick={() => selectTab(tab.id, { focus: "panel" })}
                        title={tab.label}
                        detail={tab.description}
                        // The row's trailing slot, before the chevron: the
                        // phone's whole point is that the directory answers
                        // "what is it set to" without opening the section.
                        trailing={
                          tab.summary ? (
                            <span className="max-w-[9rem] truncate">{tab.summary}</span>
                          ) : undefined
                        }
                        chevron
                      />
                    ))}
                </MobileCard>
              </div>
            )}
          </div>
        </div>
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
  titleId,
  descriptionId,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Id the heading carries, so a field in this group can point at it with
   *  `aria-labelledby` and be named by the group it belongs to. */
  titleId?: string;
  /** Id the description carries, for the same reason with `aria-describedby`. */
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4 max-md:kin-card max-md:rounded-2xl max-md:bg-kin-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2
            id={titleId}
            className="text-caption font-semibold uppercase tracking-label text-kin-muted max-md:text-subtitle max-md:font-semibold max-md:normal-case max-md:tracking-normal max-md:text-kin-text"
          >
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="text-body leading-prose text-kin-secondary">
              {description}
            </p>
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
  labelId,
  descriptionId,
  children,
}: {
  label: string;
  description?: ReactNode;
  /** Id the field points at with `aria-labelledby`, so the label beside it is
   *  also its accessible name. */
  labelId?: string;
  /** Id the field points at with `aria-describedby`, for the same reason. */
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-t border-[var(--kin-hairline)] pt-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] sm:gap-4">
      <div className="space-y-1">
        <div id={labelId} className="text-body leading-4 font-medium text-kin-secondary">
          {label}
        </div>
        {description ? (
          <div id={descriptionId} className="text-caption leading-prose text-kin-muted">
            {description}
          </div>
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
