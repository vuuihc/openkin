#!/bin/bash
# test-record-merged.sh — a delivered PR is recorded in $STATE/merged.log exactly once.
#
# Measured 2026-11-28 07:58 (followup 2219): DREAM merged its docs PR #847 (a39b5e72) at
# 07:53 and merged.log never got a row; the CEO patrol appended one by hand to restore
# merged_today=14. merge.sh was the only writer, and DREAM ran `gh pr merge` itself, so the
# one line that counts deliveries was skipped. record-merged.sh is now the one writer both
# paths call; a second record for the same PR is a no-op, so a retried merge cannot double
# count. lanes.py merged_rows() parses the format and followups-lint.py indexes `#N` from it:
#
#   YYYY-MM-DD HH:MM PR #N <slug> <item> merged <first 8 of sha> <url>
#
# Hermetic: mktemp state dirs, a fake gh that fails if called, no network, no real
# rsi/state. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case id> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
RECORDER="$RUNTIME/record-merged.sh"
MERGE="$RUNTIME/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
rc=0; O=""; E=""
ok() { echo "PASS record-merged: $*"; }
bad() { echo "FAIL record-merged: $*" >&2; exit 1; }
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }

# --- stubs -----------------------------------------------------------------------------------
# The recorder is a pure append: it must never reach the network or gh. A gh on PATH that
# fails loudly turns any call into a named failure instead of a silent real request.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'SH'
#!/bin/sh
echo "gh was called by record-merged.sh" >&2
exit 1
SH
chmod +x "$T/bin/gh"

# record <state> [args...] — run the recorder, capture rc (never abort) and stdout/stderr.
record() {
  local st="$1"; shift
  PATH="$T/bin:$PATH" bash "$RECORDER" --state "$st" "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# lines <file> — line count, 0 when the file does not exist yet.
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
# url <pr> — a GitHub pull request url for a fake repo.
url() { printf 'https://github.com/example/repo/pull/%s' "$1"; }

# --- one-line --------------------------------------------------------------------------------
# A PR merged outside the merge lane (a model running its own `gh pr merge`) records exactly
# one row, in the format lanes.py parses: date, time, `PR #N`, slug, item, `merged`, sha8, url.
if run_case one-line; then
  ST="$T/s1"; mkdir -p "$ST"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "one-line: recorder exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "one-line: expected exactly 1 line, got $(lines "$ST/merged.log"): $(cat "$ST/merged.log" 2>/dev/null)"
  LC_ALL=C grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} PR #900 dream-2026-11-28 R-dream-2026-11-28 merged abc1234d https://github\.com/' "$ST/merged.log" \
    || bad "one-line: row does not match the merge.sh format: $(cat "$ST/merged.log")"
  ok "an externally merged PR appends exactly one line"
fi

# --- second-is-a-noop ------------------------------------------------------------------------
# A retried merge (the lane re-runs after a crash, or two paths both record) must not count
# the same PR twice: exit 0, say so, write nothing.
if run_case second-is-a-noop; then
  ST="$T/s2"; mkdir -p "$ST"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "second-is-a-noop: first record exited $rc ($E)"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "second-is-a-noop: second record exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 1 ] \
    || bad "second-is-a-noop: a second record appended a line ($(lines "$ST/merged.log") rows)"
  grep -q 'already recorded #900' <<<"$O" \
    || bad "second-is-a-noop: expected 'already recorded #900' on stdout, got: $O"
  ok "a second record for the same PR writes nothing"
fi

# --- whole-token -----------------------------------------------------------------------------
# Only a whole `#N` token is a hit (the rule followups-lint.py applies to this file): an
# existing #90 must not swallow #900, and an existing #900 must not swallow #90. A substring
# match fails one of the two directions whichever way it is written.
if run_case whole-token; then
  ST="$T/s3"; mkdir -p "$ST"
  printf '2026-11-27 09:00 PR #90 old-slug R-old merged deadbeef %s\n' "$(url 90)" >> "$ST/merged.log"
  record "$ST" --pr 900 --slug dream-2026-11-28 --item R-dream-2026-11-28 \
    --sha abc1234def --url "$(url 900)"
  [ "$rc" -eq 0 ] || bad "whole-token: recording #900 exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 2 ] \
    || bad "whole-token: #900 was swallowed by the existing #90 row"
  ST="$T/s3b"; mkdir -p "$ST"
  printf '2026-11-27 09:01 PR #900 new-slug R-new merged deadbeef %s\n' "$(url 900)" >> "$ST/merged.log"
  record "$ST" --pr 90 --slug old-slug --item R-old --sha deadbeef01 --url "$(url 90)"
  [ "$rc" -eq 0 ] || bad "whole-token: recording #90 exited $rc ($E)"
  [ "$(lines "$ST/merged.log")" = 2 ] \
    || bad "whole-token: #90 matched inside the existing #900 row (a substring match)"
  ok "#90 does not swallow #900"
fi

# --- no-commit-refused -----------------------------------------------------------------------
# A "delivered" row without a commit and a GitHub url is not evidence; the old writer recorded
# `?` when `gh pr view` failed. Every refusal exits non-zero, names the flag, and writes nothing.
if run_case no-commit-refused; then
  ST="$T/s4"; mkdir -p "$ST"
  record "$ST" --pr 901 --slug s --item R-x --sha "" --url "$(url 901)"
  [ "$rc" -ne 0 ] || bad "no-commit-refused: an empty --sha was accepted"
  grep -q -- '--sha' <<<"$E" || bad "no-commit-refused: the refusal does not name --sha: $E"
  record "$ST" --pr 901 --slug s --item R-x --sha '?' --url "$(url 901)"
  [ "$rc" -ne 0 ] || bad "no-commit-refused: a '?' sha was accepted"
  record "$ST" --pr 902 --slug s --item R-x --sha abc1234def --url 'https://example.com/pull/902'
  [ "$rc" -ne 0 ] || bad "no-commit-refused: a non-GitHub url was accepted"
  grep -q -- '--url' <<<"$E" || bad "no-commit-refused: the refusal does not name --url: $E"
  [ "$(lines "$ST/merged.log")" = 0 ] \
    || bad "no-commit-refused: a refused record wrote a line: $(cat "$ST/merged.log")"
  ok "a record with no commit is refused"
fi

# --- merge-sh-wiring -------------------------------------------------------------------------
# One writer, not two: the merge lane names the helper and no longer appends merged.log itself
# (the same source-level shape test-wiring.sh uses for the gate's own wiring).
if run_case merge-sh-wiring; then
  grep -q 'record-merged\.sh' "$MERGE" \
    || bad "merge-sh-wiring: merge.sh does not call record-merged.sh"
  if grep -Eq '>>[[:space:]]*"\$STATE/merged\.log"' "$MERGE"; then
    bad "merge-sh-wiring: merge.sh still appends merged.log itself"
  fi
  ok "merge.sh records through the same helper"
fi

[ -z "$ONLY" ] || grep -qx "$ONLY" <<<"one-line
second-is-a-noop
whole-token
no-commit-refused
merge-sh-wiring" || bad "RSI_TEST_ONLY='$ONLY' matched no case"

echo "test-record-merged: ALL-PASS"
