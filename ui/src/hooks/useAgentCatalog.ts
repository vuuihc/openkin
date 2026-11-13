import { useCallback, useEffect, useRef, useState } from "react";
import { listAgents, type AgentInfo } from "../api/client";
import { useAppStore } from "../store/appStore";

/**
 * The agent catalog the console's import menus are built from.
 *
 * Reading the catalog is not importing: it is the list of agents a person can
 * ask to import from. This hook reads it once per connection and again after
 * an explicit import (the `kin:agent-sessions-changed` event those surfaces
 * publish).
 *
 * There is deliberately no timer and no settings read. The 30 second tick that
 * used to live in the shell read `agent_sessions.auto_import_mode` and started
 * a fan-out when it was `enabled`; KIN-AGENTS-001 says a session enters Kin
 * only when a person imports it, so an older stored `enabled` value can no
 * longer cause a background scan, sync or import. Manual import still works
 * and is the only way in.
 */
export function useAgentCatalog(): {
  /** The agents this console can offer, as last read. */
  catalog: AgentInfo[];
  /** Re-read the catalog after an import finished (or one happened elsewhere). */
  refresh: () => Promise<void>;
} {
  const wsStatus = useAppStore((s) => s.wsStatus);
  const [catalog, setCatalog] = useState<AgentInfo[]>([]);
  const request = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const seq = ++request.current;
      try {
        const next = await listAgents();
        if (seq === request.current) setCatalog(next);
      } catch {
        // A catalog that cannot be read right now does not erase the one the
        // menu is already showing.
      }
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    if (wsStatus === "disconnected") return;
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("kin:agent-sessions-changed", onChange);
    return () => window.removeEventListener("kin:agent-sessions-changed", onChange);
  }, [refresh, wsStatus]);

  return { catalog, refresh };
}
