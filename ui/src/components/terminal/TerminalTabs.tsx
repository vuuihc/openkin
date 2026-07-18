import { type TerminalSession } from "../../api/client";
import { useT } from "../../i18n/react";

type Props = {
  sessions: TerminalSession[];
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
      }
      e.preventDefault();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      onCloseSession(sessionId);
      e.preventDefault();
    }
  };

  return (
    <div className="flex items-center gap-0 border-b border-[var(--kin-hairline)] bg-[var(--kin-bg)] overflow-x-auto">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const label = getSessionLabel(session, sessions);
        const exitCode = session.exit_code;
        const isExited = session.status === "exited";

        return (
          <div
            key={session.id}
            className={`
              relative flex items-center gap-2 px-3 py-2 min-w-max cursor-pointer
              border-r border-[var(--kin-hairline-strong)]
              transition-colors
              ${
                isActive
                  ? "bg-[var(--kin-elevated)] text-kin-text"
                  : "bg-[var(--kin-bg)] text-kin-secondary hover:bg-[var(--kin-fill)]"
              }
            `}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => handleKeyDown(e, session.id)}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="text-[13px] font-medium truncate">
              {label}
              {isExited && exitCode !== undefined && (
                <span className="text-kin-muted ml-1">
                  {tr("terminal.exited", { code: exitCode })}
                </span>
              )}
            </span>

            <button
              className="ml-1 p-1 rounded hover:bg-[var(--kin-fill)] flex-shrink-0 text-kin-muted hover:text-kin-text transition-colors"
              aria-label={tr("terminal.closeSession")}
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession(session.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
