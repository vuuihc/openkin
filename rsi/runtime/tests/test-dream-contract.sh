#!/bin/bash
# test-dream-contract.sh — the nightly DREAM report must carry the phone-performance line.
#
# Ethan's standing assignment (2026-11-21) is that the morning report names the phone
# numbers every night until the watch is marked verified. The prompt and the role card
# are the only files a DREAM run reads, so the obligation has to live there: a report
# can otherwise omit the line while the loop's own notes claim it is reported.
#
# The two numbers' sources are committed baselines, not a fresh measurement:
#   docs/plans/2026-11-21-phone-console-baseline.md      startup warm / cold / phone-weak
#   docs/plans/2026-11-21-phone-performance-baseline.md  interaction scroll p50 / tap p50
# The contract therefore requires reading those files, printing their measurement date,
# and an explicit `phone: unmeasured (<reason>)` when a doc or a number is absent — a
# guessed number is worse than an admitted gap.
#
# Hermetic: reads only the two committed Markdown files, no temp tree, no network, no
# model calls. npm/go/node/curl are booby traps: composing a report contract must not
# need a package manager, a toolchain or the network. Prints "PASS <case>" per case and
# exits non-zero on the first failure. Set RSI_TEST_ONLY=<case> to run one case (used
# to show the red run before the prompt edit).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PROMPT="$ROOT/rsi/runtime/prompts/dream.md"
ROLE="$ROOT/rsi/roles/dream.md"
CONSOLE_DOC="$ROOT/docs/plans/2026-11-21-phone-console-baseline.md"
PERF_DOC="$ROOT/docs/plans/2026-11-21-phone-performance-baseline.md"
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }

# Booby traps: a report contract is prose plus grep; it must run without these.
npm() { exit 97; }; go() { exit 97; }; node() { exit 97; }; curl() { exit 97; }
export -f npm go node curl

# has <file> <literal> <message> — require <literal> to appear in <file>.
has() { grep -Fq -- "$2" "$1" || bad "$3"; }

test_phone_line_contract() {
  [ -f "$PROMPT" ] || bad "phone-line-contract: no such file: $PROMPT"
  [ -f "$ROLE" ] || bad "phone-line-contract: no such file: $ROLE"

  # The report line exists and names both baselines it is read from.
  has "$PROMPT" "phone:" "phone-line-contract: dream.md has no 'phone:' report line"
  has "$PROMPT" "docs/plans/2026-11-21-phone-console-baseline.md" \
    "phone-line-contract: dream.md does not name the startup baseline doc"
  has "$PROMPT" "docs/plans/2026-11-21-phone-performance-baseline.md" \
    "phone-line-contract: dream.md does not name the interaction baseline doc"

  # The numbers come from those files, not from the model.
  has "$PROMPT" "Copy the numbers from those files" \
    "phone-line-contract: dream.md does not order the numbers to be copied from the docs"
  has "$PROMPT" "never computed or guessed" \
    "phone-line-contract: dream.md does not forbid computing or guessing a number"

  # Every required field is named, grouped by the doc that holds it.
  has "$PROMPT" "startup: warm, cold, phone-weak" \
    "phone-line-contract: dream.md does not name startup warm, cold and phone-weak"
  has "$PROMPT" "interaction: scroll p50, tap p50" \
    "phone-line-contract: dream.md does not name interaction scroll p50 and tap p50"

  # The numbers are dated: a stale read is visible, not silent.
  has "$PROMPT" "measurement date" \
    "phone-line-contract: dream.md does not require the measurement date next to the numbers"

  # A missing source is admitted, never filled in.
  has "$PROMPT" "phone: unmeasured (<reason>)" \
    "phone-line-contract: dream.md has no 'phone: unmeasured (<reason>)' path"
  has "$PROMPT" "never invent a number" \
    "phone-line-contract: dream.md does not forbid inventing a number"

  # The role card's ⑦ 数据 bullet carries the same obligation in one line.
  local line
  line="$(grep -F '⑦ 数据' "$ROLE")" \
    || bad "phone-line-contract: roles/dream.md has no ⑦ 数据 bullet"
  [ -n "$line" ] || bad "phone-line-contract: the ⑦ 数据 bullet is empty"
  grep -Fq -- "phone:" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet does not mention the phone: line"
  grep -Fq -- "docs/plans/2026-11-21-phone-console-baseline.md" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet does not name the startup baseline doc"
  grep -Fq -- "docs/plans/2026-11-21-phone-performance-baseline.md" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet does not name the interaction baseline doc"
  grep -Fq -- "measurement date" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet does not require the measurement date"
  grep -Fq -- "phone: unmeasured (<reason>)" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet has no unmeasured path"
  grep -Fq -- "never invent a number" <<<"$line" \
    || bad "phone-line-contract: the ⑦ 数据 bullet does not forbid inventing a number"
}

# The prompt's source paths must be real files: a renamed baseline would otherwise
# turn the line into a silent `unmeasured` every morning.
test_phone_line_sources_exist() {
  [ -s "$CONSOLE_DOC" ] || bad "phone-line-sources-exist: missing or empty: docs/plans/2026-11-21-phone-console-baseline.md"
  [ -s "$PERF_DOC" ] || bad "phone-line-sources-exist: missing or empty: docs/plans/2026-11-21-phone-performance-baseline.md"
  has "$CONSOLE_DOC" "warm" "phone-line-sources-exist: startup doc has no warm row"
  has "$CONSOLE_DOC" "cold" "phone-line-sources-exist: startup doc has no cold row"
  has "$CONSOLE_DOC" "phone-weak" "phone-line-sources-exist: startup doc has no phone-weak row"
  has "$PERF_DOC" "127 ms" "phone-line-sources-exist: interaction doc has no tap p50 127 ms"
  has "$PERF_DOC" "7.4 %" "phone-line-sources-exist: interaction doc has no list scroll dropped 7.4 %"
}

run() { # <case> <fn>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$2" || exit 1
  ok "$1"
}

RAN=0
run phone-line-contract test_phone_line_contract
run phone-line-sources-exist test_phone_line_sources_exist
[ "$RAN" -gt 0 ] || bad "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
