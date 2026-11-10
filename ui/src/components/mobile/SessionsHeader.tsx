import { useT } from "../../i18n/react";
import { IconSettings } from "../icons";
import MobileHeader, { IdentityDisc, MobileHeaderButton } from "./MobileHeader";
import SessionsSearch from "./SessionsSearch";

/**
 * The phone's conversation-list bar.
 *
 * The reference phone client puts identity, search and settings on this one
 * row, and gives the list itself no title: the rows are the page. That is also
 * why this bar has no hamburger glyph — the identity disc opens the drawer,
 * which is the same destination the hamburger had, in the place a person looks
 * for "me". The inbox used to sit beside settings; waiting work is now a mark
 * on the conversation row instead of a destination of its own.
 *
 * Search writes `?search=` rather than holding state, so the field and the list
 * cannot drift apart, the query survives opening a session and coming back,
 * and a deep link can carry one. It replaces the history entry on every
 * keystroke: a back button that walks through "c", "ch", "cha" is not a back
 * button. The field itself is `SessionsSearch`, shared with the page's desktop
 * header.
 */
export default function SessionsHeader({
  onOpenMenu,
  onOpenSettings,
}: {
  onOpenMenu: () => void;
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
        <MobileHeaderButton label={tr("nav.settings")} onClick={onOpenSettings} tone="muted">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--kin-fill)]">
            <IconSettings size={18} />
          </span>
        </MobileHeaderButton>
      }
    />
  );
}
