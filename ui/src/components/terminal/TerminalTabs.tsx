import { useRef } from "react";
import { type TerminalSession } from "../../api/client";
import { useT } from "../../i18n/react";

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
      className="flex items-center gap-0 overflow-x-auto border-b border-[var(--kin-hairline)] bg-[var(--kin-bg)]"
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
                  ? "bg-[var(--kin-elevated)] text-kin-text"
                  : "bg-[var(--kin-bg)] text-kin-secondary hover:bg-[var(--kin-fill)]"
              }
            `}
          >
            <button
              type="button"
              ref={(element) => {
                if (element) tabRefs.current.set(session.id, element);
                else tabRefs.current.delete(session.id);
              }}
              className="flex items-center gap-1 px-3 py-2 text-left"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, session.id)}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="truncate text-[13px] font-medium">{label}</span>
              {isExited && exitCode !== undefined ? (
                <span className="text-[11px] text-kin-muted">
                  {tr("terminal.exited", { code: exitCode })}
                </span>
              ) : session.connectionStatus === "connecting" ? (
                <span className="text-[11px] text-kin-muted">
                  {tr("terminal.connecting")}
                </span>
              ) : session.connectionStatus === "disconnected" ? (
                <span className="text-[11px] text-kin-orange">
                  {tr("terminal.disconnected")}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              className="mr-1 flex-shrink-0 rounded p-1 text-kin-muted transition-colors hover:bg-[var(--kin-fill)] hover:text-kin-text"
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
