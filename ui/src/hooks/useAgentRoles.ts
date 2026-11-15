import { useEffect, useState } from "react";
import { getSettings } from "../api/client";
import { AGENT_ROLES_CHANGED_EVENT, parseAgentRoles, type AgentRole } from "../lib/agentRoles";

/**
 * The saved role presets, read once per mount.
 *
 * Roles are a settings key, so the list belongs to the daemon rather than to
 * the device: a role written on the laptop is on the phone the next time that
 * page loads. The only writer is the settings page, which is a different
 * route, so there is nothing to poll and nothing to invalidate — a mount-time
 * read is the whole contract. That changed once the session host started
 * reading this too: the host stays mounted across routes, so the settings page
 * announces a save (`AGENT_ROLES_CHANGED_EVENT`) and this reads again.
 *
 * No answer yet is `null`, not an empty list: a failed read leaves the list
 * unknown, and the composer says so rather than telling someone to re-add
 * roles the daemon still has. A successful empty answer is an empty array.
 */
export function useAgentRoles(): AgentRole[] | null {
  // `null` is "no answer yet", not "no roles". The composer must not tell
  // someone their saved roles do not exist while the daemon is unreachable or
  // still thinking; a successful empty answer is an empty array.
  const [roles, setRoles] = useState<AgentRole[] | null>(null);

  useEffect(() => {
    let live = true;
    // Which read the newest question belongs to. A mount read that is slow can
    // answer after a save's re-read, and landing it would put the pre-save list
    // back on screen until the next save.
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      getSettings()
        .then((settings) => {
          if (live && mine === seq) setRoles(parseAgentRoles(settings.agent_roles));
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(AGENT_ROLES_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(AGENT_ROLES_CHANGED_EVENT, load);
    };
  }, []);

  return roles;
}
