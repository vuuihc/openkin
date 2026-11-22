import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useT } from "../../i18n/react";
import { AREAS, type AreaId } from "../../lib/areas";
import { resolveArea } from "../../lib/areaNavigation";
import { lastListUrl, onGuardedLinkClick } from "../../lib/phoneNavigation";
import { IconRoutines, IconSessions, IconSettings, IconSearch, type IconProps } from "../icons";
import Button from "../ui/Button";

/**
 * The Mac console's left edge: the three areas, as a rail.
 *
 * It renders `AREAS` and nothing else, so "where can I go" has one answer for
 * the rail, the palette and the router. The order, the locale key and the root
 * all come from the table; what lives here is the presentation the prototype
 * fixes — the labelled 208px column, the 64px icon rail, the needs-you badge
 * on Chats, and the ⌘N hint on each row.
 *
 * `Link`, not `NavLink`, even though the rows are navigation: `NavLink` decides
 * `aria-current` from pathname prefix matching, which disagrees with the area
 * table at `/` (Conversations owns it, but no link points there) and on every
 * detail route (`/tasks/x` is still Chats). The current area is what
 * `resolveArea` says, and the mark has to be that answer.
 */

/**
 * Whether the rail is the compact icon column.
 *
 * Two facts force it, and both are about the same thing — the conversation
 * needs the width. Opening the right panel takes the room; so does a window
 * narrower than 1280. Exported as a pure function so the rule is checked
 * without a DOM and the shell cannot quietly reimplement it.
 */
export function railCompact(panelOpen: boolean, wide1280: boolean): boolean {
  return panelOpen || !wide1280;
}

/**
 * One icon per area, keyed by the table's icon id.
 *
 * A `Record` over `AreaId`, like `PLACE_ICONS`: a new area cannot ship with a
 * blank row, because the compiler refuses the map until it has one. The
 * components live here rather than in `lib/areas.ts` so that module stays
 * data-only for the DOM-free tests.
 */
const AREA_ICONS: Record<AreaId, (p: IconProps) => ReactNode> = {
  conversations: IconSessions,
  routines: IconRoutines,
  settings: IconSettings,
};

type Props = {
  /** The icon rail: labels and ⌘ hints leave the layout, names stay. */
  compact: boolean;
  /** Waiting approvals, drawn on Chats in both widths. */
  pendingCount: number;
  /** Unread routine results, the footer badge the rail inherited. */
  routineUnreadCount?: number;
  /** Opens the one command palette; the shell owns it and this only asks. */
  onOpenPalette: () => void;
};

/** The badge text, clamped the way the rest of the chrome clamps it. */
function badgeFor(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 99 ? "99+" : String(count);
}

export default function AreaNav({
  compact,
  pendingCount,
  routineUnreadCount = 0,
  onOpenPalette,
}: Props) {
  const tr = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const current = resolveArea(location);

  // Chats goes back to the list view the reader actually had — search,
  // `?attention=`, `?scope=` — not to a bare `/sessions` that looks like a
  // reset. `lastListUrl` is the shell's own record of that view (maintained by
  // `notePhoneLocation` on every route); on the list itself the current URL is
  // already the answer, which is also what keeps clicking Chats while in Chats
  // from resetting the page.
  const chatsTarget =
    location.pathname === "/sessions" ? `${location.pathname}${location.search}` : lastListUrl();

  return (
    <nav
      aria-label={tr("nav.areas")}
      data-compact={compact ? "true" : "false"}
      className={[
        "kin-zen-hide flex h-full shrink-0 flex-col gap-0.5 border-r border-kin-hairline",
        "bg-[var(--kin-page)] py-3 transition-[width]",
        compact ? "w-rail-compact items-center px-2" : "w-rail px-2.5",
      ].join(" ")}
    >
      <div
        className={[
          "flex items-center pb-3",
          compact ? "justify-center pt-1" : "gap-2 px-2.5 pt-1",
        ].join(" ")}
      >
        <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-kin-blue text-strong font-semibold text-kin-on-brand shadow-e1">
          K
        </div>
        {compact ? null : (
          <span className="text-strong font-semibold tracking-tight">{tr("app.name")}</span>
        )}
      </div>

      {AREAS.map((area, index) => {
        const label = tr(area.labelKey);
        const badge = badgeFor(
          area.id === "conversations"
            ? pendingCount
            : area.id === "routines"
              ? routineUnreadCount
              : 0,
        );
        const hint = `⌘${index + 1}`;
        const to = area.id === "conversations" ? chatsTarget : area.root;
        const here = current === area.id;
        const Icon = AREA_ICONS[area.id];
        return (
          <Link
            key={area.id}
            to={to}
            data-area={area.id}
            onClick={(event) => onGuardedLinkClick(event, navigate, location, to)}
            // The number is part of the name: a badge a screen reader cannot
            // hear is a badge that says nothing.
            aria-label={badge ? tr("nav.withCount", { label, count: badge }) : label}
            aria-current={here ? "page" : undefined}
            title={`${label} ${hint}`}
            className={[
              "relative flex items-center rounded-lg transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring",
              compact ? "h-11 w-11 justify-center" : "h-9 gap-2.5 px-2.5",
              here
                ? "bg-[var(--kin-fill-strong)] text-kin-text font-semibold"
                : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
          >
            <Icon size={compact ? 18 : 16} strokeWidth={1.7} />
            <span data-area-label className={compact ? "hidden" : "truncate text-body"}>
              {label}
            </span>
            {badge ? (
              <span
                className={
                  compact
                    ? "absolute right-0 top-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-kin-orange px-0.5 text-micro font-bold tabular-nums text-kin-on-status"
                    : "ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-kin-orange px-1 text-caption font-bold tabular-nums text-kin-on-status"
                }
              >
                {badge}
              </span>
            ) : compact ? null : (
              <span className="ml-auto text-caption font-medium text-kin-muted">{hint}</span>
            )}
          </Link>
        );
      })}

      <Button
        variant="quiet"
        onClick={onOpenPalette}
        aria-label={tr("nav.paletteHint")}
        title={`${tr("nav.paletteHint")} ⌘K`}
        className={[
          "mt-auto flex items-center rounded-lg py-0 font-normal text-kin-muted hover:text-kin-text",
          compact
            ? "h-11 w-11 justify-center px-0"
            : "h-9 w-full justify-start gap-2 px-2.5 text-body [&>span]:w-full [&>span>span]:w-full",
        ].join(" ")}
      >
        {compact ? (
          <IconSearch size={16} className="shrink-0" />
        ) : (
          // Astryx wraps the children in two spans (content wrapper, then the
          // label span); the caller's own layout has to live inside both, which
          // is what the `[&>span]` widths above open up.
          <span className="flex w-full min-w-0 items-center gap-2">
            <IconSearch size={16} className="shrink-0" />
            <span className="truncate">{tr("nav.paletteHint")}</span>
            <span className="ml-auto text-caption font-medium">⌘K</span>
          </span>
        )}
      </Button>
    </nav>
  );
}

/** The area a ⌘/Ctrl+digit event names, or null when the chord is not one. */
export function areaShortcutRoot(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const area = AREAS[Number(event.key) - 1];
  return area ? area.root : null;
}
