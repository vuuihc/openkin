import type { AgentInfo } from "../api/client";

/** UI presentation state for the full agent catalog. */
export type AgentCatalogState =
  | "native"
  | "generic"
  | "verifying"
  | "not_installed"
  | "unavailable";

/** True when the agent declares Kin-native approval/tool capabilities. */
export function isNativeAgent(a: AgentInfo): boolean {
  const caps = a.capabilities ?? [];
  return (
    caps.includes("approvals") ||
    caps.includes("tools") ||
    caps.includes("orchestrate") ||
    a.kind === "builtin" ||
    a.id === "kin"
  );
}

/** Classify an agent for four-state catalog rendering. */
export function agentCatalogState(a: AgentInfo): AgentCatalogState {
  if (a.available) {
    return isNativeAgent(a) ? "native" : "generic";
  }
  if (a.installed) {
    const reason = (a.reason ?? "").toLowerCase();
    if (
      reason.includes("verification") ||
      reason.includes("verifying") ||
      reason.includes("smoke test")
    ) {
      return "verifying";
    }
    return "unavailable";
  }
  return "not_installed";
}

/** Agents that can host/run a task right now. */
export function runnableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.available);
}

/** Sort catalog: runnable first, then installed, then name. */
export function sortAgentCatalog(agents: AgentInfo[]): AgentInfo[] {
  return [...agents].sort((a, b) => {
    const score = (x: AgentInfo) => {
      if (x.available) return 0;
      if (x.installed) return 1;
      return 2;
    };
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

/** Open an external install URL in a new browser tab. */
export function openInstallURL(url: string | undefined): void {
  if (!url) return;
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // ignore
  }
}
