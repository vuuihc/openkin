# RSI model routing and necessity policy

CEO 2026-11-15 (Asia/Singapore), strong-review order amended 2026-11-28. Ethan: default to DeepSeek; use stronger models only when necessary, and judge necessity carefully. For that necessary work, take the subscription route that fits the role: the ordinary standing strong review starts on `gpt-6.1-sol` (Codex, ChatGPT) while its allowance is available, and falls back to Gemini 4 Hydrogen (Antigravity; strong and durable; multimodal, so it is also the UX vision reviewer) when Codex is limited. UX vision reviews and the high-stakes class start on Hydrogen; Carbon is the further independent opinion in every order, with Kimi last because it spends the company Volcengine key. Do not default to the highest Hydrogen tier: medium for normal strong and UX reviews; high only for F1–F4 / S1–S3 / architecture, or a second strong pass after disagreement. Never xhigh by default.

This file is the policy. `runtime/escalate.py` enforces it and logs every decision and outcome. `runtime/dispatch.sh` / `run.sh` apply it. Revert: restore `common.sh` model vars and drop the escalate hooks; see `DECISIONS.md`.

## Default (no escalation)

| Role | Model | Effort | Cost source |
|---|---|---|---|
| Worker / rework | DeepSeek V4.1 Flash | `--effort high` | Volcengine (cheap; official off-peak ¥1 / ¥0.02 / ¥4 per M) |
| Director, fill, planner, dream, first merge reviewer | DeepSeek V4.1 Flash | `--effort max` | Volcengine (same list prices; max uses more thinking tokens) |
| Second code reviewer (`reviewer-alt`, risky paths or >500 lines) | `gpt-6.1-sol` (Codex, ChatGPT) first; `agy/gemini-4-hydrogen-medium` when `state/sol-limited-until` is set (or `hydrogen-high` for F/S/architecture or disagreement) | — | ChatGPT subscription first, Antigravity consumer sign-in as fallback. Neither is Volcengine. Standing “different family” requirement. |
| UX vision reviewer | `agy/gemini-4-hydrogen-medium` (Hydrogen is multimodal; `hydrogen-high` for F/S/architecture) | — | Same Antigravity account. `gpt-6.1-sol` via `claude -p` is the fallback if Hydrogen/agy is limited. |

**Kimi is the advisor, not the daily loop (Ethan 2026-11-17).** No worker, rework, director, fill, planner or dream run resolves to Kimi: `runtime/common.sh` pins `ANTHROPIC_DEFAULT_OPUS_MODEL` to DeepSeek so even a Claude Code internal "opus" turn stays cheap, and the global `~/.claude` mapping is not inherited by loop processes. The one routine Kimi caller is the CEO advisor (≤1 per patrol, ≤3 per day, `pi -p --model magpie/auto/kimi-k3.1-pro`); the only other case is item 4 below, as the last resort.

Do not start from Kimi or Carbon. DeepSeek at `--effort max` is the first lever for harder control-plane work. The ordinary standing strong review starts on `gpt-6.1-sol` while its allowance is available and falls back to Hydrogen-medium when `state/sol-limited-until` is set; UX vision and the high-stakes class still start on Hydrogen (see below).

## When escalation is necessary

Escalate only when at least one concrete signal is present, and spend at most **one strong-model review per PR per new head SHA**. If the head has not changed since the last strong review, reuse that verdict and fix-list; never re-run. Vague “this seems hard” is not a signal. A build, test, format, inventory, or merge-conflict failure is **not** a signal by itself — those go to the mechanical auto-fix path, then a DeepSeek-max diagnosis.

1. **Reviewer disagreement** — only when DeepSeek already `PASS`ed and a gate or another reviewer `FAIL`ed **on substance** (a typecheck/test/build failure, a strong-review FAIL with blocker/major findings, or a UX-gate FAIL). A mechanical gate failure (Prettier, dirty-tree, format, inventory baseline, merge conflict) is not disagreement. A DeepSeek `FAIL` is not disagreement: it already found the issue.
2. **2nd+ rework round on substance** — `state/merge/<slug>.attempts >= 2` (mechanical sendbacks do not increment this). Still only one strong review per head SHA.
3. **Foundation / shell slices** — item is Astryx F1–F4 or S1–S3 (not F5a or later shell).
4. **Gate-level failure DeepSeek could not diagnose** — escalate only if DeepSeek-max already made a real diagnosis attempt and explicitly said it cannot find the cause (`VERDICT: UNSURE`, `DEEPSEEK_DIAGNOSIS: UNDIAGNOSED`, or equivalent). A `GATE_RESULT=FAIL` for typecheck, tests, or build, by itself, must not trigger escalation.
5. **Cross-cutting architecture or deps** — the change spans three or more top-level areas (`ui/`, `internal/`, `desktop/`, `mobile/`, `cmd/`, `rsi/runtime/`), the brief/sendback marks an architecture / ADR decision, or the diff touches `go.mod` / `ui/package.json`. Ordinary fill pulses do not escalate.

## Which strong model (role fit, then cost)

Once a signal fires, pick the first model that fits and is available. Cost source is part of the fit: prefer a subscription that is not the Volcengine key. The order follows the role, not one global list:

1. **Ordinary standing code review** (`reviewer` / `reviewer-alt`, no high-stakes reason) — **`gpt-6.1-sol` first** (ChatGPT Plus via Codex, or `claude -p` when an image is attached). This is the standing strong reviewer while the ChatGPT allowance is available. A `state/sol-limited-until` marker skips it and falls back to Hydrogen-medium, then Carbon. Kimi stays last.
2. **UX vision review** (`ux-*`) — **Hydrogen first**, unchanged: `agy gemini-4-hydrogen-medium` (`gemini-4-hydrogen-high` for F1–F4 / S1–S3, architecture-marked or cross-cutting work, or a second strong pass after disagreement). Hydrogen is the multimodal route the UX gate is built on (`runtime/ux-gate.sh:8`); native `codex exec` is text-only and `claude -p` on `gpt-6.1-sol` is the documented fallback. Invoked non-interactively with `agy -p --model <id> --output-format json --sandbox --disable-slash-commands` under the local Antigravity Google consumer sign-in (zshisme; no GCP quota project). The PR diff is attached inline (and as a file) so the model does not need Bash; `read_file` is allowed so UX reviews can open screenshots. This is not the Factory/Droid alias `factory/gemini-4-*` (do not use those from this loop).
3. **High-stakes class** (`astryx-foundation*`, `architecture*`, `reviewer-disagreement`) — **`hydrogen-high` first**, then Hydrogen-medium, then Codex, then Carbon. The class deliberately buys the strongest tier, and a `reviewer-disagreement` second pass must not re-run Codex: now that Codex gives the standing first opinion, a same-model pass would not be a second opinion. Never `gemini-4-hydrogen-xhigh` by default.
4. **Carbon** (Antigravity `gemini-4-carbon-high`) — the next independent opinion in every order, same `agy` path, same consumer sign-in.
5. **Kimi k3.1 pro last** in every order. Company Volcengine key, official list CNY. Only if Codex, Hydrogen and Carbon are all unavailable (missing CLI, auth, or API/quota error) **and** today’s Kimi list CNY is under ¥150 (`RSI_VOLC_KIMI_DAY_MAX`) **and** overall Volcengine list CNY is under ¥450 (`RSI_VOLC_KIMI_MAX`). Otherwise stay on the last working subscription model.

## Tiered review (CEO 2026-11-15, `runtime/review-tier.py`)

Review cost follows risk; nothing else about the gate changes.

| Tier | When | Reviewer |
|---|---|---|
| small | pure refactor/extract (or ≤ 400 lines), no deps/migrations/auth/persist/permission, no routing-contract files, tests only added, item not F/S/N/Q3a, rework < 2 | one DeepSeek `--effort max` review; only rework ≥ 2 may escalate; `VERDICT: UNSURE` → `reviewer-alt` once (Codex first; the small tier stays DeepSeek-only while sol is limited) |
| medium | not small, ≤ 500 lines (or a refactor/extract ≤ 800 with modified tests), nothing risky | DeepSeek `--effort max`, normal necessity signals |
| large | risky paths, > 500 lines, F/S/N/Q3a items, 2+ rework rounds | Codex first for an ordinary review (Hydrogen-medium fallback when sol is limited); `hydrogen-high` first for F/S/architecture or disagreement |

The reviewer ends a FAIL with a `FIXLIST:` block (`- path:line | blocker/major | issue | smallest fix`); `fixlist.py` puts it at the top of the sendback so the rework lane makes minimal edits. `RSI_CARBON_ENABLED` and `RSI_AGY_ENABLED` default to 1. The earlier empty Carbon reviews were not a launchd PATH or expired sign-in problem (agy is on PATH after `common.sh`; 30/31 runs were `status=SUCCESS` with `denied_actions: Bash` because `--mode plan --sandbox --disable-slash-commands` auto-denies `git diff` in headless mode, and `--mode plan` has no effect when slash commands are disabled). One run was a transient `authentication failed or timed out`. `dispatch.sh` now inlines the diff, allows `read_file`, and does not use `--mode plan`.

When sol reports its allowance is exhausted (`state/sol-limited-until`) or agy reports a quota/limit error (`state/agy-limited-until`, default 45 minutes if no clock is given), **do not call** the unavailable model and **do not log `error`**. Fall back along the order above. Large-tier PRs that still need a strong review are held only when Hydrogen/Carbon and sol are all unavailable (unless a strong review for the current head SHA can be reused). Small-tier PRs proceed DeepSeek-only. No retry storms.

A strong review is cached per head SHA in `state/merge/<slug>.strong` (+ `.strong.txt` / `.strong-ux`). The merge lane and `dispatch.sh` reuse that verdict and fix-list when HEAD is unchanged.

## Budget guards (unchanged)

Mac magpie, official 方舟 list CNY, Asia/Singapore day, cache billed as cache. Official list CNY is not 1:1 with company “credits.”

- Kimi daily cap ¥150 → further Kimi blocked, fall back as above.
- Overall ≥¥450 → no Kimi.
- ≥¥560 → do not *start* new worker lanes, box pack, or NAS pulse until the next Singapore day. In-flight jobs finish; ingest/acks still run.

## Logging and whether it was worth it

Every *new* strong-model review writes `rsi/state/escalations.jsonl` and a line in `escalations.log` with: time, role, slug, item, head SHA, signal(s), chosen model, cost source, DeepSeek verdict if known, and later the **outcome** (PASS/FAIL/hold, plus a short note). A reused SHA is logged once as `kind=reuse`. A rate-limit / agy-limited / Carbon-disabled skip is logged once as `kind=hold`, never as `error`.

`run.sh` daily/dream refresh `rsi/state/escalations-weekly.md`. That file has a **daily worth-it line**: counts by trigger, and how many strong reviews found issues DeepSeek missed (strong `FAIL` with a substantive blocker/major after DeepSeek `PASS`) versus agreed. That is the metric for Ethan. The morning brief reads the file under 数据.

After 2–3 days, also compare with the per-reviewer ledger: `python3 rsi/runtime/reviewer-misses.py --update`
writes `rsi/state/reviewer-misses.md` (PRs reverted or reopened after a merge-lane land), and `--status`
prints the one-line read. It is evidence, not a gate.

## How to invoke Hydrogen (and Carbon)

```sh
agy -p "$PROMPT" --model gemini-4-hydrogen-medium \
  --output-format json --sandbox --disable-slash-commands \
  --print-timeout "${DISPATCH_MAX_SECS:-3000}s" --add-dir "$CWD" \
  --settings rsi/runtime/agy-review.settings.json
```

Use `gemini-4-hydrogen-high` only for F1–F4 / S1–S3 / architecture or a second pass after disagreement. Carbon is the same invocation with `gemini-4-carbon-high`. Do not pass `--mode plan` (it has no effect with `--disable-slash-commands`). Local CLI: `agy` 1.5.9 (`/opt/homebrew/bin/agy` or `~/.antigravity/antigravity/bin/agy`; `common.sh` pins `AGY`). Auth is the existing Antigravity OAuth (type `antigravity`, zshisme), not a magpie provider. Treat the consumer subscription as finite; quota/limit errors write `state/agy-limited-until` and fall back to sol.

If the chosen model returns no usable result (process died, empty log, or a review with no `VERDICT: PASS` / `VERDICT: FAIL` line), `dispatch.sh` falls back along the order above, ending with Kimi last. A reviewer-infra no-verdict is a retry in `merge.sh`, not a sendback and not a burned rework round.

