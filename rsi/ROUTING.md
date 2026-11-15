# RSI model routing and necessity policy

CEO 2026-11-15 (Asia/Singapore). Ethan: default to DeepSeek; use stronger models only when necessary, and judge necessity carefully. Carbon (Antigravity) and gpt-6.1-sol are available for that necessary work; Kimi is last because it spends the company Volcengine key.

This file is the policy. `runtime/escalate.py` enforces it and logs every decision and outcome. `runtime/dispatch.sh` / `run.sh` apply it. Revert: restore `common.sh` model vars and drop the escalate hooks; see `DECISIONS.md`.

## Default (no escalation)

| Role | Model | Effort | Cost source |
|---|---|---|---|
| Worker / rework | DeepSeek V4.1 Flash | `--effort high` | Volcengine (cheap; official off-peak ¥1 / ¥0.02 / ¥4 per M) |
| Director, fill, planner, dream, first merge reviewer | DeepSeek V4.1 Flash | `--effort max` | Volcengine (same list prices; max uses more thinking tokens) |
| Second code reviewer (`reviewer-alt`, risky paths or >500 lines) | `codex/gpt-6.1-sol` | — | ChatGPT Plus (`zshyou@gmail.com` via Codex/magpie). Not Volcengine. Standing “different family” requirement, not an escalation. |
| UX vision reviewer (once PR #73’s `ux-gate.sh` lands) | `codex/gpt-6.1-sol` via `claude -p` (not `codex exec`; images) | — | Same ChatGPT account. Default stays here so Carbon is not spent on every screenshot pass. |

Do not start from Kimi or Carbon. DeepSeek at `--effort max` is the first lever for harder control-plane work.

## When escalation is necessary

Escalate only when at least one concrete signal is present. Vague “this seems hard” is not a signal.

1. **Reviewer disagreement** — a prior independent review or UX gate on this slug was `FAIL` (not a gate-only Prettier / dirty-tree typo).
2. **2nd+ rework round** — `state/merge/<slug>.attempts >= 2`.
3. **Foundation / shell slices** — item is Astryx F1–F4 or S1–S3 (not F5a or later shell).
4. **Gate-level failure DeepSeek could not diagnose** — a prior sendback on this slug has a non-trivial `GATE_RESULT=FAIL` (typecheck, tests, build, opaque error). Format-only / Prettier / dirty-after-build failures stay on DeepSeek; those are cheap to fix.
5. **Cross-cutting architecture** — the change spans three or more top-level areas (`ui/`, `internal/`, `desktop/`, `mobile/`, `cmd/`, `rsi/runtime/`), or the brief/sendback explicitly marks an architecture / ADR decision. Ordinary fill pulses do not escalate.

## Which strong model (role fit, then cost)

Once a signal fires, pick the first model that fits and is available. Cost source is part of the fit: prefer a subscription that is not the Volcengine key.

1. **`gpt-6.1-sol` first** for review and reasoning (first reviewer, planner/director/dream architecture calls, “why is this failing?”). ChatGPT account, no Volcengine spend.
2. **Carbon (Antigravity `gemini-4-carbon-high`)** for a second independent opinion, UI vision, or long context (1M-class window, image input, reasoning). Invoked non-interactively with `agy -p --model gemini-4-carbon-high` under the local Antigravity sign-in (`zshisme@gmail.com`, Google consumer subscription, no GCP quota project). This is not the Factory/Droid alias `factory/gemini-4-carbon` (that would bill the Factory account; do not use it from this loop).
3. **Kimi k3.1 pro last.** Company Volcengine key, official list CNY. Only if Codex and Carbon are both unavailable (missing CLI, auth, or API/quota error) **and** today’s Kimi list CNY is under ¥80 (`RSI_VOLC_KIMI_DAY_MAX`) **and** overall Volcengine list CNY is under ¥450 (`RSI_VOLC_KIMI_MAX`). Otherwise stay on the last working subscription model.

UX vision escalations prefer Carbon (vision / long context) then gpt-6.1-sol, then Kimi last. A further opinion after `reviewer-alt` already ran Codex also prefers Carbon.

## Budget guards (unchanged)

Mac magpie, official 方舟 list CNY, Asia/Singapore day, cache billed as cache. Official list CNY is not 1:1 with company “credits.”

- Kimi daily cap ¥80 → further Kimi blocked, fall back as above.
- Overall ≥¥450 → no Kimi.
- ≥¥560 → do not *start* new worker lanes, box pack, or NAS pulse until the next Singapore day. In-flight jobs finish; ingest/acks still run.

## Logging and whether it was worth it

Every escalation writes `rsi/state/escalations.jsonl` and a line in `escalations.log` with: time, role, slug, item, signal(s), chosen model, cost source, and later the **outcome** (PASS/FAIL/error, plus a short note). After 2–3 days, compare outcomes and `reviewer-misses.py` (PRs reverted or reopened after a merge-lane land).

`run.sh` daily/dream refresh `rsi/state/escalations-weekly.md`. The morning brief reads that file and includes a short “本周升级是否值得” note under 数据.

## How to invoke Carbon

```sh
agy -p "$PROMPT" --model gemini-4-carbon-high \
  --output-format json --mode plan --sandbox \
  --add-dir "$CWD" --disable-slash-commands
```

Local CLI: `agy` 1.5.8 (`~/.antigravity/antigravity/bin/agy`). Auth is the existing Antigravity OAuth (type `antigravity`), not a magpie provider. Magpie’s Antigravity plugin is marked retired and no Antigravity quota card appears in `magpie accounts`. Remaining Antigravity quota is not currently visible from the CLI; treat it as a finite consumer subscription and keep Carbon behind this policy.

If Carbon returns no usable result (process died, empty log, or a review with no `VERDICT: PASS` / `VERDICT: FAIL` line), `dispatch.sh` falls back to `codex/gpt-6.1-sol`. A reviewer-infra no-verdict is a retry in `merge.sh`, not a sendback and not a burned rework round.

