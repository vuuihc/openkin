import { useEffect, useRef, useState, type RefObject } from "react";
import { type TerminalProfile } from "../../api/client";
import { useT } from "../../i18n/react";

type Props = {
  profiles: TerminalProfile[];
  open: boolean;
  onClose: () => void;
  onSelectProfile: (profileId: string) => void;
  /** Optional root that counts as "inside" for outside-click dismissal (e.g. the + / chevron control). */
  anchorRef?: RefObject<HTMLElement | null>;
};

/**
 * Profile picker for "New terminal". Styled like OpenInMenu / Sidebar menus so
 * it matches the rest of the desktop chrome (opens downward under the + control).
 */
export default function TerminalProfileMenu({
  profiles,
  open,
  onClose,
  onSelectProfile,
  anchorRef,
}: Props) {
  const tr = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedIdx, setFocusedIdx] = useState(0);

  useEffect(() => {
    if (!open || profiles.length === 0) return;
    setFocusedIdx(0);
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, profiles.length]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (profiles.length === 0) return;

      if (e.key === "ArrowDown") {
        const next = (focusedIdx + 1) % profiles.length;
        setFocusedIdx(next);
        itemRefs.current[next]?.focus();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        const next = (focusedIdx - 1 + profiles.length) % profiles.length;
        setFocusedIdx(next);
        itemRefs.current[next]?.focus();
        e.preventDefault();
      } else if (e.key === "Enter" || e.key === " ") {
        const profile = profiles[focusedIdx];
        if (profile) {
          onSelectProfile(profile.id);
          onClose();
        }
        e.preventDefault();
      }
    };

    // mousedown (not click) so React state updates from the toggle don't race
    // with a bubble-phase click listener on document.
    const handlePointerOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerOutside);
    };
  }, [open, profiles, focusedIdx, onClose, onSelectProfile, anchorRef]);

  if (!open || profiles.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={tr("terminal.new")}
      className="absolute right-0 top-full mt-1 z-50 min-w-[168px] max-w-[240px] rounded-lg border border-kin-border bg-kin-elevated shadow-window py-1"
    >
      {profiles.map((profile, idx) => {
        const focused = idx === focusedIdx;
        return (
          <button
            key={profile.id}
            ref={(element) => {
              itemRefs.current[idx] = element;
            }}
            type="button"
            role="menuitem"
            className={[
              "w-full text-left px-3 py-1.5 text-[12.5px] transition-colors",
              focused
                ? "text-kin-text bg-[var(--kin-fill-strong)]"
                : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
            onMouseEnter={() => setFocusedIdx(idx)}
            onClick={() => {
              onSelectProfile(profile.id);
              onClose();
            }}
          >
            <span className="truncate">{profile.name}</span>
            {profile.default && (
              <span className="ml-2 text-[11px] text-kin-muted">
                {tr("terminal.defaultProfile")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
