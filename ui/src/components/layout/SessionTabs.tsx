import { useEffect, useRef } from "react";
import { useT } from "../../i18n/react";
import { IconX } from "../icons";

/**
 * The open sessions, as a strip of tabs above the chat.
 *
 * Desktop only, and that is a decision rather than an oversight: on a 390px
 * screen a strip of tabs is a second navigation layer over the session list the
 * phone already has, and the phone's list has room for names. It stays in the
 * tree below `md` — hidden, mounted, and cheap — so nothing about the phone's
 * layout changes (P3 plan §2.6).
 *
 * The keyboard model is the terminal strip's (`TerminalTabs`): one tab is
 * tabbable, the arrows select the next one and wrap, `Delete` closes. What is
 * new here is `Alt`+arrows, which moves the tab itself instead of the cursor —
 * reordering is keyboard-only in P3 (pointer dragging is a phone-shaped problem
 * and belongs to P3b), so every tab carries the shortcut in its tooltip: a
 * keyboard feature with no visible hint is not a feature.
 */

export type SessionTab = {
  id: string;
  label: string;
};

type Props = {
  tabs: SessionTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, delta: number) => void;
};

export default function SessionTabs({ tabs, activeId, onSelect, onClose, onMove }: Props) {
  const tr = useT();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // The strip scrolls, and the active tab can be off the right edge — the one
  // tab that must be findable without scrolling for it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // Only rendered with at least one tab, so there is always something to focus.
  if (tabs.length === 0) return null;

  const handleKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (step === 0) {
      if (e.key === "Delete" || e.key === "Backspace") {
        onClose(tabId);
        e.preventDefault();
      }
      return;
    }
    // Alt moves the tab, the plain arrow moves the cursor: the two operations
    // are one keystroke apart on purpose, because they are the same gesture
    // (left/right) at two scopes (which tab is current, where it sits).
    if (e.altKey) {
      onMove(tabId, step);
      requestAnimationFrame(() => tabRefs.current.get(tabId)?.focus());
    } else {
      const next = tabs[(index + step + tabs.length) % tabs.length];
      if (next) {
        onSelect(next.id);
        requestAnimationFrame(() => tabRefs.current.get(next.id)?.focus());
      }
    }
    e.preventDefault();
  };

  return (
    <div
      className="hidden md:flex flex-none items-stretch overflow-x-auto border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] kin-scroll"
      role="tablist"
      aria-label={tr("tabs.label")}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          /*
            The cap is a text cap, not a container step: a session's name is a
            sentence, and one long prompt would otherwise push every other tab
            off the strip. `max-w-*` rather than a ladder name, for the reason
            tailwind.config.ts gives under the width steps.
          */
          <div
            key={tab.id}
            className={`relative flex max-w-[220px] items-center border-r border-[var(--kin-hairline)] ${
              isActive ? "bg-[var(--kin-fill)]" : "hover:bg-[var(--kin-fill)]"
            }`}
          >
            {isActive && (
              <span className="absolute inset-x-0 top-0 h-[2px] bg-kin-blue" aria-hidden />
            )}
            <button
              type="button"
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
                if (isActive) activeRef.current = element;
              }}
              className={`flex min-w-0 items-center px-3 py-1.5 text-left text-strong ${
                isActive ? "text-kin-text" : "text-kin-secondary"
              }`}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={tr("tabs.reorderHint")}
              onKeyDown={(event) => handleKeyDown(event, tab.id)}
              onClick={() => onSelect(tab.id)}
            >
              <span className="truncate">{tab.label}</span>
            </button>
            <button
              type="button"
              className="mr-1 flex-shrink-0 rounded p-0.5 text-kin-muted transition-colors hover:bg-[var(--kin-fill-strong)] hover:text-kin-text"
              aria-label={tr("tabs.close", { name: tab.label })}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <IconX size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
