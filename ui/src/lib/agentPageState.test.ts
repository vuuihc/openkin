import { describe, expect, it } from "vitest";
import {
  readAgentPagePrefs,
  readConnectedFamilies,
  readQuotaWaitSince,
  writeAgentPagePrefs,
  writeConnectedFamilies,
  writeQuotaWaitSince,
} from "./agentPageState";

/**
 * The agents console's memory (KIN-AGENTS-001).
 *
 * Everything here is convenience, never truth, so the interesting cases are
 * the ones where storage is missing, malformed or hostile: a private window
 * must cost a seeded first paint, not a crash, and an empty catalog must
 * survive a reload as a decision rather than being reseeded.
 */

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

/** A storage whose accessor throws, as blocked site data does. */
const hostile = {
  getItem: (): string | null => {
    throw new Error("access denied");
  },
  setItem: (): void => {
    throw new Error("access denied");
  },
};

describe("the stored catalog (KIN-AGENTS-001)", () => {
  it("tells never-stored apart from deliberately empty", () => {
    const store = memory();
    expect(readConnectedFamilies(store)).toBeNull();

    writeConnectedFamilies([], store);
    // `[]` is an answer: the person removed everything, and a reload must not
    // resurrect the seed.
    expect(readConnectedFamilies(store)).toEqual([]);

    writeConnectedFamilies(["claude", "codex"], store);
    expect(readConnectedFamilies(store)).toEqual(["claude", "codex"]);
  });

  it("treats malformed entries as never stored", () => {
    expect(readConnectedFamilies(memory({ "kin_agents_connected:v1": "{" }))).toBeNull();
    expect(readConnectedFamilies(memory({ "kin_agents_connected:v1": '"claude"' }))).toBeNull();
    expect(
      readConnectedFamilies(
        memory({ "kin_agents_connected:v1": '["claude", 3, "  ", null, "codex"]' }),
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("survives storage that throws on read and on write", () => {
    expect(readConnectedFamilies(hostile)).toBeNull();
    expect(() => writeConnectedFamilies(["claude"], hostile)).not.toThrow();
  });
});

describe("the remembered interval and sort (KIN-AGENTS-001)", () => {
  it("round-trips the three preferences", () => {
    const store = memory();
    writeAgentPagePrefs({ days: 30, sortKey: "tokens", sortDir: "asc" }, store);
    expect(readAgentPagePrefs(store)).toEqual({ days: 30, sortKey: "tokens", sortDir: "asc" });
  });

  it("drops values a newer version stopped offering", () => {
    const store = memory({
      "kin_agents_prefs:v1": JSON.stringify({
        days: 45,
        sortKey: "costPerTask",
        sortDir: "sideways",
      }),
    });
    expect(readAgentPagePrefs(store)).toEqual({});
    expect(readAgentPagePrefs(memory({ "kin_agents_prefs:v1": "nope" }))).toEqual({});
    expect(readAgentPagePrefs(hostile)).toEqual({});
  });
});

describe("the watched quota wait (KIN-AGENTS-001)", () => {
  it("is keyed by the period, so a new day starts over", () => {
    const store = memory();
    const at = Date.UTC(2026, 10, 11, 8, 0, 0);
    writeQuotaWaitSince("codex", "2026-11-11T00:00:00.000Z", at, store);
    expect(readQuotaWaitSince("codex", "2026-11-11T00:00:00.000Z", store)).toBe(at);
    expect(readQuotaWaitSince("codex", "2026-11-12T00:00:00.000Z", store)).toBeNull();
    expect(readQuotaWaitSince("claude-code", "2026-11-11T00:00:00.000Z", store)).toBeNull();
  });

  it("ignores malformed entries instead of inventing a wait", () => {
    const store = memory({ "kin_agents_quota_wait:v1": '{"codex|p": "soon"}' });
    expect(readQuotaWaitSince("codex", "p", store)).toBeNull();
    expect(readQuotaWaitSince("codex", "p", hostile)).toBeNull();
  });

  it("evicts the oldest observation, never the one still being watched", () => {
    const store = memory();
    const base = Date.UTC(2026, 10, 1);
    // One long wait is written first, then a stream of other agents, then the
    // same wait is refreshed because it is still ongoing. Its key is the
    // oldest, its observation the newest: a key-order prune would delete the
    // one entry the page is still reading.
    writeQuotaWaitSince("long-waiter", "p0", base, store);
    for (let i = 1; i <= 39; i++) {
      writeQuotaWaitSince(`agent-${i}`, `p${i}`, base + i * 60_000, store);
    }
    writeQuotaWaitSince("long-waiter", "p0", base + 39 * 60_000 + 1, store);
    for (let i = 40; i <= 45; i++) {
      writeQuotaWaitSince(`agent-${i}`, `p${i}`, base + i * 60_000, store);
    }

    expect(readQuotaWaitSince("long-waiter", "p0", store)).toBe(base + 39 * 60_000 + 1);
    // The newest 40 survive; the six oldest observations went first.
    expect(readQuotaWaitSince("agent-45", "p45", store)).toBe(base + 45 * 60_000);
    expect(readQuotaWaitSince("agent-7", "p7", store)).toBe(base + 7 * 60_000);
    expect(readQuotaWaitSince("agent-6", "p6", store)).toBeNull();
  });
});
