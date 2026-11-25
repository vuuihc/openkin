#!/bin/bash
# lane.sh run <n>   — run the claimed worker lane n to completion (worktree → worker → push → PR).
# lane.sh start-claimed — launch every freshly claimed lane in the background (used by the fill pulse).
# lane.sh autofill  — turn merge-lane sendbacks into rework lanes on idle slots (no LLM needed).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$RSI_DIR/runtime/lane-pr.sh"
source "$RSI_DIR/runtime/lane-push.sh"
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
- If \`ui/\` changed: \`cd ui && npm run build\`, commit \`web/dist/index.html\` only (never \`web/dist/assets/\`). For visible UI also save 390×844, 820×1180 and 1100×760 before/after screenshots under \`$STATE/shots/$slug/\`.
- Evidence, not a placeholder: the 820×1180 one must be the surface's real reading state (a conversation surface means a long answer containing a markdown table), never an empty or placeholder view — a blank 820 is a rework round, not evidence.
- If \`ui/\` changed and you added or changed any user-visible string: put it in **both** \`ui/src/i18n/locales/en.ts\` and \`ui/src/i18n/locales/zh.ts\` in the same commit, and run \`cd ui && npx vitest run src/i18n/locales.test.ts\` (same keys, no blank values, same placeholders). When you replace existing copy, \`grep -rn\` the old sentence in \`ui/src/\` including \`*.test.*\`: an assertion on the old English is red CI that the gate charges to this PR.
- Run \`bash rsi/runtime/lane.sh --renamed-copy-check "\$PWD"\` before you finish: only \`RENAME_COPY_OK\` or \`RENAME_COPY_NA\` proves the hand-off. \`RENAME_COPY_RED\` names the removed value, the untouched test still quoting it and the failing test line; the lane runs the same seam before pushing and a RED stops the push.
- Loop code (\`rsi/runtime/**\` or \`scripts/**\` ending \`.sh\`, \`.bash\`, \`.py\`, \`.mjs\`, \`.js\` or \`.ts\`; not \`rsi/runtime/{tests,runs,prompts}/**\`, \`rsi/runtime/ux/journeys/**\`, \`rsi/state/**\` or a deleted file): add or update an entry in a \`*.mutants.json\` manifest this branch adds or modifies for every changed file, with \`file\` set to that path, and that entry's test must fail while its mutant is applied. A manifest already on main does not cover your edit, so an already-covered file still needs a new entry. Make the mutant break the behaviour you changed, not an unrelated line. Run \`bash rsi/runtime/lane.sh --mutant-evidence-check "\$PWD"\` from your worktree before you finish: only \`MUTANT_EVIDENCE_OK\` (or \`MUTANT_EVIDENCE_SKIP\` when no loop code changed) proves the hand-off; a missing entry prints \`MUTANT_EVIDENCE_MISSING\` and a surviving mutant prints \`MUTANT_EVIDENCE_RED\`. The lane runs the same seam before pushing, and either verdict there fails the lane.
- If you remove a quoted value, backticked span, \`--flag\` or UPPER_SNAKE constant of 8+ characters from loop code, untouched tests and \`*.mutants.json\` anchors that still assert it are stale. Run \`bash rsi/runtime/lane.sh --removed-literal-check "\$PWD"\` before you finish: only \`REMOVED_LITERAL_OK\` (or \`REMOVED_LITERAL_NA\` with a reason) proves the hand-off; a \`REMOVED_LITERAL_RED\` names the literal, the file it left and the \`path:line\` that still asserts it. The lane runs the same seam before pushing, and a RED there fails the lane.
- UI ratchet: \`python3 scripts/check-ui-inventory.py\` must not grow. If your change IS the sanctioned primitive/facade (its own raw \`<button>\`, \`createPortal\`, \`role="dialog"\`, \`useAnchoredPanel\` use is the point), run \`python3 scripts/check-ui-inventory.py --update\`, commit the baseline, and say so in the PR body (Risk section). Also run the focused UI suites your change touches plus the design-token test: \`cd ui && npx vitest run <the suites you touched> src/design/tokens.test.ts\` (e.g. focus ring must use \`outline-kin-focus-ring\`). The merge gate owns the full suite; a worker does not run it.
- Commit everything with Conventional Commits and explicit paths. Do NOT push, do NOT open the PR, do NOT touch other worktrees.
- Run \`bash rsi/runtime/format-changed.sh --write --commit\` as the last step before writing the hand-off body: the lane repeats that format commit after you exit, so a rewrite it makes moves the line numbers the body claims (2026-11-23: 786e847d shifted AgentSessionSheet.tsx 240/256/277 → 235/251/272 after the body was written, and the claim seam failed the round).
- Before you finish write the PR body to \`$STATE/lanes/$slug.pr-body.md\` with sections: Symptom · Change · Verification (commands + results) · Claims · Screenshots (paths, or "none: not visible") · Risk · \`RSI item: $item\`.
- Under Verification, the Claims block is one line per user-visible or behavioural claim: \`<path:line> · <test name> · <mutant or the check that would go red without the line>\`. A claim with no test is \`none: <reason of at least 20 characters>\`. A claim whose third field is a backticked command or a \`mutant\` label in this branch's \`*.mutants.json\` is run by the lane: it reverts the claimed file to \`origin/main\` and requires the named test in field 2 to go red. The claimed path is the implementation line the test exercises, not the test file itself. A claim it cannot resolve is NA; record why with \`red-first: none: <reason>\`, and a red that need not name a test carries \`red-first: any\`. The reviewer checks each line against the diff.
- A PR that changes a prose-assertion path (\`docs/product/**\`, \`docs/plans/**\`, \`docs/adr/**\`, \`rsi/GOAL.md\`, \`rsi/DECISIONS.md\`, \`rsi/ASTRYX-PLAN.md\`, \`AGENTS.md\`, \`PRINCIPLE.md\`, \`SYSTEM_DESIGN.md\`) carries one \`Claim check:\` line at column 0 — one command that proves the sentence on this branch — and its literal output under \`Claim output:\`, or waives it with \`Claim check: none: <reason of at least 20 characters>\`.
- The merge gate RUNS that claim command and compares the pasted output against it; a sentence whose claim check is missing or false is not delivery.
- Run \`bash rsi/runtime/lane.sh --claim-check-check "\$PWD" "$STATE/lanes/$slug.pr-body.md"\` before you finish: only \`CLAIM_LANE_OK\` (or \`CLAIM_LANE_NA\` for a code-only diff, \`CLAIM_LANE_WAIVED\` for a reasoned waiver) proves the hand-off; fix a \`CLAIM_LANE_FAIL\` in the body (or the sentence) before finishing. The lane runs the same seam before pushing, and a FAIL there fails the lane.
- Run \`bash rsi/runtime/lane.sh --red-first-check "\$PWD" "$STATE/lanes/$slug.pr-body.md"\` before you finish: only \`RED_FIRST_OK\` proves every claimed test goes red without the change (\`RED_FIRST_NA\` or \`RED_FIRST_WAIVED\` when no claim names a resolvable check); \`RED_FIRST_GREEN\` means the named test passes on \`origin/main\`, so the claim proves nothing and the lane stops before the push.
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
# A branch can also invalidate a pre-existing manifest without touching it: rename or delete a line
# an entry's `old` names and mutants.py can only report `pattern occurs 0 times`. Three rounds
# learned that from the gate or the reviewer (panel-topmost-165641: walk-mutant.json's J7 anchor
# after a UI rename; quality-reading-surface-192923; uxcooldown-hold-042926: entries mutating
# deleted lines), so every tracked manifest is validated against this branch's changed-or-deleted
# files, before the SKIP return below. The moved file need not be loop code — walk-mutant.json
# mutates the UI — which is why the per-branch rule alone could not see it. Validation only: a
# pre-existing manifest's tests are not run here, so this adds no gate minutes. An anchor already
# broken at the branch point is pre-existing debt and is skipped: charging it to a lane that only
# touched the file would add the rework round this seam exists to remove (measured 2026-11-24:
# 8 zero-count and 3 multi-count anchors on main). Unparseable pre-existing manifests are likewise
# ignored; the branch-manifest rule below still fails closed.
mutant_evidence_check() { # <worktree> — prints one verdict line; 0 = ok/skip, 1 = red/missing
  local wt="$1" base changed manifests touched all_manifests rc
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
  # Anchor validation for pre-existing manifests: every tracked manifest's entries whose `file` this
  # branch changed or deleted must still hold exactly one occurrence of `old`. Deletions count here
  # (no --diff-filter=d), because a deleted file is the loudest stale anchor. A committed rename is
  # a deletion too, and rename detection would print only the new path, so it is off: both paths
  # show up and the old one fails as `file is gone`. An anchor already stale at the branch point is
  # pre-existing debt, not this branch's edit, and is skipped.
  touched="$(
    { "$GIT" -C "$wt" diff --name-only --no-renames "$base" 2>/dev/null
      "$GIT" -C "$wt" ls-files --others --exclude-standard 2>/dev/null
    } | LC_ALL=C sort -u
  )"
  if [ -n "$touched" ]; then
    # The three conventions the repo uses: *.mutants.json, *-mutant.json (walk-mutant.json) and
    # */mutants.json (probe/**). -z keeps a path with spaces in one piece.
    all_manifests="$(
      "$GIT" -C "$wt" ls-files -z 2>/dev/null | tr '\0' '\n' \
        | grep -E '(\.mutants\.json|-mutant\.json|/mutants\.json)$' || true
    )"
    rc=0
    MUTANT_TOUCHED="$touched" MUTANT_ALL_MANIFESTS="$all_manifests" \
      MUTANT_BASE="$base" MUTANT_GIT="${GIT:-git}" \
      python3 - "$wt" <<'PY' || rc=$?
import json, os, subprocess, sys

wt = sys.argv[1]
touched = {line for line in os.environ.get("MUTANT_TOUCHED", "").splitlines() if line}
manifests = [line for line in os.environ.get("MUTANT_ALL_MANIFESTS", "").splitlines() if line]
base = os.environ.get("MUTANT_BASE", "")
git = os.environ.get("MUTANT_GIT", "git")

def read(path):
    try:
        with open(os.path.join(wt, path), encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None

base_text = {}
for m in manifests:
    try:
        data = json.loads(read(m) or "")
        if not isinstance(data, list):
            raise ValueError
    except Exception:
        continue  # pre-existing manifests only; the branch-manifest rule below still fails closed
    for e in data:
        if not isinstance(e, dict):
            continue
        if not all(isinstance(e.get(k), str) for k in ("file", "old", "new", "test")):
            continue
        f = e["file"][2:] if e["file"].startswith("./") else e["file"]
        if f not in touched:
            continue
        if f not in base_text:
            proc = subprocess.run([git, "-C", wt, "show", f"{base}:{f}"],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            base_text[f] = proc.stdout.decode("utf-8", "replace") if proc.returncode == 0 else None
        if base_text[f] is None or base_text[f].count(e["old"]) != 1:
            continue  # already stale at the branch point: debt, not this branch's edit
        body = read(f)
        if body is None:
            print(f"MUTANT_EVIDENCE_RED: {m} · {f}: file is gone")
            sys.exit(1)
        count = body.count(e["old"])
        if count != 1:
            print(f"MUTANT_EVIDENCE_RED: {m} · {f}: anchor occurs {count} times")
            sys.exit(1)
PY
    [ "$rc" -eq 0 ] || return 1
  fi
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

# --- claim check: the lane runs the merge gate's own prose rule before it pushes ------------------
# The live `mech-claim·rsi` shape is six rounds in the 11-20→11-21 window, each the same finding:
# a prose PR's `Claim check:` line was missing, its `Claim output:` block empty, or its output
# invented, and the worker learned that only after a full gate and an independent review
# (state/sendback/done/gap-log-close-20261121-090510, walk-continue-005-134144, phone-list-deliver-*).
# rsi/runtime/claim_check.py is the single rule and merge.sh owns the call site; this seam only
# runs that same rule in the lane, against the same changed-file list merge.sh computes, and fails
# closed when it cannot. The worker runs it before finishing (worker_contract); the lane runs it
# after the format commit and before the push, so the reviewer is no longer the first reader.
# The verdict's leading CLAIM_ becomes CLAIM_LANE_ so a lane failure is distinguishable from the
# merge lane's. The body is passed through as-is: claim_check.py returns NA for a code-only diff
# without reading it, and names an unreadable body only when a prose path changed.
claim_lane_check() { # <worktree> <body-file> — prints one CLAIM_LANE_* verdict; exits with the checker's code
  local wt="$1" body="$2" changed out rc
  [ -d "$wt" ] || { echo "CLAIM_LANE_FAIL: $wt · worktree not found"; return 1; }
  # A seam that cannot read the branch point would see no prose change and wave the PR through.
  "$GIT" -C "$wt" rev-parse --verify -q origin/main >/dev/null 2>&1 \
    || { echo "CLAIM_LANE_FAIL: $wt · origin/main is not resolvable"; return 1; }
  changed="$(mktemp "${TMPDIR:-/tmp}/claim-lane.XXXXXX")" \
    || { echo "CLAIM_LANE_FAIL: cannot create a temp file for the changed-file list"; return 1; }
  # The merge gate's own computation (merge.sh): renames off, a deletion counts, `origin/main...HEAD`
  # is the PR's own diff. A seam that computed this differently could pass a PR the gate then sends
  # back, which is the round this row removes.
  "$GIT" -C "$wt" -c core.fileMode=false diff --no-renames --raw origin/main...HEAD 2>/dev/null \
    | awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' > "$changed"
  out="$(python3 "$RSI_DIR/runtime/claim_check.py" "$wt" "$body" "$changed" 2>&1)"; rc=$?
  rm -f "$changed"
  printf '%s\n' "$out" | sed 's/^CLAIM_/CLAIM_LANE_/'
  return "$rc"
}

# The pre-push seam proves the worker's file; the post-PR seam proves what GitHub retained.
# Probe with a missing body so claim_check.py alone decides NA, without running a local claim
# command twice or giving code-only PRs a new network dependency. A prose PR must both pass the
# merge gate's rule on its live text and match the intended body (ignoring trailing newlines).
pr_body_check() { # <worktree> <pr-number> <local-body-file> — one PR_BODY_OK/FAIL verdict
  local wt="$1" prn="$2" body="$3" tmp out rc attempt
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pr-body.XXXXXX")" \
    || { echo "PR_BODY_FAIL: cannot create a temp directory for the live body"; return 1; }
  out="$(claim_lane_check "$wt" "$tmp/live" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" = CLAIM_LANE_NA:* ]]; then
    rm -rf "$tmp"
    echo "PR_BODY_OK: NA (code-only PR; no live body read)"
    return 0
  fi
  # Only the missing-body verdict is expected here. A bad branch point must not turn into NA.
  if [[ "$out" != 'CLAIM_LANE_FAIL: cannot read the PR body:'* ]]; then
    rm -rf "$tmp"
    printf 'PR_BODY_FAIL: %s\n' "$out"
    return 1
  fi
  for attempt in 1 2; do
    bounded_run 5 "$GH" pr view "$prn" --repo "$GH_REPO" --json body --jq .body \
      > "$tmp/live" 2> "$tmp/read.err"; rc=$?
    [ "$rc" -eq 0 ] && LC_ALL=C grep -q '[^[:space:]]' "$tmp/live" && break
  done
  if [ "$rc" -ne 0 ] || ! LC_ALL=C grep -q '[^[:space:]]' "$tmp/live"; then
    rm -rf "$tmp"
    echo "PR_BODY_FAIL: cannot read live PR #$prn body after 2 attempts (rc=$rc; empty or unreadable body)"
    return 1
  fi
  out="$(claim_lane_check "$wt" "$tmp/live" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -rf "$tmp"
    printf 'PR_BODY_FAIL: %s\n' "${out#CLAIM_LANE_FAIL: }"
    return 1
  fi
  if [ ! -r "$body" ] || [ "$(<"$tmp/live")" != "$(<"$body")" ]; then
    rm -rf "$tmp"
    echo "PR_BODY_FAIL: live PR #$prn body differs from the local handoff body"
    return 1
  fi
  rm -rf "$tmp"
  printf 'PR_BODY_OK: live body matches local; %s\n' "${out#CLAIM_LANE_}"
}

# --- red first: a claimed test must go red when its file is reverted -----------------------------
# The 1d ledger ending 11-23 03:59 read 46 rounds / 44 merges = 1.05, and `test-green·not-red` was
# 12 of those rounds: the Claims line named a test that was green on origin/main (`activity-pill`)
# or the one test that stayed green (`local-main-only`). The Claims block was "a writing rule, not
# a hard gate", so the worker learned it from a sendback after a full gate and a model review.
# rsi/runtime/red_first.py is the rule; this seam runs it in the lane, before the push, against the
# same changed-file list the merge gate computes. A claim the checker cannot resolve is NA, never
# a FAIL (see red_first.py), so an honest PR the checker cannot read is not sent back here.
red_first_check() { # <worktree> <body-file> — prints one RED_FIRST_* verdict; exits with the checker's code
  local wt="$1" body="$2" out rc
  [ -d "$wt" ] || { echo "RED_FIRST_FAIL: $wt · worktree not found"; return 1; }
  # A seam that cannot read the branch point cannot revert anything: fail closed, not NA.
  "$GIT" -C "$wt" rev-parse --verify -q origin/main >/dev/null 2>&1 \
    || { echo "RED_FIRST_FAIL: $wt · origin/main is not resolvable"; return 1; }
  out="$(python3 "$RSI_DIR/runtime/red_first.py" "$wt" "$body" 2>&1)"; rc=$?
  printf '%s\n' "$out"
  return "$rc"
}

# --- removed literal: a removed value must not leave an untouched test asserting it --------------
# A branch deletes a flag, a command fragment or a config value from loop code and leaves an
# untouched test file (or an untouched *.mutants.json anchor) still asserting it. Nothing notices
# until the full gate or a reviewer runs, so the PR is sent back after a whole round.
# rsi/runtime/removed_literal.py is the rule: it derives the literals this branch removed, finds the
# untouched tests and manifests that still assert them, runs only those tests (bounded) and names
# the literal, the file it left and the path:line that still asserts it. This seam runs it in the
# lane before the push and gives the whole run one watchdog; the checker owns the per-file bound.
# A branch that cannot be measured is NA, never a green (see the checker).
removed_literal_check() { # <worktree> — prints one REMOVED_LITERAL_* verdict; exits with the checker's code
  local wt="$1" out rc secs
  [ -d "$wt" ] || { echo "REMOVED_LITERAL_NA: $wt · worktree not found"; return 0; }
  secs="${RSI_REMOVED_LITERAL_SECS:-240}"
  case "$secs" in ''|*[!0-9]*) secs=240 ;; esac
  [ "$secs" -gt 300 ] && secs=300
  out="$(bounded_run "$((secs + 5))" python3 "$RSI_DIR/runtime/removed_literal.py" "$wt" 2>&1)"; rc=$?
  printf '%s\n' "$out"
  # The watchdog's timeout is no verdict: report NA rather than a fabricated pass.
  [ "$rc" -eq 124 ] && { echo "REMOVED_LITERAL_NA: the check did not finish within ${secs}s"; return 0; }
  return "$rc"
}

# --- renamed copy: a locale rename must not leave an untouched test asserting the old value -----
# The measured `gate+review·ui` shape is 37 of 340 rounds in 7 days (state/rework-attrib.md,
# 2026-11-24): a one-line copy change opens green and comes back red because a test file the worker
# never opened still asserts the old English. The rule has been prose in worker_contract since
# 2026-11-22 17:23 and still did not fire on 2026-11-24, when PR #665 renamed `nav.openCover` in
# en.ts and left four `getByRole` queries on the old label in Sidebar.dom.test.tsx; CI and the merge
# lane's full gate both spent their run to say what a grep would have said in a second. This seam is
# the executable form: stage 1 derives the removed English values from the branch diff without npm,
# stage 2 runs only the test files that still quote one, bounded, and every path it cannot measure
# is NA, never OK. The worker runs it before finishing (worker_contract); the lane runs it after the
# format commit and before the push, so the reviewer is no longer the first reader.
renamed_copy_check() { # <worktree> — one RENAME_COPY_* verdict; 0 for OK/NA, 1 for RED
  local wt="$1" raw changed cands n value hits first_hit files hit_value hit_fileline
  local secs rc vitest_out fail_line f
  [ -d "$wt" ] || { echo "RENAME_COPY_NA: $wt · worktree not found"; return 0; }
  # No branch point, no diff, no verdict: NA, never a green this seam did not measure.
  "$GIT" -C "$wt" rev-parse --verify -q origin/main >/dev/null 2>&1 \
    || { echo "RENAME_COPY_NA: origin/main is not resolvable"; return 0; }
  raw="$(mktemp "${TMPDIR:-/tmp}/rename-copy.XXXXXX")" \
    || { echo "RENAME_COPY_NA: cannot create a temp file for the changed-file list"; return 0; }
  # The merge gate's own computation (merge.sh): renames off, a deletion counts, `origin/main...HEAD`
  # is the PR's own diff. A seam that computed this differently could miss the locale change.
  if ! "$GIT" -C "$wt" -c core.fileMode=false diff --no-renames --raw origin/main...HEAD \
      > "$raw" 2>/dev/null; then
    rm -f "$raw"
    echo "RENAME_COPY_NA: cannot read the origin/main...HEAD diff"
    return 0
  fi
  awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' "$raw" > "$raw.paths"; rm -f "$raw"
  if ! LC_ALL=C grep -qxF 'ui/src/i18n/locales/en.ts' "$raw.paths" \
     && ! LC_ALL=C grep -qxF 'ui/src/i18n/locales/zh.ts' "$raw.paths"; then
    rm -f "$raw.paths"
    echo "RENAME_COPY_NA: no locale change"
    return 0
  fi
  rm -f "$raw.paths"
  # Stage 1, hermetic: the values on removed English lines, trimmed, minus the noise floor and the
  # values the branch still carries under another key (a move, not a rename).
  cands="$(python3 - "$GIT" "$wt" <<'PY'
import re, subprocess, sys

git, wt = sys.argv[1:3]
try:
    proc = subprocess.run(
        [git, "-C", wt, "-c", "core.fileMode=false", "diff", "-U0",
         "origin/main...HEAD", "--", "ui/src/i18n/locales/en.ts"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=60)
except Exception:
    sys.exit(3)
if proc.returncode != 0:
    sys.exit(3)
blob = ""
for name in ("en.ts", "zh.ts"):
    try:
        with open("%s/ui/src/i18n/locales/%s" % (wt, name), encoding="utf-8",
                  errors="replace") as fh:
            blob += fh.read()
    except OSError:
        pass
seen = set()
for line in proc.stdout.splitlines():
    if not line.startswith("-") or line.startswith("---"):
        continue
    hit = re.search(r':\s*"((?:[^"\\]|\\.)*)"', line)
    if not hit:
        continue
    value = hit.group(1).strip()
    if len(value) < 8 or value in seen or value in blob:
        continue
    seen.add(value)
    print(value)
PY
)"; rc=$?
  [ "$rc" -eq 0 ] || { echo "RENAME_COPY_NA: cannot read the locale diff"; return 0; }
  # Stage 1b, hermetic: only test files that still quote a removed value are worth running.
  n=0; hit_value=""; hit_fileline=""; files=""
  while IFS= read -r value; do
    [ -n "$value" ] || continue
    n=$((n + 1))
    hits="$( cd "$wt" && LC_ALL=C grep -rnF --include='*.test.ts' --include='*.test.tsx' \
      -e "$value" ui/src 2>/dev/null )"
    [ -n "$hits" ] || continue
    first_hit="$(printf '%s\n' "$hits" | head -1)"
    if [ -z "$hit_value" ]; then
      hit_value="$value"
      hit_fileline="$(printf '%s' "$first_hit" | cut -d: -f1-2)"
    fi
    files="$files$(printf '%s\n' "$hits" | cut -d: -f1)
"
  done <<< "$cands"
  if [ -z "$hit_value" ]; then
    echo "RENAME_COPY_OK: $n removed value(s); no test asserts them"
    return 0
  fi
  # Stage 2, bounded: a fixture or a fresh clone without the console's dependencies cannot decide,
  # so it is NA that names the static finding instead of inventing a verdict. The checked binary is
  # what runs (`npx` would try to fetch vitest from the network, which a lane seam must never do).
  if [ ! -x "$wt/ui/node_modules/.bin/vitest" ]; then
    local why='ui/node_modules is missing'
    [ -d "$wt/ui/node_modules" ] && why='ui/node_modules/.bin/vitest is missing'
    echo "RENAME_COPY_NA: cannot run vitest ($why); removed value \"$hit_value\" still asserted in $hit_fileline"
    return 0
  fi
  files="$(printf '%s' "$files" | sed '/^$/d' | sort -u)"
  local -a rel=()
  while IFS= read -r f; do
    [ -n "$f" ] && rel+=("${f#ui/}")
  done <<< "$files"
  secs="${RSI_RENAME_COPY_SECS:-300}"
  case "$secs" in ''|*[!0-9]*) secs=300 ;; esac
  [ "$secs" -gt 300 ] && secs=300
  vitest_out="$(bounded_run "$secs" bash -c 'cd "$1" || exit 126; shift; exec env VITEST_MAX_WORKERS=2 ./node_modules/.bin/vitest run "$@"' \
    _ "$wt/ui" "${rel[@]}" 2>&1)"; rc=$?
  case "$rc" in
    0)
      echo "RENAME_COPY_OK: $n removed value(s); \"$hit_value\" asserted in $hit_fileline but the suite passes"
      return 0 ;;
    124)
      echo "RENAME_COPY_NA: vitest timed out after ${secs}s; removed value \"$hit_value\" still asserted in $hit_fileline"
      return 0 ;;
    126|127)
      echo "RENAME_COPY_NA: vitest could not start (exit $rc); removed value \"$hit_value\" still asserted in $hit_fileline"
      return 0 ;;
  esac
  fail_line="$(printf '%s\n' "$vitest_out" | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' \
    | grep -m1 -E '(^|[[:space:]])FAIL[[:space:]]' || true)"
  [ -n "$fail_line" ] || fail_line="$(printf '%s\n' "$vitest_out" \
    | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | grep -m1 '×' || true)"
  [ -n "$fail_line" ] || fail_line="vitest exited $rc with no FAIL line"
  fail_line="$(printf '%s' "$fail_line" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-200)"
  echo "RENAME_COPY_RED: \"$hit_value\" still asserted in $hit_fileline; $fail_line"
  return 1
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
if [ "$CMD" = --claim-check-check ]; then
  [ "$#" -eq 3 ] || { echo "usage: lane.sh --claim-check-check <worktree> <body-file>" >&2; exit 2; }
  claim_lane_check "$2" "$3"; exit $?
fi
if [ "$CMD" = --red-first-check ]; then
  [ "$#" -eq 3 ] || { echo "usage: lane.sh --red-first-check <worktree> <body-file>" >&2; exit 2; }
  red_first_check "$2" "$3"; exit $?
fi
if [ "$CMD" = --removed-literal-check ]; then
  [ "$#" -eq 2 ] || { echo "usage: lane.sh --removed-literal-check <worktree>" >&2; exit 2; }
  removed_literal_check "$2"; exit $?
fi
if [ "$CMD" = --pr-body-check ]; then
  [ "$#" -eq 4 ] || { echo "usage: lane.sh --pr-body-check <worktree> <pr-number> <local-body-file>" >&2; exit 2; }
  pr_body_check "$2" "$3" "$4"; exit $?
fi
if [ "$CMD" = --renamed-copy-check ]; then
  [ "$#" -eq 2 ] || { echo "usage: lane.sh --renamed-copy-check <worktree>" >&2; exit 2; }
  renamed_copy_check "$2"; exit $?
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
    # A rework that pushed its fix and died before the merge lane archived the sendback leaves a
    # sendback whose fix is already on the branch; claiming it re-edits work that is already done
    # and burns the loop's scarcest slot (2026-11-23 12:23: a sendback written 12:05 opened a lane
    # although 1bd56a7d was already pushed; the CEO stopped it at 49 s). This is merge.sh's own
    # rule (merge.sh:93-101) on the autofill side: when the head moved past the sendback, archive
    # it and continue — not break — so the pass still reaches the next sendback. Fail open on
    # every unreadable input (missing origin/$br, empty %ct, unreadable mtime, non-numeric either
    # side): a git outage must never stall a real rework. A tie is not stale: %ct is whole seconds
    # and a same-second push is normal.
    head_ct="$($GIT -C "$RSI_CTRL" log -1 --format=%ct "origin/$br" 2>/dev/null || true)"
    sb_ct="$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime))' "$sb" 2>/dev/null || true)"
    case "$head_ct" in ''|*[!0-9]*) head_ct="" ;; esac
    case "$sb_ct" in ''|*[!0-9]*) sb_ct="" ;; esac
    if [ -n "$head_ct" ] && [ -n "$sb_ct" ] && [ "$head_ct" -gt "$sb_ct" ]; then
      head="$($GIT -C "$RSI_CTRL" rev-parse --verify "origin/$br" 2>/dev/null || true)"
      arch="$STATE/sendback/done/$slug-stale-head-$(date +%H%M%S).md"
      mkdir -p "$STATE/sendback/done"
      mv "$sb" "$arch"
      echo "rework $slug: head ${head:0:8} is newer than the sendback, archived to $arch (no rework lane)"
      continue
    fi
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
  # The pgid and parent-pid walks miss a child that left the worker's tree
  # (setsid -> reparented to launchd, e.g. `expo start`): sweep anything still
  # holding a working directory under the lane worktree. WT is set after this
  # trap is armed, so guard for the early-exit path. Failures print "no verdict"
  # inside rsi_reap_cwd and never turn cleanup red.
  if [ -n "${WT:-}" ]; then rsi_reap_cwd "$WT" || true; fi
  # Simulators a worker booted are launchd-owned, never our children either.
  # Shut down only the ones that were not booted when this lane launched — and
  # only when no other live lane could still be using them.
  if [ -f "$STATE/lanes/$N.sims-before" ]; then
    other_live="$(rsi_other_live_lane "$LK")"
    if [ -n "$other_live" ]; then
      echo "left new simulators booted: lane ${other_live%.lock} is live" >&2
    else
      rsi_sim_shutdown_new "$STATE/lanes/$N.sims-before" || true
    fi
    rm -f "$STATE/lanes/$N.sims-before"
  fi
  [ $FINISHED -eq 0 ] && python3 "$LANES_PY" finish "$N" --status crashed --note "lane.sh exited early"
  rm -rf "$LK"
}
trap cleanup EXIT
finish() { FINISHED=1; python3 "$LANES_PY" finish "$N" --status "$1" --pr "${2:-}" --note "${3:-}"; }

WT="$WT_ROOT/rsi-$SLUG"; BR="rsi/$SLUG"; TAG="lane$N-$SLUG"

# --- control-tree guard -----------------------------------------------------------------------
# WT_ROOT holds every lane worktree, and the control checkout itself can be a symlink to a
# directory under it. A slug that names that directory makes WT resolve to RSI_CTRL, and the
# worktree add/merge block below would then do git work inside the control checkout: the gate,
# the walker, GOAL.md and the live state directory become that lane's, and every later pulse runs
# the wrong tree while every status line still reads healthy (same family as 2026-11-20, when one
# stale line held the control tree 17 commits behind main for six hours). Resolve both paths with
# Python — macOS has no GNU realpath — and refuse before the first git call. A resolution failure
# fails closed; distinct paths, including a worktree that does not exist yet, still run.
lane_real_path() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null; }
WT_REAL="$(lane_real_path "$WT")" || WT_REAL=""
CTRL_REAL="$(lane_real_path "$RSI_CTRL")" || CTRL_REAL=""
if [ -z "$WT_REAL" ] || [ -z "$CTRL_REAL" ]; then
  GUARD_NOTE="control-tree guard: cannot resolve worktree $WT or control checkout $RSI_CTRL; refusing to start"
  echo "$GUARD_NOTE" >&2
  finish blocked "" "$GUARD_NOTE"
  exit 1
fi
if [ "$WT_REAL" = "$CTRL_REAL" ]; then
  GUARD_NOTE="control-tree guard: worktree $WT resolves to the control checkout $CTRL_REAL (control checkout $RSI_CTRL); refusing to start"
  echo "$GUARD_NOTE" >&2
  finish blocked "" "$GUARD_NOTE"
  exit 1
fi

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
  # A `worktree add -b` that half-fails leaves a local $BR with 0 commits and no worktree;
  # every later dispatch then dies on `-b` (branch exists) forever — lane 2, rn-gate-timeout,
  # 2026-11-25. Reuse the leftover only when it holds nothing of its own (0 commits ahead of
  # origin/main): attach it, then fast-forward so the worktree sits on main. A branch with
  # real commits, an unreadable count, or a failed retry keeps the failed path unchanged.
  if ! $GIT -C "$RSI_CTRL" worktree add "$WT" -b "$BR" origin/main >/dev/null 2>&1; then
    if $GIT -C "$RSI_CTRL" rev-parse --verify -q "refs/heads/$BR" >/dev/null \
       && [ "$($GIT -C "$RSI_CTRL" rev-list --count "origin/main..$BR" 2>/dev/null || echo 1)" = 0 ] \
       && $GIT -C "$RSI_CTRL" worktree add "$WT" "$BR" >/dev/null 2>&1 \
       && $GIT -C "$WT" merge -q --ff-only origin/main >/dev/null 2>&1; then
      echo "reusing leftover empty branch $BR"
    else
      finish failed "" "cannot create worktree $WT"; count_fail "lane $N" "worktree $WT"; exit 1
    fi
  fi
fi
BASE_N="$($GIT -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" 2>&1 | tail -2

STATUS_NOTE_FILE="$STATE/lanes/$SLUG.pr-body.md"
HDR="$STATE/lanes/$N.worker-brief.md"
write_worker_brief > "$HDR"

export BUDGET_GUARD="$LANE_BUDGET_USD" DISPATCH_MAX_SECS="$LANE_WORKER_SECS"
# Snapshot booted simulators before the worker can boot its own: cleanup shuts
# down only the difference, so a simulator that was already up stays up. The
# marker records a query that succeeded; without it cleanup leaves every
# simulator alone rather than reading a failed snapshot as "nothing was up".
rsi_sim_booted > "$STATE/lanes/$N.sims-before" \
  && echo '#complete' >> "$STATE/lanes/$N.sims-before"
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

# A prose delivery hands off only when its body's claim check runs and its output matches. The
# worker runs this same seam first (worker_contract); this pass is authoritative, and
# rsi/runtime/claim_check.py is the merge gate's own rule. On a FAIL the branch stays committed
# and clean: no push, no PR, and the worker fixes the body in its own session.
CLAIM_RETRY_NOTE=""
if ! CLAIM_EV="$(bash "$SELF" --claim-check-check "$WT" "$STATUS_NOTE_FILE" 2>&1)"; then
  [ -n "$CLAIM_EV" ] && printf '%s\n' "$CLAIM_EV"
  # The retry is a general guard, not a fix for the 2026-11-23 incident: there the body was
  # written at 12:21:48, the worker exited at 12:23:32, and the lane's own format commit
  # 786e847d (12:23:35) shifted the claimed lines, so the seam read a stale body at 12:23:36 and
  # a re-read of the same tree could not help (the worker contract now formats before the body).
  # The guard still earns its keep when a body is rewritten between the seam's read and the
  # record: re-read once after a short bounded pause so the record describes the bytes being
  # handed off. claim_lane_check() executes the worker-authored claim command, so the second run
  # repeats any side effects; only the final verdict reaches .claim.txt, whose one-writer
  # contract is unchanged. A genuine body problem still fails: two runs, one sleep, no loop.
  CLAIM_ATTEMPTS="$STATE/lanes/$N.claim-attempts.txt"
  printf 'attempt 1: %s\n' "$(printf '%s' "${CLAIM_EV:-check produced no output}" | head -1)" > "$CLAIM_ATTEMPTS"
  CLAIM_RETRY_SECS_USE="${RSI_CLAIM_RETRY_SECS:-1}"
  case "$CLAIM_RETRY_SECS_USE" in ''|*[!0-9]*) CLAIM_RETRY_SECS_USE=1 ;; esac
  [ "$CLAIM_RETRY_SECS_USE" -gt 5 ] && CLAIM_RETRY_SECS_USE=5
  CLAIM_RETRY_OK=0
  if [ "$CLAIM_RETRY_SECS_USE" -gt 0 ]; then
    # The pause is bounded twice: by the clamp above and by bounded_run's own watchdog.
    bounded_run "$((CLAIM_RETRY_SECS_USE + 2))" sleep "$CLAIM_RETRY_SECS_USE" >/dev/null 2>&1 || true
    # Re-read the body from disk; never reuse the first verdict.
    CLAIM_EV="$(bash "$SELF" --claim-check-check "$WT" "$STATUS_NOTE_FILE" 2>&1)"; CLAIM_RC=$?
    printf 'attempt 2: %s\n' "$(printf '%s' "${CLAIM_EV:-check produced no output}" | head -1)" >> "$CLAIM_ATTEMPTS"
    [ -n "$CLAIM_EV" ] && printf '%s\n' "$CLAIM_EV"
    [ "$CLAIM_RC" -eq 0 ] && CLAIM_RETRY_OK=1
  fi
  if [ "$CLAIM_RETRY_OK" -eq 0 ]; then
    # Keep the verdict and the command's own tail on disk, the way merge.sh's claim_check_gate
    # keeps its evidence. A flattened note cannot tell a genuine red from a slow or truncated run,
    # and only the failure branch writes here, so a later green hand-off never rewrites the record.
    printf '%s\n' "${CLAIM_EV:-check produced no output}" > "$STATE/lanes/$N.claim.txt"
    CLAIM_NOTE="$(printf '%s' "$CLAIM_EV" | tr '\n' ' ' | sed 's/  */ /g')"
    finish failed "" "claim check: ${CLAIM_NOTE:-check produced no output} (evidence: $STATE/lanes/$N.claim.txt)"
    exit 1
  fi
  CLAIM_RETRY_NOTE="claim check passed on re-read (attempt 1 failed; evidence $CLAIM_ATTEMPTS)"
fi
[ -n "$CLAIM_EV" ] && printf '%s\n' "$CLAIM_EV"

# A claimed test must be the test that goes red without the change. The worker runs this same seam
# first (worker_contract); this pass is authoritative. On GREEN, OTHER or NO_VERDICT the branch
# stays committed and unpushed, and the verdict names the claim the worker has to fix.
if ! RED_EV="$(bash "$SELF" --red-first-check "$WT" "$STATUS_NOTE_FILE" 2>&1)"; then
  [ -n "$RED_EV" ] && printf '%s\n' "$RED_EV"
  # Same evidence discipline as the claim check above: the verdict and the command's own output,
  # written only on failure so a later green hand-off never rewrites the record.
  printf '%s\n' "${RED_EV:-check produced no output}" > "$STATE/lanes/$N.red-first.txt"
  RED_NOTE="$(printf '%s' "$RED_EV" | tr '\n' ' ' | sed 's/  */ /g')"
  finish failed "" "red first: ${RED_NOTE:-check produced no output} (evidence: $STATE/lanes/$N.red-first.txt)"
  exit 1
fi
[ -n "$RED_EV" ] && printf '%s\n' "$RED_EV"

# A removed literal must not leave an untouched test or mutant anchor asserting it. The worker
# runs this same seam first (worker_contract); this pass is authoritative. On RED the branch stays
# committed and unpushed, and the verdict names the literal, the file it left and the asserting
# path:line. NA is honest (nothing measurable) and does not stop the hand-off.
if ! REMOVED_EV="$(bash "$SELF" --removed-literal-check "$WT" 2>&1)"; then
  [ -n "$REMOVED_EV" ] && printf '%s\n' "$REMOVED_EV"
  printf '%s\n' "${REMOVED_EV:-check produced no output}" > "$STATE/lanes/$N.removed-literal.txt"
  REMOVED_NOTE="$(printf '%s' "$REMOVED_EV" | tr '\n' ' ' | sed 's/  */ /g')"
  finish failed "" "removed literal: ${REMOVED_NOTE:-check produced no output} (evidence: $STATE/lanes/$N.removed-literal.txt)"
  exit 1
fi
[ -n "$REMOVED_EV" ] && printf '%s\n' "$REMOVED_EV"

# A locale rename hands off only when no untouched test still asserts the removed value. The
# worker runs this same seam first (worker_contract); this pass is authoritative. A RED names the
# value, the test file that still quotes it and the failing test line; the branch then stays
# committed and unpushed, with the verdict under lanes/<n>.rename.txt like the claim record.
if ! RENAME_EV="$(bash "$SELF" --renamed-copy-check "$WT" 2>&1)"; then
  [ -n "$RENAME_EV" ] && printf '%s\n' "$RENAME_EV"
  printf '%s\n' "${RENAME_EV:-check produced no output}" > "$STATE/lanes/$N.rename.txt"
  RENAME_NOTE="$(printf '%s' "$RENAME_EV" | tr '\n' ' ' | sed 's/  */ /g')"
  finish failed "" "renamed copy: ${RENAME_NOTE:-check produced no output} (evidence: $STATE/lanes/$N.rename.txt)"
  exit 1
fi
[ -n "$RENAME_EV" ] && printf '%s\n' "$RENAME_EV"

# push + PR (normal push only)
# A transient transport failure must not throw away a finished round; git_push_retry retries
# and looks at the remote head before pushing again (see lane-push.sh). A final failure leaves
# the round committed and unpushed: mark it delivered-unpushed, record the recovery line for a
# person, and charge no count_fail — a TLS blip is not a runner failure.
if ! git_push_retry "$GIT" "$WT" "$BR" "$STATE/lanes/$N.push.err"; then
  PUSH_SHA="$($GIT -C "$WT" rev-parse HEAD 2>/dev/null || true)"
  PUSH_NOTE="$(unpushed_note "$BR" "${PUSH_SHA:-unknown}" "$WT")"
  printf '%s\n' "$PUSH_NOTE" > "$STATE/lanes/$N.push.txt"
  printf '%s\n' "$PUSH_NOTE"
  finish delivered-unpushed "" "push failed after ${RSI_PUSH_ATTEMPTS_USED:-3} attempt(s): branch $BR at ${PUSH_SHA:-unknown} is committed and unpushed; recovery: git -C $WT push -u origin $BR"
  exit 1
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
    bounded_run 10 "$GH" pr edit "$PRN" --repo "$GH_REPO" --body-file "$STATUS_NOTE_FILE" \
      >"$STATE/lanes/$N.pr-edit.log" 2>&1; PR_EDIT_RC=$?
    if [ "$PR_EDIT_RC" -ne 0 ]; then
      echo "PR body edit failed (rc=$PR_EDIT_RC); live read-back decides; see lanes/$N.pr-edit.log"
    fi
  fi
  $GH pr comment "$PRN" --repo "$GH_REPO" --body "RSI lane $N pushed a rework for the merge lane's findings ($(date '+%F %H:%M %Z'))." >/dev/null 2>&1
fi
[ -n "$PRN" ] || { count_fail "lane $N PR" "$PRURL"; finish failed "" "pr create failed: $PRURL"; exit 1; }
# Only the body the merge lane will read can authorize the handoff. The branch is already pushed;
# on failure keep it committed, record the verdict, and leave the lane failed for a body repair.
PR_BODY_EV="$(bounded_run "${RSI_PR_BODY_CHECK_SECS:-180}" bash "$SELF" --pr-body-check "$WT" "$PRN" "$STATUS_NOTE_FILE" 2>&1)"; PR_BODY_RC=$?
if [ "$PR_BODY_RC" -ne 0 ]; then
  if [ "$PR_BODY_RC" -eq 124 ]; then
    PR_BODY_EV="PR_BODY_FAIL: live body check timed out (no verdict)"
  fi
  [ -n "$PR_BODY_EV" ] || PR_BODY_EV="PR_BODY_FAIL: live body check produced no verdict"
  printf '%s\n' "$PR_BODY_EV"
  PR_BODY_NOTE="$(printf '%s' "$PR_BODY_EV" | tr '\n' ' ' | sed 's/  */ /g')"
  finish failed "" "pr body: ${PR_BODY_NOTE:-check produced no output}"
  exit 1
fi
[ -n "$PR_BODY_EV" ] && printf '%s\n' "$PR_BODY_EV"
[ "$MODE" = rework ] && mkdir -p "$STATE/sendback/done" && mv "$STATE/sendback/$SLUG.md" "$STATE/sendback/done/$SLUG-$(date +%H%M%S).md" 2>/dev/null

if [ $TIMEDOUT -eq 1 ]; then count_timeout "lane $N ($SLUG)" "partial work pushed as PR #$PRN"; else count_ok; fi
scorecard_row "$ITEM $SLUG (lane $N, $MODE)" "$M_WORKER" "pending (merge lane)" "PR opened (${W_MIN}m, \$${COST:-?})$([ $TIMEDOUT -eq 1 ] && echo ', worker hit watchdog')" "[#$PRN]($PRURL)" "pending" "-"
finish done "$PRN" "PR #$PRN ${W_MIN}m \$${COST:-?} swept=$SWEPT_N${CLAIM_RETRY_NOTE:+ · $CLAIM_RETRY_NOTE}"
echo "[$(date +%T)] lane $N done PR #$PRN"
rm -rf "$LK"; trap - EXIT

# hand over: merge lane now, refill idle lanes right after
nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null || true
nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null & disown 2>/dev/null || true
exit 0
