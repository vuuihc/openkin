# ADR 0006: Request-level usage ledger and optional limit snapshots

**Status:** Accepted
**Date:** 2026-07-18

## Context

Kin already stores task-level input tokens, output tokens, and cost. Agent and
provider events also contain richer data, including Codex cached input tokens,
Claude cache reads, and Kin provider cache hits. Those fields are not
normalized or aggregated, so the console cannot show a trustworthy cache hit
rate or explain the effect of retries, follow-ups, tool rounds, or
orchestration.

Account usage limits are a related but different signal. Per-request token
usage is reported by an inference response. Subscription or API limits describe
an account-scoped quota window and may only be available through a provider
control API. Treating one as a substitute for the other would be misleading.

## Decision

1. Add an append-only `usage_records` ledger. One row represents one
   provider-reported model call or one adapter turn when finer granularity is
   unavailable.
2. Link every row to the persisted task event that produced it with the
   idempotent key `(task_id, event_seq)`.
3. Normalize token classes while retaining the provider's input semantics:
   total-input-includes-cache, uncached-input-only, or unknown.
4. Preserve `tasks.tokens_in`, `tasks.tokens_out`, and `tasks.cost_usd` as a
   denormalized compatibility/read model, updated transactionally with the
   ledger.
5. Represent cache availability explicitly. A reported zero, an unknown value,
   and an unsupported capability are different states.
6. Compute cache hit rate only over records whose cache and input semantics are
   known. Surface the coverage of that calculation.
7. Keep provider/account limits in a separate optional `limit_snapshots`
   capability. Do not infer subscription headroom from token totals.

## Consequences

### Positive

- Task, agent, model, and time-range views can use the same source of truth.
- Cache optimization and orchestration comparisons become measurable.
- Retry and multi-round provider usage can be attributed without inflating
  totals from cumulative result events.
- Old clients remain compatible with additive task and usage API fields.
- Providers that do not expose cache or account limits degrade explicitly.

### Negative

- The engine must distinguish incremental `usage` events from cumulative
  `result` events to avoid double counting.
- SQLite writes become slightly more complex because event, ledger, and task
  summary updates must share a transaction.
- Historical tasks cannot gain reliable cache metrics unless their original
  events contain enough information for a future explicit backfill.

### Neutral

- The first implementation does not require a mandatory inference gateway.
- Cost accuracy remains source-dependent. Provider-reported cost is
  authoritative; price-table cost is an estimate and must be labeled as such.

## Alternatives considered

### Add cache columns only to `tasks`

Rejected because it loses per-call, per-model, retry, and orchestration detail
and cannot support later efficiency analysis without another migration.

### Parse metrics from the event table at read time

Rejected because every query would repeat provider-specific parsing, historical
payload shapes would become an API concern, and aggregate queries would be
expensive and difficult to validate.

### Require all traffic to pass through a Kin gateway

Deferred. It provides complete telemetry for direct API traffic but would break
the current separation between CLI agent adapters and cognition providers and
would make a gateway a prerequisite for local-first operation.

## References

- `PRINCIPLE.md` §5.3 and §5.10
- `SYSTEM_DESIGN.md` §2–§4
- `docs/adr/0001-provider-and-kin-agent.md`
- `docs/plans/2026-07-18-token-efficiency-observability-design.md`
