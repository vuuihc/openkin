import { useRef } from "react";
import { type TerminalSession } from "../../api/client";
import { useT } from "../../i18n/react";
import { IconX } from "../icons";
import Button from "../ui/Button";

type TabSession = TerminalSession & {
  connectionStatus?: "connecting" | "connected" | "disconnected";
};

type Props = {
  sessions: TabSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
};

/**
 * Generate a stable tab label for a session, adding an ordinal when multiple
 * sessions use the same profile.
 */
function getSessionLabel(session: TerminalSession, sessions: TerminalSession[]): string {
  const sameName = sessions.filter((s) => s.name === session.name);
  if (sameName.length > 1) {
    const index = sameName.findIndex((s) => s.id === session.id);
    return `${session.name} ${index + 1}`;
  }
  return session.name;
}

export default function TerminalTabs({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
}: Props) {
  const tr = useT();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const handleKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const activeIdx = sessions.findIndex((s) => s.id === sessionId);
      if (activeIdx === -1) return;

      let nextIdx = activeIdx;
      if (e.key === "ArrowLeft") {
        nextIdx = activeIdx === 0 ? sessions.length - 1 : activeIdx - 1;
      } else {
        nextIdx = activeIdx === sessions.length - 1 ? 0 : activeIdx + 1;
      }

      const nextId = sessions[nextIdx]?.id;
      if (nextId) {
        onSelectSession(nextId);
        requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus());
      }
      e.preventDefault();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      onCloseSession(sessionId);
      e.preventDefault();
    }
  };

  return (
    <div
      className="flex items-center gap-0 overflow-x-auto border-b border-[var(--kin-hairline)] bg-[var(--kin-fill)]"
      role="tablist"
      aria-label={tr("terminal.title")}
    >
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const label = getSessionLabel(session, sessions);
        const exitCode = session.exit_code;
        const isExited = session.status === "exited";

        return (
          <div
            key={session.id}
            className={`
              relative flex min-w-max items-center
              border-r border-[var(--kin-hairline-strong)]
              transition-colors
              ${
                isActive
                  ? "bg-kin-elevated text-kin-text"
                  : "bg-[var(--kin-bg)] text-kin-secondary hover:bg-[var(--kin-fill)]"
              }
            `}
          >
            {/* A tab keeps its own square, left-aligned shape and the row's
                ink; the facade supplies the focus ring and the disabled
                treatment. `text-inherit!` is what keeps an inactive tab muted:
                the quiet variant would otherwise ink every tab like the active
                one, and its `text-kin-text` is emitted after `text-inherit`.
                `min-h-0!` keeps the dense strip from growing on a phone —
                the row is the touch target, and the tab already fills it. */}
            <Button
              variant="quiet"
              ref={(element) => {
                if (element) tabRefs.current.set(session.id, element);
                else tabRefs.current.delete(session.id);
              }}
              className="min-h-0! gap-1 rounded-sm px-3 py-2 text-left text-inherit!"
              // eslint-disable-next-line kin/no-raw-overlay-role -- the terminal tab strip owns its own roving focus and keyboard handling
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, session.id)}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="truncate text-strong font-medium">{label}</span>
              {isExited && exitCode !== undefined ? (
                <span className="text-caption text-kin-muted">
                  {tr("terminal.exited", { code: exitCode })}
                </span>
              ) : session.connectionStatus === "connecting" ? (
                <span className="text-caption text-kin-muted">{tr("terminal.connecting")}</span>
              ) : session.connectionStatus === "disconnected" ? (
                <span className="text-caption text-kin-orange-ink">
                  {tr("terminal.disconnected")}
                </span>
              ) : null}
            </Button>

            <Button
              variant="quiet"
              className="group mr-1 min-h-0! flex-shrink-0 rounded p-1"
              aria-label={tr("terminal.closeSession")}
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession(session.id);
              }}
            >
              <span className="text-kin-muted transition-colors group-hover:text-kin-text">
                <IconX size={12} />
              </span>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
