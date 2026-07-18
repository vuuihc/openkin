import { useRef, useEffect, useState } from "react";
import { type TerminalProfile } from "../../api/client";

type Props = {
  profiles: TerminalProfile[];
  open: boolean;
  onClose: () => void;
  onSelectProfile: (profileId: string) => void;
};

export default function TerminalProfileMenu({
  profiles,
  open,
  onClose,
  onSelectProfile,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Handle keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        setFocusedIdx((prev) => (prev + 1) % profiles.length);
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setFocusedIdx((prev) => (prev - 1 + profiles.length) % profiles.length);
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (profiles[focusedIdx]) {
          onSelectProfile(profiles[focusedIdx].id);
          onClose();
        }
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, profiles, focusedIdx, onClose, onSelectProfile]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [open, onClose]);

  if (!open || profiles.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-0 mb-2 bg-[var(--kin-elevated)] border border-[var(--kin-hairline-strong)] rounded-lg shadow-lg z-50"
      role="menu"
    >
      <div className="py-1 min-w-[160px]">
        {profiles.map((profile, idx) => (
          <button
            key={profile.id}
            className={`
              w-full text-left px-3 py-2 text-[13px] transition-colors
              ${
                idx === focusedIdx
                  ? "bg-[var(--kin-fill)] text-kin-text"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)]"
              }
            `}
            role="menuitem"
            onClick={() => {
              onSelectProfile(profile.id);
              onClose();
            }}
          >
            <span>{profile.name}</span>
            {profile.default && <span className="text-kin-muted text-[11px] ml-2">●</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
