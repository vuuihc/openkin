import type { AgentInfo } from "../api/client";
import { agentFamily, collapseAgentVariants } from "./agentFamilies";

/** UI presentation state for the full agent catalog. */
export type AgentCatalogState =
  "native" | "generic" | "verifying" | "not_installed" | "unavailable";

/**
 * How many products the catalog holds at most.
 *
 * The daemon discovers far more than a person will ever read (74 products on a
 * working machine), and every one of them used to arrive in the list whether or
 * not anyone wanted it. Ten is the size of a screen: enough for the agents a
 * person actually runs, small enough that the page still answers "what is on
 * this machine" instead of "what has anyone ever published".
 */
export const CATALOG_LIMIT = 10;

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

/** Sort catalog: runnable first, then installed, then name; the default leads. */
export function sortAgentCatalog(agents: AgentInfo[]): AgentInfo[] {
  return [...agents].sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
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

/**
 * Whether a row is a product Kin can host, rather than a sighting.
 *
 * `/api/agents` merges the skills discovery catalog into the registry answer so
 * the console can offer install links for products nobody uses yet. The two
 * kinds of row look alike, but only registry agents carry the permission ladder
 * Kin will actually run a dispatched turn in; a presence-only product (Cursor in
 * PATH) never does. That ladder is therefore the boundary between "an agent
 * this machine has" and "a product this machine could install".
 *
 * An older daemon that predates the field marks no rows at all. Availability is
 * then the boundary instead: a product Kin can run is one the daemon says is
 * available (a presence-only sighting is never available), and the builtin is
 * always Kin's own.
 */
export function isCatalogProduct(a: AgentInfo, laddersPresent: boolean): boolean {
  if (a.kind === "builtin" || a.id === "kin") return true;
  return laddersPresent ? a.permission_modes !== undefined : a.available;
}

/**
 * The registry-backed rows of an `/api/agents` answer, one product per row.
 *
 * This is the material the catalog is seeded from: products Kin can host. A
 * product present on PATH but not in the registry is *discovered* instead, and
 * waits for a person to connect it.
 */
export function catalogProducts(agents: AgentInfo[]): AgentInfo[] {
  const laddersPresent = agents.some((a) => a.permission_modes !== undefined);
  return agents.filter((a) => isCatalogProduct(a, laddersPresent));
}

/**
 * The families a console's catalog starts with.
 *
 * On a console that has never stored a catalog, the products Kin can host are
 * already connected — they have been in the new-chat picker all along, and
 * asking about each one in turn would be a migration prompt nobody asked for.
 * Everything the daemon merely discovered stays out until it is confirmed.
 *
 * Order is the catalog's own (runnable, installed, name), so the cap keeps the
 * agents that work when more than ten products are registered.
 */
export function seedCatalogFamilies(agents: AgentInfo[], limit = CATALOG_LIMIT): string[] {
  // Collapse before the slice: two transports of one product are one slot, and
  // a cap that counted them twice would evict a different product instead.
  return sortAgentCatalog(collapseAgentVariants(catalogProducts(agents)))
    .slice(0, limit)
    .map((a) => agentFamily(a.id, a.family));
}

export type AgentCatalogPlan = {
  /** Connected products, one family each, in the order the console stored them. */
  connected: AgentInfo[];
  /** Installed products that are not connected: what "查看" offers to add. */
  discovered: AgentInfo[];
  /** True when no further product fits. */
  full: boolean;
  /**
   * Stored families that cannot be shown: this machine no longer reports them,
   * or the stored list grew past the cap before it was written. They still
   * hold a slot, and the console offers to remove them.
   */
  missing: string[];
};

/**
 * Split an `/api/agents` answer into the catalog and what waits outside it.
 *
 * The connected list is the source of truth, not the machine's opinion: a
 * product enters only when a person confirmed it, and a family the daemon stops
 * reporting leaves a hole (`missing`) instead of silently reshaping the
 * catalog. Within a family the best variant is shown, by the same rule as
 * `collapseAgentVariants` — a native adapter beats its ACP client, and an
 * available row beats an unavailable one.
 */
export function planAgentCatalog(
  agents: AgentInfo[],
  connectedFamilies: readonly string[],
  limit = CATALOG_LIMIT,
): AgentCatalogPlan {
  const laddersPresent = agents.some((a) => a.permission_modes !== undefined);
  const byFamily = new Map<string, AgentInfo[]>();
  for (const agent of agents) {
    const family = agentFamily(agent.id, agent.family);
    const rows = byFamily.get(family);
    if (rows) rows.push(agent);
    else byFamily.set(family, [agent]);
  }

  const requested: string[] = [];
  for (const raw of connectedFamilies) {
    const family = agentFamily(raw);
    if (family && !requested.includes(family)) requested.push(family);
  }

  // The cap is a promise about what the catalog holds, not only about what is
  // installed today: a stored family this machine no longer reports still
  // occupies its slot. It is reported as `missing` so the console can offer to
  // remove it — otherwise ten vanished names would silently block every new
  // product. Anything past the cap (a list written before the cap existed) is
  // reported the same way rather than rendered as an eleventh row.
  const kept = requested.slice(0, limit);
  const connected: AgentInfo[] = [];
  const missing: string[] = requested.slice(limit);
  for (const family of kept) {
    const best = collapseAgentVariants(byFamily.get(family) ?? [])[0];
    if (best) connected.push(best);
    else missing.push(family);
  }

  const connectedSet = new Set(requested);
  const discovered: AgentInfo[] = [];
  for (const [family, rows] of byFamily) {
    if (connectedSet.has(family)) continue;
    const best = collapseAgentVariants(rows)[0];
    if (!best) continue;
    // Two things keep a row out of discovery. An uninstalled product is an
    // install suggestion, not a discovery: the machine cannot connect what it
    // does not have. A presence-only sighting — a config directory, an app
    // without a headless CLI — has no adapter to run a turn in, so connecting
    // it would spend one of ten slots on something that can never be
    // available. The firehose the cap exists to stop would come back through
    // this door.
    if (!best.installed || !isCatalogProduct(best, laddersPresent)) continue;
    discovered.push(best);
  }
  discovered.sort((a, b) => a.name.localeCompare(b.name));

  return { connected, discovered, full: requested.length >= limit, missing };
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
