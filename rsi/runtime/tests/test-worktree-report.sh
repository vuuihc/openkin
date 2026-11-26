#!/bin/bash
# test-worktree-report.sh — the loop must be able to read its own worktree pile.
#
# `~/.kin/worktrees` held 576 GB and 515 worktrees on 2026-11-22 while the disk sat at 96 %;
# `du -sh` over it took over ten minutes, so nobody could say in bounded time which worktrees
# were safe to clear. worktree-report.py is a read-only answer: merged into origin/main, clean,
# not claimed by a live lane, not the current worktree, older than --min-age-days. It deletes
# nothing, and a fact it cannot read is `unknown`, never 0.
#
# Hermetic: a throwaway git repo with linked worktrees, a temp lane-state dir, a `du` stub on
# PATH for the deadline case, no network, no writes outside the temp dir. Prints "PASS <case>"
# per case and exits non-zero on the first failure. Set RSI_TEST_ONLY=<case> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
TOOL="$RSI/runtime/worktree-report.py"
T="$(mktemp -d)"
ONLY="${RSI_TEST_ONLY:-}"
F="$T/fixture"          # the snapshot root: everything the tool may read
R="$F/repo"             # the fixture repo the worktrees belong to
W="$F/wts"              # linked worktrees
S="$F/state"            # lane state
IO="$T/io"              # tool output and PATH stubs (outside the snapshot)
OLD="2020-01-01T00:00:00 +0000"

cleanup() {
  chmod -R u+rwX "$T" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

mkdir -p "$W" "$S/lanes" "$IO"
command -v git >/dev/null 2>&1 || fail "git is required"

# write_lane <slug> — a live running lane, pid = this test shell.
write_lane() {
  printf '{"lane": 1, "slug": "%s", "status": "running", "pid": %s}\n' "$1" "$$" \
    > "$S/lanes/1.json"
}

# --- fixture: one merged-clean-old rsi worktree, and one row per disqualifier -------------------
setup() {
  git init -q "$R" || fail "setup: git init"
  git -C "$R" config user.email owner@example.com
  git -C "$R" config user.name Fixture
  git -C "$R" config commit.gpgsign false
  printf 'state/\n' > "$R/.gitignore"
  git -C "$R" add .gitignore
  GIT_AUTHOR_DATE="$OLD" GIT_COMMITTER_DATE="$OLD" \
    git -C "$R" commit -q -m base || fail "setup: base commit"
  git -C "$R" update-ref refs/remotes/origin/main HEAD || fail "setup: origin/main"

  # merged, clean, unclaimed, old: the one reclaimable row
  git -C "$R" worktree add -q -b rsi/merged-old "$W/merged-old" origin/main \
    || fail "setup: merged-old"
  # one old commit that never reached origin/main; old so that a merged PR line is the
  # only fact standing between this worktree and `reclaimable`.
  git -C "$R" worktree add -q -b rsi/unmerged "$W/unmerged" origin/main || fail "setup: unmerged"
  ( cd "$W/unmerged" && echo x > x.txt && git add x.txt \
      && GIT_AUTHOR_DATE="$OLD" GIT_COMMITTER_DATE="$OLD" git commit -qm unmerged ) \
    || fail "setup: unmerged commit"
  # merged and old, but an untracked file
  git -C "$R" worktree add -q -b rsi/dirty "$W/dirty" origin/main || fail "setup: dirty"
  echo scratch > "$W/dirty/scratch.txt"
  # merged, clean, old, but a live lane names its slug
  git -C "$R" worktree add -q -b rsi/claimed-slug "$W/claimed" origin/main || fail "setup: claimed"
  # merged and clean, but its directory is gone (a corrupt entry; case 5 relies on this)
  git -C "$R" worktree add -q -b rsi/unreadable "$W/unreadable" origin/main || fail "setup: unreadable"
  rm -rf "$W/unreadable"
  # never the loop's to judge
  git -C "$R" worktree add -q -b 'kin/task/node-<node-id>/g1' "$W/kin-task" origin/main \
    || fail "setup: kin task"
  git -C "$R" worktree add -q -b feature/notes "$W/feature" origin/main || fail "setup: feature"
  # merged, clean and old, but locked
  git -C "$R" worktree add -q -b rsi/locked-clean "$W/locked" origin/main || fail "setup: locked"
  git -C "$R" worktree lock "$W/locked" || fail "setup: worktree lock"
  # detached: reported, never offered
  git -C "$R" worktree add -q --detach "$W/detached-row" origin/main || fail "setup: detached"

  # Baseline: the claimed row is held by a live lane and the unreadable row cannot be read,
  # so only merged-old is reclaimable until a case deliberately changes one of those facts.
  # The lanes directory also holds per-lane artifacts (`<slug>.mutants.json`); they are not
  # lane state and must not make the claim check unknown.
  write_lane claimed-slug
  printf '[]\n' > "$S/lanes/unrelated.mutants.json"
}
setup

# run [args...] — --json into $IO/out.json, stderr into $IO/err.txt, exit code in $rc.
run() {
  ( cd "$IO" && python3 "$TOOL" --repo "$R" --state "$S" --json "$@" ) \
    >"$IO/out.json" 2>"$IO/err.txt"
  rc=$?
}
run_human() {
  ( cd "$IO" && python3 "$TOOL" --repo "$R" --state "$S" "$@" ) >"$IO/out.txt" 2>"$IO/err.txt"
  rc=$?
}
run_from() { # run_from <dir> [args...] — the tool's current worktree is <dir>
  local d="$1"; shift
  ( cd "$d" && python3 "$TOOL" --repo "$R" --state "$S" --json "$@" ) \
    >"$IO/out.json" 2>"$IO/err.txt"
  rc=$?
}
run_default() { # no --state and no $RSI_STATE/$STATE: the repo-local fallback
  ( cd "$IO" && env -u RSI_STATE -u STATE python3 "$TOOL" --repo "$R" --json "$@" ) \
    >"$IO/out.json" 2>"$IO/err.txt"
  rc=$?
}

# field <worktree basename> <key> — the JSON value, "unknown" when null.
field() {
  python3 - "$IO/out.json" "$1" "$2" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
want = sys.argv[2]
for w in d["worktrees"]:
    if os.path.basename(w["path"].rstrip("/")) == want:
        v = w.get(sys.argv[3])
        print("unknown" if v is None else ("true" if v is True else ("false" if v is False else v)))
        raise SystemExit(0)
print("MISSING-ROW")
PY
}
# total <key> — a totals value, "unknown" when null.
total() {
  python3 - "$IO/out.json" "$1" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))["totals"].get(sys.argv[2])
print("unknown" if v is None else ("true" if v is True else ("false" if v is False else v)))
PY
}
# has_reason <worktree basename> <substring>
has_reason() {
  local why
  why="$(field "$1" reason)"
  case "$why" in
    *"$2"*) return 0 ;;
    *) echo "reason for $1 was '$why', wanted '$2'" >&2; return 1 ;;
  esac
}

# snapshot <dir> — sorted type/path/hash lines for every entry under the fixture.
snapshot() {
  python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort(); filenames.sort()
    for d in dirnames:
        print("d", os.path.relpath(os.path.join(dirpath, d), root))
    for f in filenames:
        p = os.path.join(dirpath, f)
        print("f", os.path.relpath(p, root), hashlib.sha256(open(p, "rb").read()).hexdigest())
PY
}

# --- 1. merged, clean, unclaimed and old is the only reclaimable row ---------------------------
case_merged_clean_unclaimed_is_reclaimable() {
  want merged-clean-unclaimed-is-reclaimable || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "reclaimable: rc=$rc ($(cat "$IO/err.txt"))"
  [ "$(field merged-old merged)" = true ] || fail "reclaimable: merged=$(field merged-old merged)"
  [ "$(field merged-old dirty)" = false ] || fail "reclaimable: dirty=$(field merged-old dirty)"
  [ "$(field merged-old claimed)" = false ] || fail "reclaimable: claimed=$(field merged-old claimed)"
  [ "$(field merged-old reclaimable)" = true ] \
    || fail "reclaimable: row says no (reason=$(field merged-old reason))"
  [ "$(field merged-old bytes)" != unknown ] || fail "reclaimable: size not measured"
  [ "$(field merged-old bytes)" -gt 0 ] || fail "reclaimable: size $(field merged-old bytes)"
  [ "$(total reclaimable_count)" = 1 ] || fail "reclaimable: total $(total reclaimable_count)"
  [ "$(total worktrees)" = 10 ] || fail "reclaimable: worktrees $(total worktrees)"
  [ "$(total rsi_worktrees)" = 6 ] || fail "reclaimable: rsi_worktrees $(total rsi_worktrees)"

  # The age threshold is a fact, not a constant: at 100000 days the same row is too young.
  run --min-age-days 100000
  [ "$(field merged-old reclaimable)" = false ] \
    || fail "reclaimable: old row survived a 100000-day threshold"
  has_reason merged-old young || fail "reclaimable: no too-young reason"

  # The worktree the tool runs in is never offered, even when every other fact says yes.
  run_from "$W/merged-old" --min-age-days 1
  [ "$rc" -eq 0 ] || fail "reclaimable: run_from rc=$rc"
  [ "$(field merged-old reclaimable)" = false ] || fail "reclaimable: current worktree offered"
  has_reason merged-old current || fail "reclaimable: no current reason"
  [ "$(total reclaimable_count)" = 0 ] || fail "reclaimable: current counted"

  # A locked worktree is never offered, even when every other fact says yes.
  [ "$(field locked locked)" = true ] || fail "reclaimable: locked row not parsed"
  [ "$(field locked reclaimable)" = false ] || fail "reclaimable: locked row offered"
  has_reason locked locked || fail "reclaimable: no locked reason"

  # The worktree holding the state dir is the control tree: its ignored rsi/state would be
  # deleted with it, so it is never offered even when it is merged, clean and old.
  mkdir -p "$W/merged-old/state/lanes"
  ( cd "$IO" && python3 "$TOOL" --repo "$R" --state "$W/merged-old/state" --json \
      --min-age-days 1 ) >"$IO/out.json" 2>"$IO/err.txt"
  rc=$?
  [ "$rc" -eq 0 ] || fail "reclaimable: control rc=$rc"
  [ "$(field merged-old dirty)" = false ] || fail "reclaimable: control fixture is dirty"
  [ "$(field merged-old reclaimable)" = false ] || fail "reclaimable: control tree offered"
  has_reason merged-old control || fail "reclaimable: no control reason"
  rm -rf "$W/merged-old/state"

  run_human --min-age-days 1
  [ "$rc" -eq 0 ] || fail "reclaimable: human rc=$rc"
  grep -q 'reclaimable: 1' "$IO/out.txt" || fail "reclaimable: no human summary ($(tail -3 "$IO/out.txt"))"
  pass merged-clean-unclaimed-is-reclaimable
}

# --- 2. an unmerged branch is reported, never offered ------------------------------------------
case_unmerged_is_not_reclaimable() {
  want unmerged-is-not-reclaimable || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "unmerged: rc=$rc"
  [ "$(field unmerged merged)" = false ] || fail "unmerged: merged=$(field unmerged merged)"
  [ "$(field unmerged reclaimable)" = false ] || fail "unmerged: row says reclaimable"
  has_reason unmerged unmerged || fail "unmerged: no unmerged reason"
  pass unmerged-is-not-reclaimable
}

# --- 3. an untracked file makes a merged worktree unsafe to clear ------------------------------
case_dirty_is_not_reclaimable() {
  want dirty-is-not-reclaimable || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "dirty: rc=$rc"
  [ "$(field dirty merged)" = true ] || fail "dirty: fixture is not merged"
  [ "$(field dirty dirty)" = true ] || fail "dirty: dirty=$(field dirty dirty)"
  [ "$(field dirty reclaimable)" = false ] || fail "dirty: row says reclaimable"
  has_reason dirty dirty || fail "dirty: no dirty reason"
  pass dirty-is-not-reclaimable
}

# --- 4. a live lane holds a worktree; an unparseable lane file means claimed=unknown -----------
case_claimed_lane_is_not_reclaimable() {
  want claimed-lane-is-not-reclaimable || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "claimed: rc=$rc"
  [ "$(field claimed claimed)" = true ] || fail "claimed: claimed=$(field claimed claimed)"
  [ "$(field claimed reclaimable)" = false ] || fail "claimed: row says reclaimable"
  has_reason claimed claimed || fail "claimed: no claimed reason"

  # A lane fixture that cannot be parsed is unknown, and unknown excludes the row too.
  printf '{not json\n' > "$S/lanes/1.json"
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "claimed: corrupt lane rc=$rc"
  [ "$(field claimed claimed)" = unknown ] || fail "claimed: corrupt lane claimed=$(field claimed claimed)"
  [ "$(field claimed reclaimable)" = false ] || fail "claimed: corrupt lane row reclaimable"
  has_reason claimed "claimed unknown" || fail "claimed: no unknown reason"
  [ "$(total reclaimable_count)" = 0 ] || fail "claimed: unknown claim still counted"

  # An empty lanes dir in a lane's own unused state must not read as "no claims".
  mkdir -p "$R/rsi/state/lanes"
  run_default --min-age-days 1
  [ "$rc" -eq 0 ] || fail "claimed: default rc=$rc"
  [ "$(field merged-old claimed)" = unknown ] \
    || fail "claimed: empty default state trusted ($(field merged-old claimed))"
  [ "$(total active_lanes)" = unknown ] || fail "claimed: empty default state counted"
  [ "$(total reclaimable_count)" = 0 ] || fail "claimed: empty default state offered rows"
  rm -rf "$R/rsi/state"

  write_lane claimed-slug
  pass claimed-lane-is-not-reclaimable
}

# --- 5. an unreadable worktree is unknown, never 0, and the rest of the report survives --------
case_unreadable_reports_unknown_not_zero() {
  want unreadable-reports-unknown-not-zero || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "unreadable: rc=$rc"
  [ "$(field unreadable dirty)" = unknown ] || fail "unreadable: dirty=$(field unreadable dirty)"
  [ "$(field unreadable bytes)" = unknown ] || fail "unreadable: bytes=$(field unreadable bytes)"
  [ "$(field unreadable reclaimable)" = false ] || fail "unreadable: row says reclaimable"
  [ "$(total worktrees)" = 10 ] || fail "unreadable: other rows lost ($(total worktrees))"
  [ "$(field merged-old reclaimable)" = true ] || fail "unreadable: healthy row changed"
  run_human --min-age-days 1
  grep -q 'unknown' "$IO/out.txt" || fail "unreadable: human output never says unknown"
  pass unreadable-reports-unknown-not-zero
}

# --- 6. a report is not an editor: two JSON runs and one human run change no byte --------------
case_never_deletes() {
  want never-deletes || return 0
  local before after
  before="$(snapshot "$F")"
  run --min-age-days 1
  run --min-age-days 1
  run_human --min-age-days 1
  after="$(snapshot "$F")"
  [ "$before" = "$after" ] || fail "never-deletes: the fixture tree changed"

  # And the source has no deletion path at all, including an option a user could reach.
  if grep -nE 'worktree[[:space:]]+(remove|prune)|branch[[:space:]]+-D|rm[[:space:]]+-rf|--delete' "$TOOL"; then
    fail "never-deletes: source mentions a destructive invocation"
  fi
  if grep -nE '^[[:space:]]*(import[[:space:]]+lanes|from[[:space:]]+lanes)' "$TOOL"; then
    fail "never-deletes: the tool imports lanes.py, which writes state"
  fi
  if python3 "$TOOL" --help 2>&1 | grep -q -- '--delete'; then
    fail "never-deletes: --help offers --delete"
  fi
  pass never-deletes
}

# --- 7. the size pass has a hard deadline and says how much it did not measure -----------------
case_size_pass_is_bounded() {
  want size-pass-is-bounded || return 0
  mkdir -p "$IO/bin"
  rm -f "$IO/du-pids"
  cat > "$IO/bin/du" <<EOF
#!/bin/bash
echo \$\$ >> "$IO/du-pids"
exec sleep 12345
EOF
  chmod +x "$IO/bin/du"
  local start elapsed
  start="$(date +%s)"
  ( cd "$IO" && PATH="$IO/bin:$PATH" python3 "$TOOL" --repo "$R" --state "$S" --json \
      --size-timeout 1 ) >"$IO/out.json" 2>"$IO/err.txt"
  rc=$?
  elapsed=$(( $(date +%s) - start ))
  [ "$rc" -eq 0 ] || fail "bounded: rc=$rc ($(cat "$IO/err.txt"))"
  [ "$elapsed" -le 5 ] || fail "bounded: took ${elapsed}s for a 1 s deadline"
  [ "$(field merged-old bytes)" = unknown ] || fail "bounded: bytes=$(field merged-old bytes)"
  [ "$(total worktrees)" = 10 ] || fail "bounded: rows lost"
  ( cd "$IO" && PATH="$IO/bin:$PATH" python3 "$TOOL" --repo "$R" --state "$S" \
      --size-timeout 1 ) >"$IO/out.txt" 2>"$IO/err.txt"
  [ "$?" -eq 0 ] || fail "bounded: human rc=$?"
  grep -q 'not measured' "$IO/out.txt" \
    || fail "bounded: no summary of unmeasured rows ($(tail -3 "$IO/out.txt"))"
  grep -q 'unknown' "$IO/out.txt" || fail "bounded: unmeasured rows not marked unknown"
  [ -s "$IO/du-pids" ] || fail "bounded: the du stub never ran"
  local pid tries
  tries=0
  while read -r pid; do
    while kill -0 "$pid" 2>/dev/null; do
      tries=$((tries + 1))
      [ "$tries" -lt 50 ] || fail "bounded: the deadline left du pid $pid running"
      sleep 0.1
    done
  done < "$IO/du-pids"
  pass size-pass-is-bounded
}

# --- 8. every git call honours its own bound, not a longer default -----------------------------
case_git_timeout_is_honoured() {
  want git-timeout-is-honoured || return 0
  mkdir -p "$IO/slowbin"
  printf '#!/bin/bash\nsleep 3\nexit 0\n' > "$IO/slowbin/git"
  chmod +x "$IO/slowbin/git"
  # Time the call in-process. A shell stopwatch around the whole python3 invocation
  # also counted interpreter startup and fork/exec, so a loaded gate machine read 4 s
  # for a 0.5 s bound (2026-11-26); the call itself is what must honour the bound.
  PATH="$IO/slowbin:$PATH" python3 - "$TOOL" <<'PY' || fail "git-timeout: the call did not honour 0.5 s"
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("worktree_report_under_test", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
started = time.monotonic()
result = mod.git("/tmp", "status", timeout=0.5)
elapsed = time.monotonic() - started
assert result is None, "git() returned a completed call despite the 0.5 s bound"
assert elapsed < 2, f"git() took {elapsed:.1f}s for a 0.5 s bound"
PY
  pass git-timeout-is-honoured
}

# --- 9. a merged PR line in the merge record is a second, checkable merge fact -----------------
# This repository lands every PR with a squash commit, so a merged branch's own commits are never
# ancestors of origin/main. The merge lane writes one line per landed PR to <state>/merged.log:
#     YYYY-MM-DD HH:MM PR #N <slug> <item> merged <sha> <url>
# A `merged` line for the slug is delivery evidence; anything else is not.
MERGED_LINE='2026-11-22 10:00 PR #999 unmerged R-fixture merged 0123456789abcdef https://github.com/example/example/pull/999'
case_merged_pr_log_is_reclaimable() {
  want merged-pr-log-is-reclaimable || return 0
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "pr-log: baseline rc=$rc"
  [ "$(field unmerged merged)" = false ] || fail "pr-log: baseline merged=$(field unmerged merged)"
  [ "$(field unmerged merged_by)" = unknown ] \
    || fail "pr-log: baseline merged_by=$(field unmerged merged_by)"
  [ "$(field unmerged reclaimable)" = false ] || fail "pr-log: baseline reclaimable"
  has_reason unmerged unmerged || fail "pr-log: baseline has no unmerged reason"
  local before after
  before="$(total reclaimable_count)"

  printf '%s\n' "$MERGED_LINE" > "$S/merged.log"
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "pr-log: merged rc=$rc ($(cat "$IO/err.txt"))"
  [ "$(field unmerged merged)" = true ] || fail "pr-log: merged=$(field unmerged merged)"
  [ "$(field unmerged merged_by)" = pr-log ] \
    || fail "pr-log: merged_by=$(field unmerged merged_by)"
  [ "$(field unmerged reclaimable)" = true ] \
    || fail "pr-log: not reclaimable (reason=$(field unmerged reason))"
  [ "$(field unmerged reason)" = unknown ] || fail "pr-log: reason=$(field unmerged reason)"
  after="$(total reclaimable_count)"
  [ "$after" -eq $((before + 1)) ] || fail "pr-log: count $before -> $after"
  rm -f "$S/merged.log"
  pass merged-pr-log-is-reclaimable
}

# --- 10. a status note is not a delivery record ------------------------------------------------
case_merged_pr_log_needs_the_word_merged() {
  want merged-pr-log-needs-the-word-merged || return 0
  {
    printf '%s\n' '2026-11-22 10:00 PR #999 unmerged R-fixture hold 0123456789abcdef https://github.com/example/example/pull/999'
    printf '%s\n' 'unmerged'
  } > "$S/merged.log"
  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "pr-log-status: rc=$rc"
  [ "$(field unmerged merged)" = false ] || fail "pr-log-status: merged=$(field unmerged merged)"
  [ "$(field unmerged merged_by)" = unknown ] \
    || fail "pr-log-status: merged_by=$(field unmerged merged_by)"
  [ "$(field unmerged reclaimable)" = false ] || fail "pr-log-status: row reclaimable"
  has_reason unmerged unmerged || fail "pr-log-status: no unmerged reason"
  rm -f "$S/merged.log"
  pass merged-pr-log-needs-the-word-merged
}

# --- 11. an unreadable merge record is not a fact: nothing is promoted by a read failure ------
case_merged_pr_log_unreadable_is_not_a_fact() {
  want merged-pr-log-unreadable-is-not-a-fact || return 0
  mkdir -p "$T/merged-dir"
  local log
  for log in "$T/does-not-exist.log" "$T/merged-dir"; do
    run --min-age-days 1 --merged-log "$log"
    [ "$rc" -eq 0 ] || fail "pr-log-unreadable: rc=$rc for $log ($(cat "$IO/err.txt"))"
    [ "$(field unmerged merged_by)" = unknown ] \
      || fail "pr-log-unreadable: merged_by=$(field unmerged merged_by) for $log"
    [ "$(field unmerged merged)" = false ] \
      || fail "pr-log-unreadable: merged=$(field unmerged merged) for $log"
    [ "$(field unmerged reclaimable)" = false ] || fail "pr-log-unreadable: row offered for $log"
    has_reason unmerged unmerged || fail "pr-log-unreadable: no unmerged reason for $log"
    # The ancestor fact is independent of the merge record and must survive the read failure.
    [ "$(field merged-old merged)" = true ] || fail "pr-log-unreadable: ancestor lost for $log"
    [ "$(field merged-old merged_by)" = ancestor ] \
      || fail "pr-log-unreadable: merged_by=$(field merged-old merged_by) for $log"
    [ "$(field merged-old reclaimable)" = true ] || fail "pr-log-unreadable: ancestor row lost"
  done
  run_human --min-age-days 1 --merged-log "$T/does-not-exist.log"
  [ "$rc" -eq 0 ] || fail "pr-log-unreadable: human rc=$rc"
  grep -q 'reclaimable: 1' "$IO/out.txt" \
    || fail "pr-log-unreadable: no summary ($(tail -3 "$IO/out.txt"))"
  pass merged-pr-log-unreadable-is-not-a-fact
}

# --- 12. the merge record never overrides a disqualifier ---------------------------------------
case_merged_pr_log_does_not_authorise_a_dirty_worktree() {
  want merged-pr-log-does-not-authorise-a-dirty-worktree || return 0
  {
    printf '%s\n' "$MERGED_LINE"
    printf '%s\n' '2026-11-22 10:00 PR #998 claimed-slug R-fixture merged 0123456789abcdef https://github.com/example/example/pull/998'
  } > "$S/merged.log"
  echo scratch > "$W/unmerged/scratch.txt"
  printf '{"lane": 2, "slug": "other-slug", "status": "running", "pid": %s}\n' "$$" \
    > "$S/lanes/2.json"

  run --min-age-days 1
  [ "$rc" -eq 0 ] || fail "pr-log-dirty: rc=$rc"
  [ "$(field unmerged merged)" = true ] || fail "pr-log-dirty: merged=$(field unmerged merged)"
  [ "$(field unmerged merged_by)" = pr-log ] \
    || fail "pr-log-dirty: merged_by=$(field unmerged merged_by)"
  [ "$(field unmerged dirty)" = true ] || fail "pr-log-dirty: dirty=$(field unmerged dirty)"
  [ "$(field unmerged reclaimable)" = false ] || fail "pr-log-dirty: dirty row offered"
  has_reason unmerged dirty || fail "pr-log-dirty: no dirty reason"
  [ "$(field claimed claimed)" = true ] || fail "pr-log-dirty: claim lost"
  [ "$(field claimed reclaimable)" = false ] || fail "pr-log-dirty: claimed row offered"
  has_reason claimed claimed || fail "pr-log-dirty: no claimed reason"

  rm -f "$S/merged.log" "$S/lanes/2.json" "$W/unmerged/scratch.txt"
  pass merged-pr-log-does-not-authorise-a-dirty-worktree
}

for c in merged-clean-unclaimed-is-reclaimable unmerged-is-not-reclaimable \
         dirty-is-not-reclaimable claimed-lane-is-not-reclaimable \
         unreadable-reports-unknown-not-zero never-deletes size-pass-is-bounded \
         git-timeout-is-honoured merged-pr-log-is-reclaimable \
         merged-pr-log-needs-the-word-merged merged-pr-log-unreadable-is-not-a-fact \
         merged-pr-log-does-not-authorise-a-dirty-worktree; do
  "case_${c//-/_}"
done
echo "PASS all"
