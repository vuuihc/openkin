/**
 * One product, several implementations.
 *
 * The daemon registers a native adapter and an ACP client for the same agent,
 * and a generic CLI entry for whatever else is on PATH. All three are real ways
 * to run the same product, and a picker that lists them side by side is asking
 * a person to choose a transport they have never heard of. This module is the
 * one place that knows which ids are the same product and which transport is
 * worth showing when they are.
 */

export type AgentTransport = "native" | "acp" | "cli";

const FAMILIES: Record<string, string> = {
  "claude-code": "claude",
  "claude-acp": "claude",
  codex: "codex",
  "codex-acp": "codex",
  droid: "droid",
  "droid-acp": "droid",
  pi: "pi",
  "pi-acp": "pi",
};

/** The product an agent id drives. Unknown ids are their own family. */
export function agentFamily(id: string, explicit?: string): string {
  const named = (explicit || "").trim().toLowerCase();
  if (named) return named;
  const key = (id || "").trim().toLowerCase();
  return FAMILIES[key] ?? key;
}

/**
 * How an agent is driven. The `-acp` suffix is the daemon's own convention for
 * its ACP clients (the native and ACP ids were deliberately kept distinct), and
 * a native adapter is the preferred form of a family when both are installed.
 */
export function agentTransport(id: string, explicit?: string, kind?: string): AgentTransport {
  const named = (explicit || "").trim().toLowerCase();
  if (named === "native" || named === "acp" || named === "cli") return named;
  const key = (id || "").trim().toLowerCase();
  if (key.endsWith("-acp")) return "acp";
  if (kind === "builtin") return "native";
  if (["claude-code", "codex", "droid", "grok", "rawpty"].includes(key)) return "native";
  return "cli";
}

const TRANSPORT_RANK: Record<AgentTransport, number> = { native: 0, acp: 1, cli: 2 };

type Variant = {
  id: string;
  family?: string;
  transport?: string;
  kind?: string;
  available: boolean;
};

/**
 * One entry per family, in first-seen order.
 *
 * Within a family an available entry beats an unavailable one, then the
 * preferred transport wins (`native`, then `acp`, then `cli`). An unavailable
 * duplicate is dropped rather than shown: two rows that both say "not
 * installed" are the same fact twice.
 */
export function collapseAgentVariants<T extends Variant>(agents: T[]): T[] {
  const best = new Map<string, T>();
  const order: string[] = [];
  for (const agent of agents) {
    const family = agentFamily(agent.id, agent.family);
    const current = best.get(family);
    if (!current) {
      order.push(family);
      best.set(family, agent);
      continue;
    }
    if (preference(agent) > preference(current)) best.set(family, agent);
  }
  return order.map((family) => best.get(family)!);
}

function preference(agent: Variant): number {
  const transport = agentTransport(agent.id, agent.transport, agent.kind);
  return (agent.available ? 10 : 0) + (3 - TRANSPORT_RANK[transport]);
}
