import { describe, expect, it, jest } from "@jest/globals";
import { summarizeUsage } from "../../../ui/src/lib/usage";
import {
  createProvidersModel,
  providersPath,
  usageSummaryPath,
  type ProviderEntry,
  type ProvidersModelOptions,
  type UsageRow,
} from "./providersModel";

/**
 * `summarizeUsage` is imported statically, in place (ADR 0036 §2).
 *
 * `ui/src/lib/usage.ts` names no module — its fold input type is declared
 * beside it — so this import adds nothing to the RN typecheck's closure: the
 * light gate (`npx tsc --noEmit` with mobile-rn's deps only) follows it without
 * reaching the web client. That is also how the R6 screen will call it, so this
 * file is the compile-time proof that the shared module is importable. The
 * import-contract test pins both halves: no module specifiers, no browser
 * globals.
 */

/**
 * KIN-MOBILE-001 R6 — the headless provider/usage sheet core.
 *
 * The signed row (story §7) asks for a read-only sheet: the provider list, one
 * 7/30/90-day usage window, model and cost. These tests cover the four view
 * states, a refresh that fails after a good read, the expired token, the two
 * AGENTS.md bounds (a late answer from an older flow is dropped; every wait has
 * a timeout), and that the core never issues a write.
 *
 * `summarizeUsage` folds the rows here, not in the model: R6 forwards the
 * window's rows and this test proves they fold to the shared formatter's
 * numbers.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

/** Fixed window fixture: two days, 3 tasks, 6 requests, $0.06. */
const USAGE_ROWS: UsageRow[] = [
  {
    date: "2026-11-20",
    agent: "planner",
    tasks: 2,
    tokens_in: 1200,
    tokens_out: 800,
    cost_usd: 0.042,
    request_count: 4,
    reasoning_output_tokens: 0,
    cache_read_tokens: 300,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 1200,
    cache_hit_rate: 0.25,
    cache_coverage: 1,
    cache_status: "reported",
  },
  {
    date: "2026-11-21",
    agent: "planner",
    tasks: 1,
    tokens_in: 600,
    tokens_out: 400,
    cost_usd: 0.018,
    request_count: 2,
    reasoning_output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 600,
    cache_hit_rate: 0,
    cache_coverage: 1,
    cache_status: "reported",
  },
];

const PROVIDERS: ProviderEntry[] = [
  {
    id: "provider-primary",
    name: "Primary fixture",
    kind: "openai-compatible",
    base_url: "https://llm.example.com/v1",
    model: "fixture-large",
    stream: true,
    active: true,
    models: [{ id: "fixture-large", tier: "smart", cost_label: "paid" }],
  },
  {
    id: "provider-fast",
    name: "Fast fixture",
    kind: "openai-compatible",
    base_url: "https://llm.example.com/v1",
    model: "fixture-small",
    stream: false,
    active: false,
  },
];

const OTHER_PROVIDER: ProviderEntry = {
  id: "provider-other",
  name: "Other fixture",
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  model: "fixture-other",
  stream: true,
  active: true,
};

type Call = { url: string; init?: RequestInit };

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * A node that answers both reads from the given bodies. Per-path statuses are
 * optional; without them both reads share `status` (the existing cases).
 */
function nodeFetch(options: {
  providers?: unknown;
  usage?: unknown;
  status?: () => number;
  providersStatus?: () => number;
  usageStatus?: () => number;
  calls?: Call[];
}) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    options.calls?.push({ url, init });
    const providersRead = url.includes("/api/providers");
    const status =
      (providersRead ? options.providersStatus : options.usageStatus)?.() ??
      options.status?.() ??
      200;
    if (status !== 200) return response(status, { error: "fixture" });
    const body = providersRead ? options.providers : options.usage;
    return response(200, body);
  });
}

function modelWith(impl: unknown, overrides: Partial<ProvidersModelOptions> = {}) {
  return createProvidersModel({
    origin: ORIGIN,
    token: TOKEN,
    fetchImpl: impl as typeof fetch,
    ...overrides,
  });
}

describe("KIN-MOBILE-001 R6 provider/usage core", () => {
  it("KIN-MOBILE-001 R6: ready reads the provider list and the usage window", async () => {
    const calls: Call[] = [];
    const model = modelWith(
      nodeFetch({ providers: { active_id: "provider-primary", providers: PROVIDERS }, usage: USAGE_ROWS, calls }),
    );

    const view = await model.load();

    expect(view.status).toBe("ready");
    expect(view.days).toBe(30);
    expect(view.providers).toEqual(PROVIDERS);
    expect(view.usage).toEqual(USAGE_ROWS);
    expect(view.error).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${ORIGIN}${providersPath}`,
      `${ORIGIN}${usageSummaryPath(30)}`,
    ]);
  });

  it("KIN-MOBILE-001 R6: usage values match the shared formatter output", async () => {
    const model = modelWith(
      nodeFetch({ providers: { active_id: "", providers: PROVIDERS }, usage: USAGE_ROWS }),
    );

    const view = await model.load();
    const shared = summarizeUsage(view.usage);

    // The model forwards the window's rows; the shared fold over them is the
    // number the sheet will draw, pinned literally so a fixture drift is red.
    expect(shared).toEqual(summarizeUsage(USAGE_ROWS));
    expect(shared.cost).toBeCloseTo(0.06, 10);
    expect(shared.tokens).toBe(3000);
    expect(shared.tasks).toBe(3);
    expect(shared.requests).toBe(6);
    expect(shared.empty).toBe(false);
  });

  it("KIN-MOBILE-001 R6: 7/30/90 refetches that window and keeps the choice in memory", async () => {
    const calls: Call[] = [];
    const usageByDays: Record<number, UsageRow[]> = {
      7: [USAGE_ROWS[1]],
      30: USAGE_ROWS,
      90: [...USAGE_ROWS, { ...USAGE_ROWS[0], date: "2026-11-01", cost_usd: 0.03 }],
    };
    const impl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/api/providers")) {
        return response(200, { active_id: "provider-primary", providers: PROVIDERS });
      }
      const days = Number(new URL(url).searchParams.get("days"));
      return response(200, usageByDays[days]);
    });
    const model = modelWith(impl);

    await model.load();
    expect(model.getState().usage).toHaveLength(2);

    const week = await model.setWindow(7);
    expect(week.days).toBe(7);
    expect(week.usage).toHaveLength(1);

    const quarter = await model.setWindow(90);
    expect(quarter.days).toBe(90);
    expect(quarter.usage).toHaveLength(3);

    expect(model.getState().days).toBe(90);
    expect(calls.some((call) => call.url.endsWith("/api/usage/summary?days=7"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/api/usage/summary?days=90"))).toBe(true);
  });

  it("KIN-MOBILE-001 R6: a device with no providers and no usage reads as empty", async () => {
    const model = modelWith(
      nodeFetch({ providers: { active_id: "", providers: [] }, usage: [] }),
    );

    const view = await model.load();

    expect(view.status).toBe("empty");
    expect(view.providers).toEqual([]);
    expect(view.usage).toEqual([]);
    expect(summarizeUsage(view.usage).empty).toBe(true);
  });

  it("KIN-MOBILE-001 R6: a failed refresh keeps the last good rows and marks them stale", async () => {
    let status = 200;
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "provider-primary", providers: PROVIDERS },
        usage: USAGE_ROWS,
        status: () => status,
      }),
    );

    const first = await model.load();
    expect(first.status).toBe("ready");

    status = 403;
    const second = await model.load();

    expect(second.status).toBe("failed");
    expect(second.error).toEqual({ reason: "rejected", stale: true });
    expect(second.providers).toEqual(PROVIDERS);
    expect(second.usage).toEqual(USAGE_ROWS);
  });

  it("KIN-MOBILE-001 R6: a failed window switch keeps the settled window beside the kept rows", async () => {
    const impl = jest.fn(async (url: string) => {
      if (new URL(url).searchParams.get("days") === "90") {
        return response(403, { error: "fixture" });
      }
      return url.includes("/api/providers")
        ? response(200, { active_id: "provider-primary", providers: PROVIDERS })
        : response(200, USAGE_ROWS);
    });
    const model = modelWith(impl);

    const first = await model.load();
    expect(first.status).toBe("ready");
    expect(first.days).toBe(30);

    const failed = await model.setWindow(90);

    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ reason: "rejected", stale: true });
    // The rows on screen are the 30-day read's: the selection must not stay on
    // the 90-day window that never answered.
    expect(failed.days).toBe(30);
    expect(failed.usage).toEqual(USAGE_ROWS);

    // A close/reopen restores that same settled window, not the failed one.
    model.cancel();
    expect(model.getState().days).toBe(30);
    expect(model.getState().usage).toEqual(USAGE_ROWS);
  });

  it("KIN-MOBILE-001 R6: an unreadable window answer keeps the settled window too", async () => {
    const impl = jest.fn(async (url: string) => {
      if (new URL(url).searchParams.get("days") === "90") {
        return response(200, [{ date: 1 }]);
      }
      return url.includes("/api/providers")
        ? response(200, { active_id: "provider-primary", providers: PROVIDERS })
        : response(200, USAGE_ROWS);
    });
    const model = modelWith(impl);

    await model.load();
    const failed = await model.setWindow(90);

    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ reason: "rejected", stale: true });
    expect(failed.days).toBe(30);
    expect(failed.usage).toEqual(USAGE_ROWS);
  });

  it("KIN-MOBILE-001 R6: an expired token reads as failed/expired and is not retried", async () => {
    const calls: Call[] = [];
    const model = modelWith(nodeFetch({ status: () => 401, calls }));

    const view = await model.load();

    expect(view.status).toBe("failed");
    expect(view.error).toEqual({ reason: "expired", stale: false });
    // One load is exactly two reads; a 401 is never retried silently.
    expect(calls).toHaveLength(2);
  });

  it("KIN-MOBILE-001 R6: an expired token after a good read clears the old usage", async () => {
    let status = 200;
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "provider-primary", providers: PROVIDERS },
        usage: USAGE_ROWS,
        status: () => status,
      }),
    );

    const first = await model.load();
    expect(first.status).toBe("ready");

    status = 401;
    const expired = await model.load();

    // The signed state table's `未配对 / 过期` row: the surface shows no old
    // usage once the token is gone, so neither the view nor the model keeps any.
    expect(expired.status).toBe("failed");
    expect(expired.error).toEqual({ reason: "expired", stale: false });
    expect(expired.providers).toEqual([]);
    expect(expired.usage).toEqual([]);
    expect(model.getState().providers).toEqual([]);
    expect(model.getState().usage).toEqual([]);
  });

  it("KIN-MOBILE-001 R6: an unreachable node reads as offline", async () => {
    let online = true;
    const impl = jest.fn(async () => {
      if (!online) throw new TypeError("Network request failed");
      return response(200, { active_id: "", providers: [] });
    });
    const model = modelWith(impl);

    online = false;
    const view = await model.load();

    expect(view.status).toBe("offline");
    expect(view.error).toEqual({ reason: "unreachable", stale: false });
    expect(view.providers).toEqual([]);
    expect(view.usage).toEqual([]);
  });

  it("KIN-MOBILE-001 R6: a late answer from an older flow is dropped", async () => {
    const pending: { url: string; respond: (body: unknown) => void }[] = [];
    const impl = jest.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, respond: (body) => resolve(response(200, body)) });
        }),
    );
    const model = modelWith(impl, { days: 7 });

    const older = model.load();
    const newer = model.setWindow(30);

    // Calls: 0 provider/7, 1 usage/7, 2 provider/30, 3 usage/30.
    expect(pending).toHaveLength(4);
    pending[2].respond({ active_id: "provider-other", providers: [OTHER_PROVIDER] });
    pending[3].respond([USAGE_ROWS[0]]);
    const fresh = await newer;
    expect(fresh.days).toBe(30);
    expect(fresh.providers).toEqual([OTHER_PROVIDER]);

    // The older flow answers only now; it must not overwrite the newer view.
    pending[0].respond({ active_id: "provider-primary", providers: PROVIDERS });
    pending[1].respond(USAGE_ROWS);
    const late = await older;

    expect(late.days).toBe(30);
    expect(late.providers).toEqual([OTHER_PROVIDER]);
    expect(late.usage).toEqual([USAGE_ROWS[0]]);
    expect(model.getState().providers).toEqual([OTHER_PROVIDER]);
  });

  it("KIN-MOBILE-001 R6: a stalled read is bounded and reads as offline", async () => {
    const hanging = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const model = modelWith(hanging, { timeoutMs: 20 });

    const view = await model.load();

    expect(view.status).toBe("offline");
    expect(view.error).toEqual({ reason: "unreachable", stale: false });
    const firstInit = (hanging.mock.calls[0] as [string, RequestInit])[1];
    expect(firstInit.signal?.aborted).toBe(true);
  });

  it("KIN-MOBILE-001 R6: only read endpoints are used", async () => {
    const calls: Call[] = [];
    const model = modelWith(
      nodeFetch({ providers: { active_id: "", providers: PROVIDERS }, usage: USAGE_ROWS, calls }),
    );

    await model.load();
    await model.setWindow(90);

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.init?.method ?? "GET").toBe("GET");
      expect(call.init?.body).toBeUndefined();
    }
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/providers",
      "/api/usage/summary",
      "/api/providers",
      "/api/usage/summary",
    ]);
  });

  it("KIN-MOBILE-001 R6: a coerced cache rate is rejected, not drawn as NaN%", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "", providers: PROVIDERS },
        usage: [{ ...USAGE_ROWS[0], cache_hit_rate: "0.25" }],
      }),
    );

    const view = await model.load();

    expect(view.status).toBe("failed");
    expect(view.error).toEqual({ reason: "rejected", stale: false });
    expect(view.usage).toEqual([]);
  });

  it("KIN-MOBILE-001 R6: cancel restores the settled window and drops the in-flight answer", async () => {
    let calls = 0;
    const impl = jest.fn((url: string, init?: RequestInit) => {
      calls += 1;
      if (calls <= 2) {
        return Promise.resolve(
          url.includes("/api/providers")
            ? response(200, { active_id: "", providers: PROVIDERS })
            : response(200, USAGE_ROWS),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const model = modelWith(impl);
    await model.load();
    expect(model.getState().status).toBe("ready");

    const pending = model.setWindow(90);
    expect(model.getState().status).toBe("loading");
    expect(model.getState().days).toBe(90);

    model.cancel();
    // The sheet is gone, but reopening before the next read shows the rows it
    // last settled on — and the window those rows belong to — not a skeleton
    // that never resolves beside a selection it never read.
    expect(model.getState().status).toBe("ready");
    expect(model.getState().days).toBe(30);
    expect(model.getState().usage).toEqual(USAGE_ROWS);

    const dropped = await pending;
    expect(dropped.status).toBe("ready");
    expect(dropped.days).toBe(30);
    expect(dropped.usage).toEqual(USAGE_ROWS);
  });

  /**
   * A paired device token may read `/api/usage/summary` and not
   * `/api/providers` (operator-only, `internal/api/api.go:528`). The numbers are
   * the sheet's subject, so that 403 degrades one block, not the sheet.
   */
  it("KIN-MOBILE-001 R6: a rejected provider list keeps the usage numbers (device token)", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "", providers: PROVIDERS },
        usage: USAGE_ROWS,
        providersStatus: () => 403,
      }),
    );

    const view = await model.load();

    expect(view.status).toBe("ready");
    expect(view.days).toBe(30);
    expect(view.usage).toEqual(USAGE_ROWS);
    // A device token never had a provider list to lose.
    expect(view.providers).toEqual([]);
    // The whole-sheet failure -- and its "link invalid" sentence -- must not fire.
    expect(view.error).toBeUndefined();
    expect(view.providerListError).toEqual({ reason: "rejected", stale: false });
  });

  it("KIN-MOBILE-001 R6: a rejected provider list cannot claim an empty device", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "", providers: PROVIDERS },
        usage: [],
        providersStatus: () => 403,
      }),
    );

    const view = await model.load();

    // With the list unreadable, "this device has no providers" is unknowable:
    // a quiet window is `ready`, never the device-level `empty`.
    expect(view.status).toBe("ready");
    expect(view.usage).toEqual([]);
    expect(view.providerListError).toEqual({ reason: "rejected", stale: false });
  });

  it("KIN-MOBILE-001 R6: a usage failure still fails the whole sheet", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "provider-primary", providers: PROVIDERS },
        usage: USAGE_ROWS,
        usageStatus: () => 403,
      }),
    );

    const view = await model.load();

    // The boundary this change must not cross: the usage read is the sheet.
    expect(view.status).toBe("failed");
    expect(view.error).toEqual({ reason: "rejected", stale: false });
    expect(view.providerListError).toBeUndefined();
  });

  it("KIN-MOBILE-001 R6: an expired provider read is a pairing state, not a section", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "provider-primary", providers: PROVIDERS },
        usage: USAGE_ROWS,
        providersStatus: () => 401,
      }),
    );

    const view = await model.load();

    // A token state is a pairing state: the whole sheet says so and keeps
    // nothing, even though the usage read answered.
    expect(view.status).toBe("failed");
    expect(view.error).toEqual({ reason: "expired", stale: false });
    expect(view.providers).toEqual([]);
    expect(view.usage).toEqual([]);
    expect(view.providerListError).toBeUndefined();
  });

  it("KIN-MOBILE-001 R6: a later good read clears the provider-list error", async () => {
    let providersStatus = 403;
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "provider-primary", providers: PROVIDERS },
        usage: USAGE_ROWS,
        providersStatus: () => providersStatus,
      }),
    );

    const degraded = await model.load();
    expect(degraded.providerListError).toEqual({
      reason: "rejected",
      stale: false,
    });

    providersStatus = 200;
    const healed = await model.load();

    expect(healed.status).toBe("ready");
    expect(healed.providerListError).toBeUndefined();
    expect(healed.providers).toEqual(PROVIDERS);
    expect(healed.usage).toEqual(USAGE_ROWS);
  });

  it("KIN-MOBILE-001 R6: an unreachable provider read degrades only the provider block", async () => {
    const model = modelWith(
      nodeFetch({
        providers: { active_id: "", providers: PROVIDERS },
        usage: USAGE_ROWS,
        providersStatus: () => 500,
      }),
    );

    const view = await model.load();

    expect(view.status).toBe("ready");
    expect(view.usage).toEqual(USAGE_ROWS);
    expect(view.providerListError).toEqual({
      reason: "unreachable",
      stale: false,
    });
  });
});
