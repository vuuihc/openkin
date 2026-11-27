import type { UsageRow } from "../providers/providersModel";

/**
 * KIN-MOBILE-002 R6 — the usage sheet's per-agent fold.
 *
 * The signed frame (`KIN-MOBILE-002.figma/frames/05-phone-usage-sheet.svg`) gives
 * every agent a row whose bar is that agent's share of this window's spend. The
 * only fact that can carry that grouping is `UsageRow.agent`: the node already
 * attributes every row to the agent that spent the money. Provider configuration
 * is deliberately not consulted here — a configured provider with no usage has
 * no spend to draw a bar from, so it stays in the read-only provider section
 * below the rows (the screen's job), while this module reports only what was
 * actually spent.
 *
 * DOM-free and renderer-free (ADR 0036 §2): the row type is a type-only import,
 * so the fold runs in jest without a native module, and no colour or sentence
 * lives here. Identity colours and wording are the screen's (R6 visual).
 */

export type AgentUsage = {
  /** The exact `UsageRow.agent` the rows were grouped by. */
  agent: string;
  /** This agent's cost over the window; an unpriced row counts as zero. */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * `cost / totalCost`, clamped to 0..1; 0 when the window spent nothing.
   * A proportion of spend, never a proportion of tokens: the frame's bar is
   * money, and a window priced at zero has no share to divide.
   */
  share: number;
};

/**
 * Fold one window's rows into stable per-agent rows: grouped by exact
 * `row.agent`, sorted by cost descending then agent name ascending, so equal
 * spend has one deterministic order instead of the map's insertion order.
 */
export function usageByAgent(rows: readonly UsageRow[]): AgentUsage[] {
  const totals = new Map<
    string,
    { cost: number; inputTokens: number; outputTokens: number }
  >();

  for (const row of rows) {
    const entry = totals.get(row.agent) ?? {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    // `cost_usd` is nullable by contract: a row the node could not price is a
    // spend of zero, not an unknown that turns the window total into NaN.
    const cost = row.cost_usd ?? 0;
    entry.cost += Number.isFinite(cost) ? cost : 0;
    entry.inputTokens += row.tokens_in;
    entry.outputTokens += row.tokens_out;
    totals.set(row.agent, entry);
  }

  let totalCost = 0;
  for (const entry of totals.values()) totalCost += entry.cost;

  return [...totals.entries()]
    .map(([agent, entry]) => ({
      agent,
      cost: entry.cost,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      share:
        totalCost > 0
          ? Math.min(1, Math.max(0, entry.cost / totalCost))
          : 0,
    }))
    .sort((a, b) => b.cost - a.cost || a.agent.localeCompare(b.agent));
}
