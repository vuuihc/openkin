# RSI model routing and necessity policy

CEO 2026-11-15 (Asia/Singapore). Ethan: default to DeepSeek; use stronger models only when necessary, and judge necessity carefully. Carbon (Antigravity) and gpt-6.1-sol are available for that necessary work; Kimi is last because it spends the company Volcengine key.

This file is the policy. `runtime/escalate.py` enforces it and logs every decision and outcome. `runtime/dispatch.sh` / `run.sh` apply it. Revert: restore `common.sh` model vars and drop the escalate hooks; see `DECISIONS.md`.

## Default (no escalation)

| Role | Model | Effort | Cost source |
|---|---|---|---|
| Worker / rework | DeepSeek V4.1 Flash | `--effort high` | Volcengine (cheap; official off-peak ¥1 / ¥0.02 / ¥4 per M) |
| Director, fill, planner, dream, first merge reviewer | DeepSeek V4.1 Flash | `--effort max` | Volcengine (same list prices; max uses more thinking tokens) |
| Second code reviewer (`reviewer-alt`, risky paths or >500 lines) | `codex/gpt-6.1-sol` | — | ChatGPT Plus (via Codex/magpie). Not Volcengine. Standing “different family” requirement, not an escalation. |
| UX vision reviewer (once PR #73’s `ux-gate.sh` lands) | `codex/gpt-6.1-sol` via `claude -p` (not `codex exec`; images) | — | Same ChatGPT account. Default stays here so Carbon is not spent on every screenshot pass. |

Do not start from Kimi or Carbon. DeepSeek at `--effort max` is the first lever for harder control-plane work.

## When escalation is necessary

Escalate only when at least one concrete signal is present, and spend at most **one strong-model review per PR per new head SHA**. If the head has not changed since the last strong review, reuse that verdict and fix-list; never re-run. Vague “this seems hard” is not a signal. A build, test, format, inventory, or merge-conflict failure is **not** a signal by itself — those go to the mechanical auto-fix path, then a DeepSeek-max diagnosis.

1. **Reviewer disagreement** — only when DeepSeek already `PASS`ed and a gate or another reviewer `FAIL`ed **on substance** (a typecheck/test/build failure, a strong-review FAIL with blocker/major findings, or a UX-gate FAIL). A mechanical gate failure (Prettier, dirty-tree, format, inventory baseline, merge conflict) is not disagreement. A DeepSeek `FAIL` is not disagreement: it already found the issue.
2. **2nd+ rework round on substance** — `state/merge/<slug>.attempts >= 2` (mechanical sendbacks do not increment this). Still only one strong review per head SHA.
3. **Foundation / shell slices** — item is Astryx F1–F4 or S1–S3 (not F5a or later shell).
4. **Gate-level failure DeepSeek could not diagnose** — escalate only if DeepSeek-max already made a real diagnosis attempt and explicitly said it cannot find the cause (`VERDICT: UNSURE`, `DEEPSEEK_DIAGNOSIS: UNDIAGNOSED`, or equivalent). A `GATE_RESULT=FAIL` for typecheck, tests, or build, by itself, must not trigger escalation.
5. **Cross-cutting architecture or deps** — the change spans three or more top-level areas (`ui/`, `internal/`, `desktop/`, `mobile/`, `cmd/`, `rsi/runtime/`), the brief/sendback marks an architecture / ADR decision, or the diff touches `go.mod` / `ui/package.json`. Ordinary fill pulses do not escalate.

## Which strong model (role fit, then cost)

Once a signal fires, pick the first model that fits and is available. Cost source is part of the fit: prefer a subscription that is not the Volcengine key.

1. **`gpt-6.1-sol` first** for review and reasoning (first reviewer, planner/director/dream architecture calls, “why is this failing?”). ChatGPT account, no Volcengine spend.
2. **Carbon (Antigravity `gemini-4-carbon-high`)** for a second independent opinion, UI vision, or long context (1M-class window, image input, reasoning). Invoked non-interactively with `agy -p --model gemini-4-carbon-high` under the local Antigravity Google consumer sign-in (no GCP quota project). This is not the Factory/Droid alias `factory/gemini-4-carbon` (that would bill the Factory account; do not use it from this loop).
3. **Kimi k3.1 pro last.** Company Volcengine key, official list CNY. Only if Codex and Carbon are both unavailable (missing CLI, auth, or API/quota error) **and** today’s Kimi list CNY is under ¥80 (`RSI_VOLC_KIMI_DAY_MAX`) **and** overall Volcengine list CNY is under ¥450 (`RSI_VOLC_KIMI_MAX`). Otherwise stay on the last working subscription model.

UX vision escalations prefer Carbon (vision / long context) then gpt-6.1-sol, then Kimi last. A further opinion after `reviewer-alt` already ran Codex also prefers Carbon.

## Tiered review (CEO 2026-11-15, `runtime/review-tier.py`)

Review cost follows risk; nothing else about the gate changes.

| Tier | When | Reviewer |
|---|---|---|
| small | pure refactor/extract (or ≤ 400 lines), no deps/migrations/auth/persist/permission, no routing-contract files, tests only added, item not F/S/N/Q3a, rework < 2 | one DeepSeek `--effort max` review; only rework ≥ 2 may escalate; `VERDICT: UNSURE` → `gpt-6.1-sol` once |
| medium | not small, ≤ 500 lines (or a refactor/extract ≤ 800 with modified tests), nothing risky | DeepSeek `--effort max`, normal necessity signals |
| large | risky paths, > 500 lines, F/S/N/Q3a items, 2+ rework rounds | `gpt-6.1-sol` (standing second family) |

The reviewer ends a FAIL with a `FIXLIST:` block (`- path:line | blocker/major | issue | smallest fix`); `fixlist.py` puts it at the top of the sendback so the rework lane makes minimal edits. Carbon is off (`RSI_CARBON_ENABLED=0`): `agy --mode plan --sandbox` cannot run `git diff`, so it returned empty; re-enable only once it can be fed the diff inline and is signed in.

When sol reports its allowance is exhausted (`state/sol-limited-until`) or Carbon is disabled, **do not call** the unavailable model and **do not log `error`**. Large-tier PRs that still need a strong review are held until quota returns (unless a strong review for the current head SHA can be reused). Small-tier PRs proceed DeepSeek-only. No retry storms.

A strong review is cached per head SHA in `state/merge/<slug>.strong` (+ `.strong.txt` / `.strong-ux`). The merge lane and `dispatch.sh` reuse that verdict and fix-list when HEAD is unchanged.

## Budget guards (unchanged)

Mac magpie, official 方舟 list CNY, Asia/Singapore day, cache billed as cache. Official list CNY is not 1:1 with company “credits.”

- Kimi daily cap ¥80 → further Kimi blocked, fall back as above.
- Overall ≥¥450 → no Kimi.
- ≥¥560 → do not *start* new worker lanes, box pack, or NAS pulse until the next Singapore day. In-flight jobs finish; ingest/acks still run.

## Logging and whether it was worth it

Every *new* strong-model review writes `rsi/state/escalations.jsonl` and a line in `escalations.log` with: time, role, slug, item, head SHA, signal(s), chosen model, cost source, DeepSeek verdict if known, and later the **outcome** (PASS/FAIL/hold, plus a short note). A reused SHA is logged once as `kind=reuse`. A rate-limit / Carbon-disabled skip is logged once as `kind=hold`, never as `error`.

`run.sh` daily/dream refresh `rsi/state/escalations-weekly.md`. That file has a **daily worth-it line**: counts by trigger, and how many strong reviews found issues DeepSeek missed (strong `FAIL` with a substantive blocker/major after DeepSeek `PASS`) versus agreed. That is the metric for Ethan. The morning brief reads the file under 数据.

After 2–3 days, also compare with `reviewer-misses.py` (PRs reverted or reopened after a merge-lane land).

## How to invoke Carbon

```sh
agy -p "$PROMPT" --model gemini-4-carbon-high \
  --output-format json --mode plan --sandbox \
  --add-dir "$CWD" --disable-slash-commands
```

Local CLI: `agy` 1.5.8 (`~/.antigravity/antigravity/bin/agy`). Auth is the existing Antigravity OAuth (type `antigravity`), not a magpie provider. Magpie’s Antigravity plugin is marked retired and no Antigravity quota card appears in `magpie accounts`. Remaining Antigravity quota is not currently visible from the CLI; treat it as a finite consumer subscription and keep Carbon behind this policy.

If Carbon returns no usable result (process died, empty log, or a review with no `VERDICT: PASS` / `VERDICT: FAIL` line), `dispatch.sh` falls back to `codex/gpt-6.1-sol`. A reviewer-infra no-verdict is a retry in `merge.sh`, not a sendback and not a burned rework round.

