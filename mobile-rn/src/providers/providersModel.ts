import type { components } from "@ui/api/generated/openapi";
import { apiFetch, type TransportReason, type TransportResult } from "../api/transport";

/**
 * The generated schema is the contract and imports nothing, so this module
 * keeps the web client's dependency graph (zustand, DOM code) out of the RN
 * typecheck: `import type` from `@ui/api/client` would still make `tsc` walk
 * its imports (ADR 0036 §4's `tsc --noEmit` runs with mobile-rn deps only).
 */
export type ProviderEntry = components["schemas"]["ProviderEntry"];
export type UsageRow = components["schemas"]["UsageRow"];

/**
 * KIN-MOBILE-001 R6 — the headless core of the provider/usage sheet.
 *
 * Read-only by construction: the only requests are the two GETs the web console
 * already makes (`listProviders`, `getUsageSummary` in `ui/src/api/client.ts`).
 * The view keeps `ProviderEntry[]` and the selected window's `UsageRow[]`
 * as-is; folding them into headline numbers is the shared formatter's job
 * (`ui/src/lib/usage.ts`), not a second copy here. Reason codes, never
 * sentences: R6's screen owns the i18n mapping.
 *
 * `usage.ts` cannot be imported on this branch: the R1 import contract scans
 * identifiers, and its `contextFill` names a local parameter and property
 * `window`, so the module reads as DOM-carrying. The rows therefore travel
 * unfolded and the R6 screen folds them once the shared module is importable
 * (ADR 0036 §5 forbids copying it into `mobile-rn/`).
 */

export type UsageWindowDays = 7 | 30 | 90;

export const USAGE_WINDOWS: readonly UsageWindowDays[] = [7, 30, 90];
export const DEFAULT_USAGE_DAYS: UsageWindowDays = 30;

export type ProvidersStatus = "loading" | "ready" | "empty" | "failed" | "offline";

/** The transport's reason codes, reused so one vocabulary reaches the screen. */
export type ProvidersReason = TransportReason;

export type ProvidersError = {
  reason: ProvidersReason;
  /** The rows on screen are the last good read, not this one. */
  stale: boolean;
};

export type ProvidersView = {
  status: ProvidersStatus;
  /** The 7/30/90 window this read used; session memory only, no storage key. */
  days: UsageWindowDays;
  providers: ProviderEntry[];
  /** The window's rows exactly as the node returned them. */
  usage: UsageRow[];
  error?: ProvidersError;
  /**
   * Set when the usage read answered and only the provider list did not. A
   * paired device token may read `/api/usage/summary` and not `/api/providers`
   * (operator-only, `internal/api/api.go:528`), which is not a reason to hide
   * the numbers the sheet exists to show: the screen degrades this one block.
   */
  providerListError?: ProvidersError;
};

export type ProvidersModelOptions = {
  /** The paired node's origin, from the stored session. */
  origin: string;
  token?: string | null;
  /** Tests inject a recording fetch; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the transport's default bound (AGENTS.md §13). */
  timeoutMs?: number;
  days?: UsageWindowDays;
};

export type ProvidersModel = {
  getState(): ProvidersView;
  /** Read providers and the current window, bounded by the transport timeout. */
  load(): Promise<ProvidersView>;
  /** Switch the 7/30/90 window and read it; the choice stays in memory. */
  setWindow(days: UsageWindowDays): Promise<ProvidersView>;
  /** Drop the in-flight read, e.g. the sheet closed (AGENTS.md §11). */
  cancel(): void;
};

/** Mirrors `listProviders` in `ui/src/api/client.ts`; that module exports no path builder. */
export const providersPath = "/api/providers";

/** Mirrors `getUsageSummary` in `ui/src/api/client.ts` (`?days=`). */
export function usageSummaryPath(days: UsageWindowDays): string {
  return `/api/usage/summary?days=${days}`;
}

export function isUsageWindow(days: number): days is UsageWindowDays {
  return days === 7 || days === 30 || days === 90;
}

const CACHE_STATUSES = new Set(["reported", "unknown", "unsupported", "mixed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProviderEntry(value: unknown): value is ProviderEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    typeof value.base_url === "string" &&
    typeof value.model === "string" &&
    typeof value.stream === "boolean" &&
    typeof value.active === "boolean"
  );
}

/** `{active_id, providers}` from the node; null means the shape is unusable. */
function readProviders(raw: unknown): ProviderEntry[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.providers)) return null;
  const values: unknown[] = raw.providers;
  const providers = values.filter(isProviderEntry);
  // A list with a dropped entry would understate what the node offers, so a
  // partly malformed answer is no answer at all.
  return providers.length === values.length ? providers : null;
}

function isUsageRow(value: unknown): value is UsageRow {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value.agent === "string" &&
    isCount(value.tasks) &&
    isCount(value.tokens_in) &&
    isCount(value.tokens_out) &&
    isCount(value.request_count) &&
    isCount(value.reasoning_output_tokens) &&
    isCount(value.cache_read_tokens) &&
    isCount(value.cache_write_tokens) &&
    isCount(value.cache_eligible_input_tokens) &&
    typeof value.cache_status === "string" &&
    CACHE_STATUSES.has(value.cache_status) &&
    // The node emits these three as a number or JSON null, never a string; a
    // coerced "0.25" would otherwise reach the shared formatter as NaN%.
    (value.cost_usd === null || isCount(value.cost_usd)) &&
    (value.cache_hit_rate === null || isCount(value.cache_hit_rate)) &&
    (value.cache_coverage === null || isCount(value.cache_coverage))
  );
}

/** The summary endpoint's `UsageRow[]`; null means the shape is unusable. */
function readUsage(raw: unknown): UsageRow[] | null {
  if (!Array.isArray(raw)) return null;
  const values: unknown[] = raw;
  const rows = values.filter(isUsageRow);
  return rows.length === values.length ? rows : null;
}

function failureReason(
  providers: TransportResult<unknown>,
  usage: TransportResult<unknown>,
): ProvidersReason {
  const reasons = [providers, usage]
    .filter(
      (result): result is Extract<TransportResult<unknown>, { ok: false }> =>
        !result.ok,
    )
    .map((result) => result.reason);
  // An expired token outranks a rejected read, which outranks a dead network:
  // the first is the actionable one for the owner.
  if (reasons.includes("expired")) return "expired";
  if (reasons.includes("rejected")) return "rejected";
  return "unreachable";
}

export function createProvidersModel(options: ProvidersModelOptions): ProvidersModel {
  const origin = options.origin;
  let state: ProvidersView = {
    status: "loading",
    days: options.days ?? DEFAULT_USAGE_DAYS,
    providers: [],
    usage: [],
  };
  // Every read takes a generation before its first await. A read that lands
  // after a newer one started must not touch shared state (AGENTS.md §11):
  // switching 7 -> 30 while the 7-day answer is still in flight is the case.
  let flow = 0;
  let inFlight: AbortController | null = null;
  // The status a reader last saw settled. A cancel mid-read restores it, so a
  // sheet that closes and reopens before the next load does not sit on a
  // skeleton forever (`cancel()` is the screen telling us it is gone).
  let lastSettled: ProvidersStatus = "loading";
  let lastSettledDays: UsageWindowDays = state.days;

  async function load(days: UsageWindowDays = state.days): Promise<ProvidersView> {
    const flowId = ++flow;
    const controller = new AbortController();
    inFlight = controller;

    const hadData = state.providers.length > 0 || state.usage.length > 0;
    state = { ...state, status: "loading", days };

    const request = {
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
    };
    const [providersRead, usageRead] = await Promise.all([
      apiFetch<unknown>(origin, providersPath, request),
      apiFetch<unknown>(origin, usageSummaryPath(days), request),
    ]);

    // A late answer is dropped whole: not the status, not the rows, not the
    // error. The newer flow already owns the view.
    if (flowId !== flow) return state;
    inFlight = null;

    if (!providersRead.ok || !usageRead.ok) {
      const reason = failureReason(providersRead, usageRead);
      // An expired token is a pairing state, not a transient failure: the
      // signed table's `未配对 / 过期` row says that surface shows no old usage
      // (`不显示旧用量`), the same way `pairing.ts` drops its cached tasks on
      // 401. Every other reason keeps the last good rows instead, and those
      // rows belong to the window that last settled -- `state.days` already
      // moved to the window this read asked for and never got.
      const expired = reason === "expired";
      if (!expired && usageRead.ok && !providersRead.ok) {
        // The provider list alone failed: a device token is not allowed to
        // read `/api/providers` and the usage read answered, so degrade one
        // block rather than telling the owner the pairing link is invalid.
        // A usage failure and an expired token still fail the whole sheet:
        // the numbers are the subject, and a token state is a pairing state.
        const usage = readUsage(usageRead.data);
        if (usage !== null) {
          state = {
            // Never "empty": with the list unreadable the device's provider
            // count is unknowable, so a quiet window is a ready one.
            status: "ready",
            days,
            providers: state.providers,
            usage,
            providerListError: {
              reason: providersRead.reason,
              stale: state.providers.length > 0,
            },
          };
          lastSettled = state.status;
          lastSettledDays = state.days;
          return state;
        }
      }
      state = {
        ...state,
        status: reason === "unreachable" ? "offline" : "failed",
        days: hadData ? lastSettledDays : state.days,
        providers: expired ? [] : state.providers,
        usage: expired ? [] : state.usage,
        error: { reason, stale: hadData && !expired },
        // A block-level notice never outlives a whole-sheet failure.
        providerListError: undefined,
      };
      lastSettled = state.status;
      lastSettledDays = state.days;
      return state;
    }

    const providers = readProviders(providersRead.data);
    const usage = readUsage(usageRead.data);
    if (providers === null || usage === null) {
      // The node answered 2xx with a shape this client cannot read. Treat it
      // like a rejected read: keep the last good rows and say the refresh
      // failed, rather than showing a half-read sheet.
      state = {
        ...state,
        status: "failed",
        days: hadData ? lastSettledDays : state.days,
        error: { reason: "rejected", stale: hadData },
        providerListError: undefined,
      };
      lastSettled = state.status;
      lastSettledDays = state.days;
      return state;
    }

    // "Empty" is the device-level message ("this device has no usage yet"):
    // a configured provider with a quiet window stays `ready`, and the screen
    // can still say the window itself is empty because `usage` is [].
    // Built fresh, so a provider-list error from an older read is dropped.
    state = {
      status: providers.length === 0 && usage.length === 0 ? "empty" : "ready",
      days,
      providers,
      usage,
    };
    lastSettled = state.status;
    lastSettledDays = state.days;
    return state;
  }

  return {
    getState: () => state,
    load: () => load(),
    setWindow: (days) => (isUsageWindow(days) ? load(days) : load()),
    cancel: () => {
      // Bumping the generation is the real cancellation: even a fetch that
      // ignores the abort cannot land on this view.
      flow += 1;
      inFlight?.abort();
      inFlight = null;
      state = { ...state, status: lastSettled, days: lastSettledDays };
    },
  };
}
