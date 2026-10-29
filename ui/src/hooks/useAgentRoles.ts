import { useEffect, useState } from "react";
import { getSettings } from "../api/client";
import { parseAgentRoles, type AgentRole } from "../lib/agentRoles";

/**
 * The saved role presets, read once per mount.
 *
 * Roles are a settings key, so the list belongs to the daemon rather than to
 * the device: a role written on the laptop is on the phone the next time that
 * page loads. The only writer is the settings page, which is a different
 * route, so there is nothing to poll and nothing to invalidate — a mount-time
 * read is the whole contract.
 *
 * A daemon that cannot answer has no roles to offer yet. That is not an error
 * the composer should raise: an unreachable daemon already has its own ways of
 * saying so, and the role control is simply absent until roles exist.
 */
export function useAgentRoles(): AgentRole[] {
  const [roles, setRoles] = useState<AgentRole[]>([]);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((settings) => {
        if (live) setRoles(parseAgentRoles(settings.agent_roles));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return roles;
}
