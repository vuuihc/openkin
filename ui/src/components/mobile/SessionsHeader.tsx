import { useT } from "../../i18n/react";
import { IconInbox, IconSettings } from "../icons";
import MobileHeader, { IdentityDisc, MobileHeaderButton } from "./MobileHeader";
import SessionsSearch from "./SessionsSearch";

/**
 * The phone's conversation-list bar.
 *
 * The reference phone client puts identity, search and the two destinations
 * that are not tabs on this one row, and gives the list itself no title: the
 * rows are the page. That is also why this bar has no hamburger glyph — the
 * identity disc opens the drawer, which is the same destination the hamburger
 * had, in the place a person looks for "me".
 *
 * Search writes `?q=` rather than holding state, so the field and the list
 * cannot drift apart, the query survives opening a session and coming back,
 * and a deep link can carry one. It replaces the history entry on every
 * keystroke: a back button that walks through "c", "ch", "cha" is not a back
 * button. The field itself is `SessionsSearch`, shared with the page's desktop
 * header.
 */
export default function SessionsHeader({
  pendingCount,
  onOpenMenu,
  onOpenInbox,
  onOpenSettings,
}: {
  pendingCount: number;
  onOpenMenu: () => void;
  onOpenInbox: () => void;
  onOpenSettings: () => void;
}) {
  const tr = useT();

  return (
    <MobileHeader
      heading={false}
      leading={
        <MobileHeaderButton label={tr("app.openMenu")} onClick={onOpenMenu}>
          <IdentityDisc />
        </MobileHeaderButton>
      }
      title={<SessionsSearch />}
      trailing={
        <>
          <span className="relative flex">
            <MobileHeaderButton label={tr("nav.inbox")} onClick={onOpenInbox} tone="muted">
              {/* The reference's trailing actions are discs, not bare glyphs:
                  two icons alone on a glass bar read as decoration, while a
                  36px filled disc reads as something a thumb can hit. The
                  button keeps its 44px hit box around it. */}
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--kin-fill)]">
                <IconInbox size={18} />
              </span>
            </MobileHeaderButton>
            {pendingCount > 0 && (
              <span className="pointer-events-none absolute right-1 top-1 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-kin-orange px-1 text-micro font-bold leading-flush text-kin-on-status tabular-nums">
                {pendingCount > 99 ? "99+" : pendingCount}
              </span>
            )}
          </span>
          <MobileHeaderButton label={tr("nav.settings")} onClick={onOpenSettings} tone="muted">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--kin-fill)]">
              <IconSettings size={18} />
            </span>
          </MobileHeaderButton>
        </>
      }
    />
  );
}
