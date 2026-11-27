import { describe, expect, it } from "@jest/globals";
import type { UsageRow } from "../providers/providersModel";
import { usageByAgent } from "./usageByAgent";

/**
 * KIN-MOBILE-002 R6 — the usage sheet's per-agent fold.
 *
 * The signed frame (`KIN-MOBILE-002.figma/frames/05-phone-usage-sheet.svg`) gives
 * every agent a row whose bar is that agent's share of this window's spend. The
 * rows are a fold of the window's `UsageRow[]`, not provider configuration: a
 * configured provider with no usage has no spend to draw a bar from and stays in
 * the read-only provider section below.
 *
 * The assertions restate nothing about the screen: grouping, ordering, null
 * handling and shares are this module's contract.
 */

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: "2026-11-20",
    agent: "planner",
    tasks: 2,
    tokens_in: 1000,
    tokens_out: 500,
    cost_usd: 0.03,
    request_count: 4,
    reasoning_output_tokens: 0,
    cache_read_tokens: 300,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 1200,
    cache_hit_rate: 0.25,
    cache_coverage: 1,
    cache_status: "reported",
    ...overrides,
  };
}

describe("KIN-MOBILE-002 R6 usage by agent", () => {
  it("KIN-MOBILE-002 R6: rows group by agent, sum cost and tokens, and sort by spend", () => {
    // Insertion order is deliberately not spend order: a fold that keeps the
    // map's order (codex first) must fail this row.
    const rows: UsageRow[] = [
      row({ agent: "codex", cost_usd: 0.01, tokens_in: 100, tokens_out: 50 }),
      row({ agent: "claude", cost_usd: 0.03, tokens_in: 200, tokens_out: 100 }),
      row({ agent: "claude", cost_usd: 0.06, tokens_in: 300, tokens_out: 150 }),
      row({ agent: "planner", cost_usd: 0.02, tokens_in: 10, tokens_out: 5 }),
    ];

    const folded = usageByAgent(rows);

    expect(folded.map((entry) => entry.agent)).toEqual([
      "claude",
      "planner",
      "codex",
    ]);
    const claude = folded[0]!;
    expect(claude.cost).toBeCloseTo(0.09, 10);
    expect(claude.inputTokens).toBe(500);
    expect(claude.outputTokens).toBe(250);
    // $0.09 of the window's $0.12.
    expect(claude.share).toBeCloseTo(0.75, 10);
    expect(folded[1]!.share).toBeCloseTo(1 / 6, 10);
    expect(folded[2]!.share).toBeCloseTo(1 / 12, 10);
  });

  it("KIN-MOBILE-002 R6: null cost is zero, never NaN, and a zero-cost window has zero shares", () => {
    // A row whose cost the node could not attribute is a spend of zero, not an
    // unknown that poisons the window total.
    const rows: UsageRow[] = [
      row({ agent: "codex", cost_usd: null, tokens_in: 10, tokens_out: 5 }),
      row({ agent: "claude", cost_usd: null, tokens_in: 20, tokens_out: 15 }),
    ];

    const folded = usageByAgent(rows);

    expect(folded.map((entry) => entry.agent)).toEqual(["claude", "codex"]);
    for (const entry of folded) {
      expect(Number.isNaN(entry.cost)).toBe(false);
      expect(entry.cost).toBe(0);
      expect(entry.share).toBe(0);
    }
  });

  it("KIN-MOBILE-002 R6: equal spend falls back to a stable agent-name ordering", () => {
    const rows: UsageRow[] = [
      row({ agent: "zeta", cost_usd: 0.02 }),
      row({ agent: "alpha", cost_usd: 0.02 }),
      row({ agent: "mike", cost_usd: 0.02 }),
    ];

    const folded = usageByAgent(rows);

    expect(folded.map((entry) => entry.agent)).toEqual([
      "alpha",
      "mike",
      "zeta",
    ]);
  });
});
