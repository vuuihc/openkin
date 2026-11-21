#!/bin/bash
# lane.sh run <n>   — run the claimed worker lane n to completion (worktree → worker → push → PR).
# lane.sh start-claimed — launch every freshly claimed lane in the background (used by the fill pulse).
# lane.sh autofill  — turn merge-lane sendbacks into rework lanes on idle slots (no LLM needed).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$RSI_DIR/runtime/lane-pr.sh"
CMD="${1:-}"; N="${2:-}"

# A squash-merged (or closed) PR leaves its branch diffing from main, so autofill's fetch/diff
# cannot tell a live rework from a dead one. The PR's lifecycle state decides. The override is a
# test seam (the command reads the slug as $1); empty means the real gh call.
PR_STATE_CMD="${RSI_PR_STATE_CMD:-}"
pr_state() { # <slug> -> prints OPEN|MERGED|CLOSED; non-zero when the state cannot be read
  if [ -n "$PR_STATE_CMD" ]; then bash -c "$PR_STATE_CMD" pr-state "$1"
  else "$GH" pr view "rsi/$1" --repo "$GH_REPO" --json state --jq .state; fi
}

# Oldest sendback first. The glob used to walk them alphabetically, and autofill fills one idle
# lane per pass: a newer rework whose slug sorted earlier took every free slot while an older one
# waited. 2026-11-19: `panel-topmost` (18:32) was claimed at 18:44 and `stale-console` (15:21) had
# been waiting since then. Name breaks an mtime tie so the pick stays deterministic.
# One stat per path, and a path that is gone by then is dropped, not fatal: merge.sh archives a
# sendback into sendback/done/ the moment its PR lands, concurrently with this scan, so the glob
# and the stat can disagree. A raised FileNotFoundError exited python non-zero, the process
# substitution yielded nothing, and that pass claimed no rework at all — every queued sendback
# lost a pulse, not just the vanished one (2026-11-19).
# `_sendback-order` (stdin: one path per line) is a hidden test seam, the same shape as
# RSI_PR_STATE_CMD above: sendbacks_by_age pipes the production glob through it, and
# test-lane-autofill.sh feeds it fixed paths so the missing-file case needs no timed race.
sendback_order() {
  # -c, not a heredoc: the heredoc would own stdin and swallow the piped paths.
  python3 -c '
import os, stat, sys

def key(p):
    try:
        st = os.stat(p)          # the only stat: an isfile() before it would stat twice
    except OSError:              # archived between the glob and here: drop it, keep the queue
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    return (st.st_mtime, p)

paths = [line.strip() for line in sys.stdin if line.strip()]
for path, name in sorted(k for k in map(key, paths) if k):
    print(name)
'
}

sendbacks_by_age() { # prints $STATE/sendback/*.md, oldest mtime first
  printf '%s\n' "$STATE"/sendback/*.md | sendback_order
}

# --- worker brief: one source for the generated header and the contract seam -------------------
# Every worker reads this contract first, so the text that reaches dispatch.sh and the text a
# check can print must be the same bytes. Both callers go through worker_contract(); the public
# seam supplies the four facts it has, and the lane record supplies the declared paths and slug.
lane_declared_paths() { # <slug> -> the newest lane record's declared paths, comma-separated
  python3 - "$STATE/lanes" "$1" <<'PY'
import glob, json, os, sys
ldir, slug = sys.argv[1], sys.argv[2]
best = None
for f in glob.glob(os.path.join(ldir, "[0-9]*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if d.get("slug") != slug:
        continue
    key = d.get("claimed_at") or 0
    if best is None or key > best[0]:
        best = (key, d)
paths = (best[1].get("paths") if best else None) or []
print(", ".join(paths) if paths else "-")
PY
}

worker_contract() { # <item> <mode> <worktree> <branch> — the text every worker reads first
  local item="$1" mode="$2" wt="$3" br="$4" slug paths
  slug="${br#rsi/}"
  paths="$(lane_declared_paths "$slug")"
  cat <<HD
# Lane worker contract (read first)
You are the WORKER for RSI item $item in worktree \`$wt\` on branch \`$br\`. Mode: $mode.
- Budget: finish in about 45 minutes and at most about \$8 (Astryx programme slices are up to ~800 changed lines). If the slice is bigger than that, deliver the smallest green first slice, commit it, and list what remains in \`$STATE/followups.md\` (append).
- Stay inside your declared paths; do not touch files other lanes may be editing. Declared paths: $paths
- Test first. Run FOCUSED checks only (typecheck, lint on changed files, the tests you wrote/touched, \`go test\` for touched packages). The merge lane runs the full gate (\`gate.sh\`) and an independent review afterwards. Use \`VITEST_MAX_WORKERS=2\` for vitest; other lanes are running on the same machine.
- Concurrency test ordering: set the shared state (the flag, channel or map the goroutine reads) before you start the goroutine. Never start the goroutine and then write the flag it reads — that order is the race the gate and the reviewer are looking for.
- A new or changed Go test self-checks with \`go test -count=5 -race ./internal/<touched-package>/...\` on the touched package(s) before you finish. One green run of a concurrency test is not evidence; five runs under \`-race\` are what make it trustworthy.
- If \`ui/\` changed: \`cd ui && npm run build\`, commit \`web/dist/index.html\` only (never \`web/dist/assets/\`). For visible UI also save 390×844 and 1100×760 before/after screenshots under \`$STATE/shots/$slug/\`.
- Loop code (\`rsi/runtime/**\` or \`scripts/**\` ending \`.sh\`, \`.bash\`, \`.py\`, \`.mjs\`, \`.js\` or \`.ts\`; not \`rsi/runtime/{tests,runs,prompts}/**\`, \`rsi/runtime/ux/journeys/**\`, \`rsi/state/**\` or a deleted file): add or update an entry in a \`*.mutants.json\` manifest this branch adds or modifies for every changed file, with \`file\` set to that path, and that entry's test must fail while its mutant is applied. A manifest already on main does not cover your edit, so an already-covered file still needs a new entry. Make the mutant break the behaviour you changed, not an unrelated line. Run \`bash rsi/runtime/lane.sh --mutant-evidence-check "\$PWD"\` from your worktree before you finish: only \`MUTANT_EVIDENCE_OK\` (or \`MUTANT_EVIDENCE_SKIP\` when no loop code changed) proves the hand-off; a missing entry prints \`MUTANT_EVIDENCE_MISSING\` and a surviving mutant prints \`MUTANT_EVIDENCE_RED\`. The lane runs the same seam before pushing, and either verdict there fails the lane.
- UI ratchet: \`python3 scripts/check-ui-inventory.py\` must not grow. If your change IS the sanctioned primitive/facade (its own raw \`<button>\`, \`createPortal\`, \`role="dialog"\`, \`useAnchoredPanel\` use is the point), run \`python3 scripts/check-ui-inventory.py --update\`, commit the baseline, and say so in the PR body (Risk section). Also run the focused UI suites your change touches plus the design-token test: \`cd ui && npx vitest run <the suites you touched> src/design/tokens.test.ts\` (e.g. focus ring must use \`outline-kin-focus-ring\`). The merge gate owns the full suite; a worker does not run it.
- Commit everything with Conventional Commits and explicit paths. Do NOT push, do NOT open the PR, do NOT touch other worktrees.
- Before you finish write the PR body to \`$STATE/lanes/$slug.pr-body.md\` with sections: Symptom · Change · Verification (commands + results) · Screenshots (paths, or "none: not visible") · Risk · \`RSI item: $item\`.
- A PR that changes a prose-assertion path (\`docs/product/**\`, \`docs/plans/**\`, \`docs/adr/**\`, \`rsi/GOAL.md\`, \`rsi/DECISIONS.md\`, \`rsi/ASTRYX-PLAN.md\`, \`AGENTS.md\`, \`PRINCIPLE.md\`, \`SYSTEM_DESIGN.md\`) carries one \`Claim check:\` line at column 0 — one command that proves the sentence on this branch — and its literal output under \`Claim output:\`, or waives it with \`Claim check: none: <reason of at least 20 characters>\`.
- The merge gate RUNS that claim command and compares the pasted output against it; a sentence whose claim check is missing or false is not delivery.
- Final message: files changed, tests added (names), commands run with results, residual risk.
HD
}

write_worker_brief() { # prints the header dispatch.sh receives; reads ITEM MODE WT BR BRIEF (CONFLICT optional)
  worker_contract "$ITEM" "$MODE" "$WT" "$BR"
  if [ "$MODE" = rework ]; then
    echo; echo "## This is a REWORK: the merge lane sent the branch back. Fix exactly the findings below (all at once), then re-run the focused checks."
    echo "REWORK RULES (targeted, not a rewrite): make MINIMAL edits. Work through the 'Fix list' table row by row (file:line, issue, required change); edit only the lines/files a row names (plus the test that proves it). Do NOT regenerate, reformat or restructure files, do NOT re-implement the slice. If a row is wrong, say so with evidence in the PR body instead of changing code. If the brief says 'MECHANICAL', fix only that (conflict/format) and change nothing else."
    [ -n "${CONFLICT:-}" ] && echo "Merging origin/main into the branch left conflicts in: $CONFLICT. Resolve them (keep both sides' intent; \`web/dist/index.html\` is regenerated by \`npm run build\`), \`git add\`, commit."
    echo; cat "$BRIEF"
  else
    echo; echo "# Brief"; cat "$BRIEF"
  fi
}

# --- mutant evidence: a loop guard is only proven when its own test fails without it -----------
# The live `gate+review·rsi` shape is mostly one finding: the changed guard's own test does not go
# red when the guard breaks (state/sendback/done/merge-sync-abort-090823, lane-leftovers-095231,
# walk-select-guard-071822, phone-console-baseline-b-045503). `scripts/mutants.py` already owns the
# mutate → require red → restore proof; this seam only decides which changed loop files need one,
# runs every covering manifest, and fails closed when the proof is absent or cannot run. The worker
# runs it before finishing (worker_contract) and the lane runs it again after the format commit and
# before the push, so the reviewer is no longer the first reader.
# Changed set = our side of the merge base plus untracked files, so an uncommitted last edit still
# counts, while a merge lane's fetch of origin/main during the worker's run does not turn other
# lanes' loop files into this lane's required evidence (worktrees share refs). Deletions are out:
# a removed file cannot be mutated, and demanding an entry for it would make a cleanup unlandable.
# In scope: code under rsi/runtime/** or scripts/**. Out: rsi/runtime/tests/**, runs/**, prompts/**,
# ux/journeys/**, rsi/state/** and the manifests themselves — adding proof must not require
# proving the manifest. Coverage is per branch, not per file: a manifest already on main proves the
# code as it stood there, so an edit to an already-covered file (lane.sh, merge.sh, ux/walk.mjs)
# would otherwise hand off with no mutant for its new guard. Only manifests this branch adds or
# modifies count and run (2026-11-21 review, major).
mutant_evidence_check() { # <worktree> — prints one verdict line; 0 = ok/skip, 1 = red/missing
  local wt="$1" base changed manifests
  [ -d "$wt" ] || { echo "MUTANT_EVIDENCE_RED: $wt · worktree not found"; return 1; }
  # A guard that cannot read the branch point would silently see no changes; fail closed instead.
  "$GIT" -C "$wt" rev-parse --verify -q origin/main >/dev/null 2>&1 \
    || { echo "MUTANT_EVIDENCE_RED: $wt · origin/main is not resolvable"; return 1; }
  base="$("$GIT" -C "$wt" merge-base origin/main HEAD 2>/dev/null)" \
    || { echo "MUTANT_EVIDENCE_RED: $wt · origin/main and HEAD have no merge base"; return 1; }
  # grep, not a `case` in the substitution: macOS /bin/bash 3.2 mis-parses a case pattern list
  # that starts with `*` inside $( ) (reproduced 2026-11-21 while writing this seam).
  changed="$(
    { "$GIT" -C "$wt" diff --name-only --diff-filter=d "$base" 2>/dev/null
      "$GIT" -C "$wt" ls-files --others --exclude-standard 2>/dev/null
    } | LC_ALL=C sort -u \
      | grep -E '^(rsi/runtime|scripts)/.*\.(sh|bash|py|mjs|js|ts)$' \
      | grep -vE '^rsi/runtime/(tests|runs|prompts)/|^rsi/runtime/ux/journeys/|^rsi/state/' \
      | grep -v '\.mutants\.json$' || true
  )"
  if [ -z "$changed" ]; then
    echo "MUTANT_EVIDENCE_SKIP: no loop-code change"
    return 0
  fi
  # Only manifests this branch added or modified: a pre-existing one proves main's code, not the
  # worker's new guard. Tracked changes come from the same branch point as the changed set;
  # untracked ones are files the worker has not committed yet.
  manifests="$(
    { "$GIT" -C "$wt" diff --name-only --diff-filter=d "$base" -- '*.mutants.json' 2>/dev/null
      "$GIT" -C "$wt" ls-files --others --exclude-standard -- '*.mutants.json' 2>/dev/null
    } | LC_ALL=C sort -u
  )"
  MUTANT_CHANGED="$changed" MUTANT_MANIFESTS="$manifests" python3 - "$wt" <<'PY'
import json, os, re, subprocess, sys

wt = sys.argv[1]
changed = [line for line in os.environ.get("MUTANT_CHANGED", "").splitlines() if line]
manifests = [line for line in os.environ.get("MUTANT_MANIFESTS", "").splitlines() if line]

# An entry covers the file its `file` field names, normalized for a leading "./".
by_file = {}
broken = []
for m in manifests:
    try:
        data = json.loads(open(os.path.join(wt, m), encoding="utf-8").read())
        if not isinstance(data, list):
            raise ValueError("manifest is not a JSON array")
        files = [e["file"] for e in data]
        if not all(isinstance(f, str) for f in files):
            raise ValueError("manifest entry has no string file")
    except Exception:
        broken.append(m)
        continue
    for f in files:
        by_file.setdefault(f[2:] if f.startswith("./") else f, set()).add(m)

if broken:
    for m in dict.fromkeys(broken):
        print(f"MUTANT_EVIDENCE_RED: {m} · manifest cannot be parsed")
    sys.exit(1)

missing = [p for p in changed if p not in by_file]
if missing:
    print("MUTANT_EVIDENCE_MISSING: " + ", ".join(missing))
    sys.exit(1)

run = sorted({m for p in changed for m in by_file[p]})
if not os.path.isfile(os.path.join(wt, "scripts", "mutants.py")):
    print(f"MUTANT_EVIDENCE_RED: {run[0]} · scripts/mutants.py is missing")
    sys.exit(1)

marker = re.compile(r"^(SURVIVED|ERROR|TIMEOUT|BASELINE|RESTORE)\s+(.*?):")
for m in run:
    proc = subprocess.run(
        ["python3", "scripts/mutants.py", m, "--timeout", "180"],
        cwd=wt, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if proc.returncode == 0:
        continue
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    evidence = next((line for line in lines if marker.match(line)), "")
    hit = marker.match(evidence) if evidence else None
    label = hit.group(2).strip() if hit else (lines[-1].strip() if lines else "")
    label = label or f"scripts/mutants.py exited {proc.returncode}"
    print(f"MUTANT_EVIDENCE_RED: {m} · {label}")
    if evidence:
        print(evidence)
    sys.exit(1)

print(f"MUTANT_EVIDENCE_OK: {len(changed)} file(s) covered by {len(run)} manifest(s)")
PY
}

if [ "$CMD" = _sendback-order ]; then sendback_order; exit 0; fi

# Seams. --worker-contract-check prints the contract and exits before PAUSE, locks, fetch,
# dispatch or any lane bookkeeping; _worker-brief writes the production header through the same
# composition the run path uses, so the suite can diff the seam text against a generated brief.
# --mutant-evidence-check is the same shape: a hermetic proof check the worker and the lane run.
if [ "$CMD" = --mutant-evidence-check ]; then
  [ "$#" -eq 2 ] || { echo "usage: lane.sh --mutant-evidence-check <worktree>" >&2; exit 2; }
  mutant_evidence_check "$2"; exit $?
fi
if [ "$CMD" = --worker-contract-check ]; then
  [ "$#" -eq 5 ] || { echo "usage: lane.sh --worker-contract-check <item> <mode> <worktree> <branch>" >&2; exit 2; }
  worker_contract "$2" "$3" "$4" "$5"
  exit 0
fi
if [ "$CMD" = _worker-brief ]; then
  [ -n "$N" ] || { echo "usage: lane.sh _worker-brief <n>" >&2; exit 2; }
  eval "$(python3 "$LANES_PY" get "$N")"
  ITEM="$L_ITEM"; SLUG="$L_SLUG"; BRIEF="$L_BRIEF"; MODE="$L_MODE"
  WT="$WT_ROOT/rsi-$SLUG"; BR="rsi/$SLUG"
  write_worker_brief > "$STATE/lanes/$N.worker-brief.md" || exit 1
  exit 0
fi

launch() { # n
  nohup /bin/bash "$SELF" run "$1" >> "$RUNS/$(date +%F-%H%M%S)-lane$1.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "launched lane $1 (pid $!)"
}

if [ "$CMD" = start-claimed ]; then
  [ -e "$STATE/PAUSE" ] && { echo paused; exit 0; }
  rsi_allow_workers || { echo "volc budget: not starting new worker lanes until next Asia/Singapore day (¥${RSI_VOLC_CNY:-?} >= ¥${RSI_VOLC_STOP_WORKERS:-560}; $STATE/volc-budget.log)"; exit 0; }
  if ! python3 "$LANES_PY" host-ok; then echo "host pressure: not starting claimed local workers"; exit 0; fi
  for n in $(python3 "$LANES_PY" claimed); do launch "$n"; sleep 2; done; exit 0
fi

if [ "$CMD" = autofill ]; then
  [ -e "$STATE/PAUSE" ] && exit 0
  rsi_allow_workers || { echo "volc budget: not filling rework lanes until next Asia/Singapore day"; exit 0; }
  # Astryx programme first: `autofill astryx` takes only sendbacks whose item is a slice id (or Q3a); `autofill rest` the others.
  SCOPE="${2:-all}"
  while IFS= read -r sb; do
    [ -e "$sb" ] || continue
    slug="$(basename "$sb" .md)"
    # A size-only sendback must not open a rework lane while its waiver stands: the cap it asks
    # to fit is gone, and a rework lane trims real content to obey it (2026-11-18: #296's round
    # deleted 879 lines of a signed story before it was killed; #299 was waived before a lane
    # claimed it). See state/merge/<slug>.size-ok.
    src="$(sed -n 's/^source: *//p' "$sb" | head -1)"
    if [ "$src" = "hold-size" ] && [ -f "$STATE/merge/$slug.size-ok" ]; then
      echo "autofill: $slug: hold-size waived (merge/$slug.size-ok), not opening a rework lane"
      continue
    fi
    itm="$(sed -n 's/^item: *//p' "$sb" | head -1)"
    is_astryx=$(python3 -c "import json,sys;ids={s['id'] for s in json.load(open('$RSI_DIR/astryx-slices.json'))['slices']};print(1 if sys.argv[1] in ids else 0)" "$itm" 2>/dev/null || echo 0)
    [ "$SCOPE" = astryx ] && [ "$is_astryx" != 1 ] && continue
    [ "$SCOPE" = rest ] && [ "$is_astryx" = 1 ] && continue
    # skip if some lane already works on it
    python3 "$LANES_PY" slugs | grep -qx "$slug" && continue
    # Terminal PR, no rework: after a squash merge the branch commits stay out of main, so the
    # fetch/diff below still finds a diff and would claim a lane for a PR that is already done
    # (2026-11-19, lane 3: "cancelled: stale sendback"). MERGED/CLOSED archive the file; OPEN
    # keeps today's path. An unreadable state fails open — a rare phantom costs less than a real
    # rework stalled by a gh outage.
    pstate="$(pr_state "$slug" 2>/dev/null || true)"
    case "$pstate" in
      MERGED|CLOSED)
        mkdir -p "$STATE/sendback/done"
        mv "$STATE/sendback/$slug.md" "$STATE/sendback/done/$slug-merged-$(date +%H%M%S).md"
        echo "rework $slug: PR $pstate, sendback archived (no rework lane)"
        continue ;;
      OPEN) ;;
      *) echo "autofill: $slug: PR state '${pstate:-unreadable}', claiming as before" ;;
    esac
    idle="$(python3 "$LANES_PY" idle --ignore-pressure | head -1)"; [ -z "$idle" ] && { echo "no idle lane for rework $slug"; break; }
    br="rsi/$slug"; $GIT -C "$RSI_CTRL" fetch -q origin "$br" 2>/dev/null
    paths="$($GIT -C "$RSI_CTRL" -c core.fileMode=false diff --no-renames --raw "origin/main...origin/$br" 2>/dev/null | awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' | grep -vx "web/dist/index.html" | head -40)"
    [ -z "$paths" ] && { echo "rework $slug: no diff vs main, skipping"; continue; }
    paths_arr=()
    while IFS= read -r _p; do
      [ -n "$_p" ] && paths_arr+=("$_p")
    done <<< "$paths"
    [ "${#paths_arr[@]}" -gt 0 ] || { echo "rework $slug: no paths, skipping"; continue; }
    item="$(sed -n 's/^item: *//p' "$sb" | head -1)"; item="${item:-R-$slug}"
    python3 "$LANES_PY" claim "$idle" --slug "$slug" --item "$item" --brief "$sb" --mode rework --paths "${paths_arr[@]}" && launch "$idle"
  done < <(sendbacks_by_age)
  exit 0
fi

[ "$CMD" = run ] && [ -n "$N" ] || { echo "usage: lane.sh run <n> | start-claimed | autofill"; exit 2; }
rsi_allow_workers || { echo "volc budget: deferring lane $N until next Asia/Singapore day"; exit 0; }
eval "$(python3 "$LANES_PY" get "$N")"
[ "$L_STATUS" = claimed ] || { echo "lane $N not in claimed state ($L_STATUS)"; exit 0; }
SLUG="$L_SLUG"; ITEM="$L_ITEM"; BRIEF="$L_BRIEF"; MODE="$L_MODE"
# Host pressure defers NEW work only: a targeted rework runs 2-11 minutes and swap-free never recovers
# on its own (macOS keeps swapped pages), so gating reworks starves the queue forever (2026-11-16).
if [ "$MODE" != rework ] && ! python3 "$LANES_PY" host-ok; then echo "host pressure: deferring lane $N"; exit 0; fi
LK="$STATE/lanes/$N.lock"
if ! mkdir "$LK" 2>/dev/null; then
  old="$(cat "$LK/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "lane $N already running (pid $old)"; exit 0; fi
  rm -rf "$LK"; mkdir "$LK" || exit 0
fi
echo $$ > "$LK/pid"; python3 "$LANES_PY" start "$N" $$
FINISHED=0
WORKER_PID=""
cleanup() {
  # Reap the worker process group and any test/build descendants left behind.
  if [ -n "${WORKER_PID:-}" ]; then
    rsi_kill_tree "$WORKER_PID"
    kill -TERM -"$WORKER_PID" 2>/dev/null || true
    sleep 0.4
    kill -KILL -"$WORKER_PID" 2>/dev/null || true
  fi
  for kid in $(pgrep -P $$ 2>/dev/null || true); do
    rsi_kill_tree "$kid"
  done
  [ $FINISHED -eq 0 ] && python3 "$LANES_PY" finish "$N" --status crashed --note "lane.sh exited early"
  rm -rf "$LK"
}
trap cleanup EXIT
finish() { FINISHED=1; python3 "$LANES_PY" finish "$N" --status "$1" --pr "${2:-}" --note "${3:-}"; }

WT="$WT_ROOT/rsi-$SLUG"; BR="rsi/$SLUG"; TAG="lane$N-$SLUG"
echo "[$(date +%T)] lane $N start item=$ITEM slug=$SLUG mode=$MODE wt=$WT"
$GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
if [ "$MODE" = rework ] || [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  [ -e "$WT" ] || $GIT -C "$RSI_CTRL" worktree add "$WT" "$BR" 2>/dev/null || $GIT -C "$RSI_CTRL" worktree add "$WT" -b "$BR" "origin/$BR"
  $GIT -C "$WT" fetch -q origin 2>/dev/null
  # Same branch as the PR: fast-forward to what is pushed, then merge main (no force-push anywhere).
  [ -z "$($GIT -C "$WT" status --porcelain)" ] && $GIT -C "$WT" merge -q --ff-only "origin/$BR" 2>/dev/null
  if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
    CONFLICT="$($GIT -C "$WT" diff --name-only --diff-filter=U | tr '\n' ' ')"
    echo "merge of origin/main left conflicts: $CONFLICT (worker must resolve and commit)"
  fi
else
  $GIT -C "$RSI_CTRL" worktree add "$WT" -b "$BR" origin/main >/dev/null 2>&1 || { finish failed "" "cannot create worktree $WT"; count_fail "lane $N" "worktree $WT"; exit 1; }
fi
BASE_N="$($GIT -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" 2>&1 | tail -2

STATUS_NOTE_FILE="$STATE/lanes/$SLUG.pr-body.md"
HDR="$STATE/lanes/$N.worker-brief.md"
write_worker_brief > "$HDR"

export BUDGET_GUARD="$LANE_BUDGET_USD" DISPATCH_MAX_SECS="$LANE_WORKER_SECS"
W_START=$(date +%s)
# Run the worker in its own process group so timeout/exit can reap vitest/go/node/agy.
python3 -c 'import os,sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])' \
  /bin/bash "$RSI_DIR/runtime/dispatch.sh" worker "$WT" "$HDR" "$TAG-worker" \
  > "$STATE/lanes/$N.worker.txt" 2>&1 &
WORKER_PID=$!
wait "$WORKER_PID"; WRC=$?
W_MIN=$(( ($(date +%s) - W_START) / 60 ))
LASTLOG="$(ls -t "$RUNS"/*-dispatch-$TAG-worker.jsonl 2>/dev/null | head -1)"
COST="$(tail -c 400 "$STATE/lanes/$N.worker.txt" | sed -n 's/.*cost_usd=\([0-9.]*\).*/\1/p' | tail -1)"
TIMEDOUT=0; [ $WRC -eq 143 ] && TIMEDOUT=1
echo "[$(date +%T)] worker rc=$WRC min=$W_MIN cost=${COST:-?} log=${LASTLOG##*/}"

# Commit everything the worker left, including files it created: the gate judges this worktree,
# CI judges the pushed branch, and a new file that stayed untracked made PR #511's journeys check
# red while the lane was green (2026-11-21). The sweep runs before AHEAD so its commit counts, and
# a sweep that could not take fails the lane instead of shipping a branch the local disk lied about.
if ! SWEPT="$(bash "$RSI_DIR/runtime/commit-leftovers.sh" "$WT" "$ITEM")"; then
  [ -n "$SWEPT" ] && printf '%s\n' "$SWEPT" > "$STATE/lanes/$N.leftovers.log"
  finish failed "" "leftovers: uncommitted files remain for $ITEM; see needs-ceo.md"
  exit 1
fi
SWEPT_N=0
if [ -n "$SWEPT" ]; then
  SWEPT_N="$(printf '%s\n' "$SWEPT" | wc -l | tr -d ' ')"
  printf '%s\n' "$SWEPT" > "$STATE/lanes/$N.leftovers.log"
  echo "[$(date +%T)] swept: $SWEPT_N file(s) -> lanes/$N.leftovers.log"
fi
AHEAD="$($GIT -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [ "$MODE" != rework ] && [ "$AHEAD" -eq 0 ]; then
  [ $TIMEDOUT -eq 1 ] && count_timeout "lane $N ($SLUG)" "no commits; log ${LASTLOG##*/}" || count_fail "lane $N ($SLUG)" "no commits; ${LASTLOG##*/}"
  scorecard_row "$ITEM $SLUG (lane $N)" "$M_WORKER" "-" "no commits (rc=$WRC, ${W_MIN}m)" "-" "failed" "slice smaller"
  finish failed "" "worker produced no commits rc=$WRC after ${W_MIN}m"; exit 1
fi

# A new PR takes its title — and therefore the squash-merge subject on main —
# from the tip commit. Capture the worker's subject before the format commit
# moves the tip, or every lane that needed formatting lands as "style: format
# changed UI and Go files". Skip the loop's own housekeeping commits.
WORKER_TITLE="$($GIT -C "$WT" log --format=%s origin/main..HEAD 2>/dev/null \
  | awk '!/^style: format changed UI and Go files$/ && !/^chore\(rsi\): commit remaining (tracked )?edits/ { print; exit }')"

count_format_fail() { # not a runner failure: after --write this is a parse/env problem (missing ui/node_modules, npx/gofmt), so count it apart
  local n=$(( $(cat "$STATE/consec_format" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/consec_format"
  notify "Kin RSI: $1 failed ($n in a row)" "${2:-}"
  [ $n -ge 6 ] && echo "6 consecutive format-check failures $(date) — check worker env (ui/node_modules, npx/gofmt)" > "$STATE/PAUSE"
  return 0
}

# Format changed UI/Go files the way CI checks them; commit; refuse to push on failure.
FMT_ERR="$STATE/lanes/$N.format.err"
if ! bash "$RSI_DIR/runtime/format-changed.sh" --write --commit --check "$WT" >"$FMT_ERR" 2>&1; then
  FMT_DETAIL="$(tail -c 300 "$FMT_ERR" 2>/dev/null | tr '\n' ' ')"
  count_format_fail "lane $N format" "${FMT_DETAIL:-no output}"
  finish failed "" "format check failed: ${FMT_DETAIL:-see $FMT_ERR}; not pushing"
  exit 1
fi
echo 0 > "$STATE/consec_format"
[ -s "$FMT_ERR" ] && tail -3 "$FMT_ERR"

# A loop-code change hands off only with a mutant that proves its own test notices the guard being
# broken. The worker runs this same seam first (worker_contract); this pass is authoritative. On a
# hole the branch stays committed and clean: no push, no PR.
if ! MUT_EV="$(bash "$SELF" --mutant-evidence-check "$WT" 2>&1)"; then
  [ -n "$MUT_EV" ] && printf '%s\n' "$MUT_EV"
  MUT_NOTE="$(printf '%s' "$MUT_EV" | tr '\n' ' ' | sed 's/  */ /g')"
  finish failed "" "mutant evidence: ${MUT_NOTE:-check produced no output}"
  exit 1
fi
[ -n "$MUT_EV" ] && printf '%s\n' "$MUT_EV"

# push + PR (normal push only)
if ! $GIT -C "$WT" push -q -u origin "$BR" 2>"$STATE/lanes/$N.push.err"; then
  count_fail "lane $N push" "$(tail -c 150 "$STATE/lanes/$N.push.err")"; finish failed "" "push failed"; exit 1
fi
PRN="$($GH pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
if [ -z "$PRN" ]; then
  TITLE="$WORKER_TITLE"; [ -n "$TITLE" ] || TITLE="$($GIT -C "$WT" log -1 --format=%s origin/main..HEAD 2>/dev/null | head -1)"; TITLE="${TITLE:-chore(rsi): $ITEM $SLUG}"
  BODY="$STATUS_NOTE_FILE"; [ -s "$BODY" ] || { BODY="$STATE/lanes/$N.pr-body.fallback.md"; printf 'RSI lane %s, item %s.\n\nWorker summary:\n\n%s\n\nRSI item: %s\n' "$N" "$ITEM" "$(tail -c 3000 "$STATE/lanes/$N.worker.txt")" "$ITEM" > "$BODY"; }
  # A transient GitHub failure must not throw away a finished round; the helper
  # retries and checks whether the PR already exists (see lane-pr.sh).
  if ! PRURL="$(gh_pr_create "$GH_REPO" main "$BR" "$TITLE" "$BODY" 2>"$STATE/lanes/$N.pr.err")"; then
    PR_DETAIL="$(tail -c 300 "$STATE/lanes/$N.pr.err" 2>/dev/null | tr '\n' ' ')"
    count_fail "lane $N PR" "${PR_DETAIL:-no output}"
    finish failed "" "pr create failed: ${PR_DETAIL:-see $STATE/lanes/$N.pr.err}"
    exit 1
  fi
  PRN="$(echo "$PRURL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"
else
  PRURL="https://github.com/$GH_REPO/pull/$PRN"
  if [ -s "$STATUS_NOTE_FILE" ] && [ "$STATUS_NOTE_FILE" -nt "$HDR" ]; then
    $GH pr edit "$PRN" --repo "$GH_REPO" --body-file "$STATUS_NOTE_FILE" >/dev/null 2>&1 || true
  fi
  $GH pr comment "$PRN" --repo "$GH_REPO" --body "RSI lane $N pushed a rework for the merge lane's findings ($(date '+%F %H:%M %Z'))." >/dev/null 2>&1
fi
[ -n "$PRN" ] || { count_fail "lane $N PR" "$PRURL"; finish failed "" "pr create failed: $PRURL"; exit 1; }
[ "$MODE" = rework ] && mkdir -p "$STATE/sendback/done" && mv "$STATE/sendback/$SLUG.md" "$STATE/sendback/done/$SLUG-$(date +%H%M%S).md" 2>/dev/null

if [ $TIMEDOUT -eq 1 ]; then count_timeout "lane $N ($SLUG)" "partial work pushed as PR #$PRN"; else count_ok; fi
scorecard_row "$ITEM $SLUG (lane $N, $MODE)" "$M_WORKER" "pending (merge lane)" "PR opened (${W_MIN}m, \$${COST:-?})$([ $TIMEDOUT -eq 1 ] && echo ', worker hit watchdog')" "[#$PRN]($PRURL)" "pending" "-"
finish done "$PRN" "PR #$PRN ${W_MIN}m \$${COST:-?} swept=$SWEPT_N"
echo "[$(date +%T)] lane $N done PR #$PRN"
rm -rf "$LK"; trap - EXIT

# hand over: merge lane now, refill idle lanes right after
nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null || true
nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null & disown 2>/dev/null || true
exit 0
