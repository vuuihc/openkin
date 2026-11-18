#!/bin/bash
# test-reviewer-misses.sh — the reviewer-miss ledger is readable evidence: it parses
# merged.log, turns a revert on origin/main into a miss named by the scorecard, counts a
# GitHub-reopened PR only when the merge lane actually landed it, survives a failing gh,
# and writes only under RSI_STATE. It is evidence for reviewer routing, not a gate.
#
# Hermetic: temp dirs, a stub `gh` first on PATH, temp git repos for RSI_CTRL, no network,
# no real state. Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/reviewer-misses.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
STUB="$T/bin"; mkdir -p "$STUB"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# --- stub gh -----------------------------------------------------------------------------------
# The ledger's only network call. Each case states the mode it wants; any mode other than
# "ok" must not be able to influence the report.
cat > "$STUB/gh" <<'SH'
#!/bin/bash
[ -n "${STUB_GH_LOG:-}" ] && printf '%s\n' "$*" >> "$STUB_GH_LOG"
[ "${STUB_GH_MODE:-fail}" = ok ] || exit 1
printf '%s\n' "${STUB_GH_JSON:-[]}"
SH
chmod +x "$STUB/gh"

# GH_JSON is the stub's answer for the reopened scan; cases that do not set it get none.
GH_JSON='[]'
# GH_REPO names the repo for gh. Empty means "derive it from the origin remote"; a case
# that does that records the stub's argv in GH_LOG to prove what slug was used.
GH_REPO='example/repo'
GH_LOG=''

# run_ledger <state> <ctrl> <gh-mode> [args...] — stdout only, so callers can compare it.
run_ledger() {
  local state="$1" ctrl="$2" mode="$3"; shift 3
  PATH="$STUB:$PATH" \
  RSI_STATE="$state" RSI_CTRL="$ctrl" RSI_GH_REPO="${GH_REPO-example/repo}" \
  STUB_GH_MODE="$mode" STUB_GH_JSON="$GH_JSON" STUB_GH_LOG="$GH_LOG" \
    python3 "$SCRIPT" "$@"
}

# merged_fixture <state dir> — the merge lane's log, two RSI PRs. The URL host is a
# placeholder: fixtures must never carry real infrastructure.
merged_fixture() {
  mkdir -p "$1"
  cat > "$1/merged.log" <<'EOF'
2026-11-15 10:36 PR #65 merge-pipeline R-merge-pipeline merged 31b82cb1 https://github.com/example/repo/pull/65
2026-11-15 11:02 PR #66 review-ledger R-reviewer-ledger merged 0a1b2c3d https://github.com/example/repo/pull/66
EOF
}

# make_repo <dir> — a temp repo whose origin/main is its base commit, fixed identity.
make_repo() {
  local d="$1"
  mkdir -p "$d"
  git -C "$d" init -q -b main || fail "git init failed: $d"
  git -C "$d" config user.name tester
  git -C "$d" config user.email owner@example.com
  git -C "$d" config commit.gpgsign false
  git -C "$d" commit -q --allow-empty -m "chore: base"
  git -C "$d" update-ref refs/remotes/origin/main HEAD
}

# revert_commit <repo> <number parenthetical> — what `git revert` writes for a landed PR.
revert_commit() {
  git -C "$1" commit -q --allow-empty -m "Revert \"feat(x): thing $2\""
  git -C "$1" update-ref refs/remotes/origin/main HEAD
}

# --- cases -------------------------------------------------------------------------------------

case_self_test() {
  local out
  out="$(python3 "$SCRIPT" --self-test)" || fail "self-test: exited non-zero"
  grep -q "self-test ok" <<<"$out" || fail "self-test: no ok line: $out"
  pass self-test
}

case_parses_merged_and_status() {
  local s="$T/parses/state" out
  merged_fixture "$s"
  make_repo "$T/parses/repo"
  out="$(run_ledger "$s" "$T/parses/repo" fail --status)" || fail "parses-merged: exited non-zero"
  [ "$out" = "reviewer misses: 0 (of 2 RSI-merged PRs in merged.log)" ] \
    || fail "parses-merged: status line was: $out"
  [ ! -e "$s/reviewer-misses.md" ] || fail "parses-merged: --status wrote a report; it is a read"
  pass parses-merged-and-status
}

case_revert_is_a_miss() {
  local s="$T/revert/state" r="$T/revert/repo" md
  merged_fixture "$s"
  make_repo "$r"
  # A pipe in the reverted subject must be escaped, not break the markdown table.
  git -C "$r" commit -q --allow-empty -m 'Revert "feat(x): a|b (#12)"'
  git -C "$r" update-ref refs/remotes/origin/main HEAD
  # #123's URL also contains the text `pull/12`; its later row must not be
  # attributed to #12's revert.
  cat > "$s/scorecard.md" <<'EOF'
| when | item | worker | reviewer | verdict | PR |
|---|---|---|---|---|---|
| 2026-11-15 11:02 | R-x | `alice` | `bob` | PASS | [#12](https://github.com/example/repo/pull/12) |
| 2026-11-15 12:00 | R-z | `carol` | `mallory` | PASS | [#123](https://github.com/example/repo/pull/123) |
EOF
  run_ledger "$s" "$r" fail --update >/dev/null || fail "revert: exited non-zero"
  md="$(cat "$s/reviewer-misses.md")"
  [ "$(grep -c '| revert |' <<<"$md")" = 1 ] || fail "revert: expected exactly one revert row: $md"
  grep -q '`bob`' <<<"$md" || fail "revert: reviewer not taken from the scorecard: $md"
  grep -q '`mallory`' <<<"$md" && fail "revert: #123's reviewer was attributed to #12: $md"
  grep -q '#12' <<<"$md" || fail "revert: reverted PR number missing: $md"
  grep -Fq 'a\|b' <<<"$md" || fail "revert: a pipe in the subject broke the table: $md"
  pass revert-is-a-miss
}

case_reopened_counts_only_after_a_merge() {
  local s="$T/reopened/state" r="$T/reopened/repo" md
  merged_fixture "$s"
  make_repo "$r"
  GH_JSON='[{"number":66,"title":"reopened after merge","url":"https://github.com/example/repo/pull/66","state":"OPEN","updatedAt":"2026-11-16T09:00:00Z"},{"number":99,"title":"never merged here","url":"https://github.com/example/repo/pull/99","state":"OPEN","updatedAt":"2026-11-16T10:00:00Z"}]'
  run_ledger "$s" "$r" ok --update >/dev/null || fail "reopened: exited non-zero"
  GH_JSON='[]'
  md="$(cat "$s/reviewer-misses.md")"
  grep -q '| reopened |' <<<"$md" || fail "reopened: no reopened row: $md"
  grep -q '#66' <<<"$md" || fail "reopened: merged PR #66 not counted: $md"
  grep -q '#99' <<<"$md" && fail "reopened: unmerged PR #99 was counted: $md"
  pass reopened-counts-only-after-a-merge
}

case_gh_failure_is_not_fatal() {
  local s="$T/ghfail/state" r="$T/ghfail/repo" md
  merged_fixture "$s"
  make_repo "$r"
  revert_commit "$r" '(#65)'
  run_ledger "$s" "$r" fail --update >/dev/null || fail "gh-failure: exited non-zero"
  [ -f "$s/reviewer-misses.md" ] || fail "gh-failure: no report written"
  md="$(cat "$s/reviewer-misses.md")"
  grep -q '| revert |' <<<"$md" || fail "gh-failure: git-based revert missing: $md"
  grep -q '#65' <<<"$md" || fail "gh-failure: merged PR #65 not in the report: $md"
  pass gh-failure-is-not-fatal
}

case_writes_only_under_state() {
  local s="$T/write/state" r="$T/write/repo" cwd="$T/write/cwd" n
  merged_fixture "$s"
  make_repo "$r"
  mkdir -p "$cwd"
  ( cd "$cwd" && PATH="$STUB:$PATH" \
      RSI_STATE="$s" RSI_CTRL="$r" RSI_GH_REPO="example/repo" \
      STUB_GH_MODE=fail STUB_GH_JSON='[]' STUB_GH_LOG='' \
      python3 "$SCRIPT" --update >/dev/null ) || fail "writes-only: exited non-zero"
  [ -z "$(git -C "$r" status --porcelain)" ] \
    || fail "writes-only: the repo tree changed: $(git -C "$r" status --porcelain)"
  [ -z "$(ls -A "$cwd")" ] || fail "writes-only: files appeared in the working directory"
  [ -f "$s/reviewer-misses.md" ] || fail "writes-only: no markdown report under RSI_STATE"
  [ -f "$s/reviewer-misses.json" ] || fail "writes-only: no json report under RSI_STATE"
  n="$(find "$s" -type f | wc -l | tr -d ' ')"
  [ "$n" = 3 ] || fail "writes-only: expected merged.log + 2 reports under RSI_STATE, found $n files"
  pass writes-only-under-state
}

# The slug is the ledger's one new derivation: a remote URL must reach gh as owner/name,
# and no remote must skip the scan instead of calling gh with an empty --repo.
case_slug_from_remote() {
  local s="$T/slug/state" r="$T/slug/repo" log="$T/slug/gh.log"
  merged_fixture "$s"
  make_repo "$r"
  git -C "$r" remote add origin https://github.com/example/repo.git
  GH_REPO='' GH_LOG="$log"
  run_ledger "$s" "$r" ok --update >/dev/null || fail "slug: exited non-zero"
  GH_REPO='example/repo' GH_LOG=''
  grep -q -- '--repo example/repo' "$log" 2>/dev/null \
    || fail "slug: gh was not called with the remote's owner/name: $(cat "$log" 2>/dev/null)"
  pass slug-from-remote
}

case_no_slug_skips_gh() {
  local s="$T/noslug/state" r="$T/noslug/repo" log="$T/noslug/gh.log"
  merged_fixture "$s"
  make_repo "$r"   # no origin remote
  GH_REPO='' GH_LOG="$log"
  run_ledger "$s" "$r" ok --update >/dev/null || fail "no-slug: exited non-zero"
  GH_REPO='example/repo' GH_LOG=''
  [ ! -s "$log" ] || fail "no-slug: gh was invoked without a repo slug: $(cat "$log")"
  pass no-slug-skips-gh
}

case_no_local_paths() {
  local bad
  # The public-repo rule: no home directories, no emails, no private network names.
  bad="$(grep -nE '/Users/|/home/|192\.168\.|trycloudflare|\.local\b|\.lan\b' "$SCRIPT" || true)"
  [ -z "$bad" ] || fail "no-local-paths: local path or host in the script: $bad"
  bad="$(grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$SCRIPT" || true)"
  [ -z "$bad" ] || fail "no-local-paths: email address in the script: $bad"
  # No absolute path baked into a string (state and repo dirs are derived or from env).
  bad="$(grep -nE '"/[A-Za-z]' "$SCRIPT" || true)"
  [ -z "$bad" ] || fail "no-local-paths: absolute path literal in the script: $bad"
  # The GitHub owner/name must come from the remote, never a literal in the source.
  bad="$(grep -nE 'github\.com/[A-Za-z0-9_-]+/' "$SCRIPT" || true)"
  [ -z "$bad" ] || fail "no-local-paths: hard-coded GitHub repo in the script: $bad"
  pass no-local-paths
}

case_self_test
case_parses_merged_and_status
case_revert_is_a_miss
case_reopened_counts_only_after_a_merge
case_gh_failure_is_not_fatal
case_slug_from_remote
case_no_slug_skips_gh
case_writes_only_under_state
case_no_local_paths
