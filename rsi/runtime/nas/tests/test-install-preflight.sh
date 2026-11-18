#!/bin/bash
# test-install-preflight.sh — hermetic guards for the two scripts an operator runs by hand
# against the NAS: install-nas.sh (the installer) and smoke-nas.sh (the lane smoke).
# No NAS, no network, no Docker and no Claude: ssh/docker/claude are fakes, "the NAS" is a temp
# tree the fake ssh reaches by running the command string locally, and $HOME points into the
# sandbox because install-nas.sh sources rsi/runtime/common.sh, which rebuilds PATH and keeps
# only $HOME/.local/bin from the caller's environment. The bare-clone step is answered with
# HAVE_BARE so the Mac-side git bundle fallback can never run.
# Run: bash rsi/runtime/nas/tests/test-install-preflight.sh
#      bash rsi/runtime/nas/tests/test-install-preflight.sh <function>   (one test; mutant runs)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NASDIR="$(cd "$HERE/.." && pwd)"
INSTALL="$NASDIR/install-nas.sh"
SMOKE="$NASDIR/smoke-nas.sh"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $*"; }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
finish() { echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; }

# A fixture key, not a real one: the installer must write it to disk and never echo it.
FAKE_KEY='sk-magpie-fake-fixture-not-a-real-key'

TMPDIRS=()
cleanup() { local d; for d in ${TMPDIRS[@]+"${TMPDIRS[@]}"}; do rm -rf "$d"; done; }
trap cleanup EXIT

mode_of() { python3 -c 'import os,sys;print("%o" % (os.stat(sys.argv[1]).st_mode & 0o777))' "$1"; }

# Every ssh invocation must be non-interactive. The discovery probe may add -n.
batchmode_only() { # LOG
  [ -s "$1" ] || return 1
  ! grep -qvE '^(-n )?-o BatchMode=yes ' "$1"
}

# --- sandbox -------------------------------------------------------------------------------------
sandbox() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/nas-preflight.XXXXXX")
  TMPDIRS+=("$T")
  mkdir -p "$T/home/.local/bin"
  : > "$T/ssh.log"; : > "$T/docker.log"; : > "$T/claude.log"
  : > "$T/usage.jsonl"        # empty magpie ledger: volc-budget.py must not shell out to magpie

  # Fake ssh: log the invocation as one line, then run the command string locally. Order matters:
  # the bare clone, the $HOME probe and the smoke's /proc banner are intercepts; build-up.sh is the
  # contract under test and is only logged; everything else (tar, cp, python3, docker) runs here.
  cat > "$T/home/.local/bin/ssh" <<'EOS'
#!/bin/bash
export PATH="$(dirname "$0"):$PATH"
{ printf '%s' "$*" | tr '\n' ' '; printf '\n'; } >> "${FAKE_SSH_LOG:?}"
n=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2; continue;;
    -n) n=1; shift; continue;;
    -*) shift; continue;;
    *) break;;
  esac
done
shift || true            # host
cmd="$*"
case "$cmd" in *openkin.git*) echo HAVE_BARE; exit 0;; esac
case "$cmd" in *"printf %s"*) printf '%s' "${FAKE_HOME-}"; exit 0;; esac
case "$cmd" in *loadavg*|*MemAvailable*) printf 'load=0.10 0.20 0.30\nMemAvailable_GB=12.34\n'; exit 0;; esac
case "$cmd" in *build-up.sh*) exit 0;; esac
if [ "$n" = 1 ]; then exec bash -c "$cmd" </dev/null; fi
exec bash -c "$cmd"
EOS

  # Fake docker: the magpie env is the fixture key; the auth probe answers FAKE_AUTH_OUT; the
  # claude exec reaches the fake claude. Everything else (image inspect, compose, inspect) is a
  # green no-op so the installer's tail runs to completion.
  cat > "$T/home/.local/bin/docker" <<'EOS'
#!/bin/bash
printf '%s\n' "$*" >> "${FAKE_DOCKER_LOG:?}"
case "$*" in "inspect magpie") cat "${FAKE_MAGPIE_JSON:?}"; exit 0;; esac
case "$*" in
  *auth-probe.py*) printf '%s\n' "${FAKE_AUTH_OUT-}"; exit 0;;
  *"claude -p"*) claude; exit $?;;
esac
exit 0
EOS

  cat > "$T/home/.local/bin/claude" <<'EOS'
#!/bin/bash
printf '%s\n' "$*" >> "${FAKE_CLAUDE_LOG:?}"
printf '%s\n' "${FAKE_CLAUDE_OUT-}"
EOS

  printf '[{"Config":{"Env":["MAGPIE_WEB_KEY=%s","PATH=/usr/bin"]}}]\n' "$FAKE_KEY" > "$T/magpie.json"
  chmod +x "$T/home/.local/bin/"*
}

run_install() { # T LOG [VAR=VAL ...] — stdout to LOG, stderr to LOG.err
  local T="$1" log="$2"; shift 2
  env HOME="$T/home" MAGPIE_USAGE_JSONL="$T/usage.jsonl" NAS_HOST=fake-nas \
      FAKE_SSH_LOG="$T/ssh.log" FAKE_DOCKER_LOG="$T/docker.log" \
      FAKE_MAGPIE_JSON="$T/magpie.json" FAKE_CLAUDE_LOG="$T/claude.log" \
      FAKE_HOME= NAS_REMOTE= FAKE_AUTH_OUT= FAKE_CLAUDE_OUT= \
      PATH="$T/home/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      "$@" bash "$INSTALL" > "$log" 2> "$log.err"
}

run_smoke() { # T LOG [VAR=VAL ...]
  local T="$1" log="$2"; shift 2
  env HOME="$T/home" NAS_HOST=fake-nas \
      FAKE_SSH_LOG="$T/ssh.log" FAKE_DOCKER_LOG="$T/docker.log" \
      FAKE_CLAUDE_LOG="$T/claude.log" \
      FAKE_AUTH_OUT= FAKE_CLAUDE_OUT= \
      PATH="$T/home/.local/bin:$PATH" \
      "$@" bash "$SMOKE" > "$log" 2> "$log.err"
}

# not_in_output LOG PATTERN — PATTERN is absent from both captured streams.
not_in_output() { ! cat "$1" "$1.err" 2>/dev/null | grep -qF -- "$2"; }

# --- 1: a lost $HOME discovery fails closed and asks for NAS_REMOTE (M1) -------------------------
# M1: install-nas.sh's guard `exit 1` -> `exit 0` -> this case goes red (the installer reports
# success when it has no root). Expressed this way, rather than deleting the guard, so the mutant
# cannot make the fake ssh attempt `mkdir -p /compose` on the host running the suite.
t_install_fails_closed_without_home() {
  local T; sandbox; T=$T
  local rc=0
  run_install "$T" "$T/out.log" NAS_REMOTE= || rc=$?
  check "M1 missing discovery exits 1" [ "$rc" = 1 ]
  check "M1 the failure names NAS_REMOTE on stderr" grep -q 'NAS_REMOTE' "$T/out.log.err"
  check "M1 only the probe ran" [ "$(wc -l < "$T/ssh.log" | tr -d ' ')" = 1 ]
  check "M1 no remote command ran" bash -c "! grep -Eq 'mkdir|tar |docker|build-up' '$T/ssh.log'"
}

# --- 2: an explicit NAS_REMOTE is honoured end to end (M7) ---------------------------------------
# M7: force the discovery probe even when NAS_REMOTE is set -> the probe appears in the log and the
# explicit root is lost, so this case goes red.
t_install_honours_remote_root() {
  local T; sandbox; T=$T
  local rc=0
  run_install "$T" "$T/out.log" NAS_REMOTE="$T/nas" || rc=$?
  check "M7 install exits 0" [ "$rc" = 0 ]
  check "M7 no discovery call when NAS_REMOTE is set" bash -c "! grep -q 'printf %s' '$T/ssh.log'"
  check "M7 the compose tree is copied" test -f "$T/nas/compose/build-up.sh"
  check "M7 the nas-side tree is copied" test -d "$T/nas/nas-side"
  check "M7 the secrets dir exists" test -d "$T/nas/secrets"
  check "M7 secrets is tightened to 700" [ "$(mode_of "$T/nas/secrets")" = 700 ]
  check "M7 the container settings are copied" cmp -s "$NASDIR/compose/claude-settings.json" \
    "$T/nas/work/home/.claude/settings.json"
  check "M7 the installer did call the NAS" grep -qE '^-o BatchMode=yes ' "$T/ssh.log"
  check "M7 every ssh call is BatchMode" batchmode_only "$T/ssh.log"
}

# --- 3: the extracted key lands in a 600 file and is never printed (M2, M3) ---------------------
# M2: the installer's final `chmod 600 .../magpie.key` -> 644 -> the mode assertions go red. (The
# heredoc's own chmod is re-tightened by that tail chmod, so it is not observable from outside.)
# M3: add `print(key)` in the heredoc -> the stdout/stderr scan goes red.
t_install_never_prints_the_key() {
  local T; sandbox; T=$T
  local rc=0
  run_install "$T" "$T/out.log" NAS_REMOTE="$T/nas" || rc=$?
  check "M2/M3 install exits 0" [ "$rc" = 0 ]
  check "M3 the key prefix is not printed" not_in_output "$T/out.log" 'sk-magpie'
  check "M3 the key itself is not printed" not_in_output "$T/out.log" "$FAKE_KEY"
  check "M3 the key guidance is printed" grep -q 'may not work as a gateway key' "$T/out.log"
  check "M2 the key file exists" test -f "$T/nas/secrets/magpie.key"
  check "M2 the key file is mode 600" [ "$(mode_of "$T/nas/secrets/magpie.key")" = 600 ]
  check "M2/M3 the key file holds exactly the key" python3 - "$T/nas/secrets/magpie.key" "$FAKE_KEY" <<'PY'
import sys
same = open(sys.argv[1], 'rb').read() == sys.argv[2].encode()
sys.exit(0 if same else 1)
PY

  # A key already on the NAS is kept byte for byte and only tightened to 600.
  local T2; sandbox; T2=$T
  mkdir -p "$T2/nas/secrets"
  printf 'preexisting-key-bytes\n' > "$T2/nas/secrets/magpie.key"
  printf 'preexisting-key-bytes\n' > "$T2/expected.key"
  chmod 640 "$T2/nas/secrets/magpie.key"
  rc=0; run_install "$T2" "$T2/out.log" NAS_REMOTE="$T2/nas" || rc=$?
  check "M2 the kept-key run exits 0" [ "$rc" = 0 ]
  check "M2 the pre-existing key is kept byte-identical" cmp -s "$T2/expected.key" "$T2/nas/secrets/magpie.key"
  check "M2 the pre-existing key is tightened to 600" [ "$(mode_of "$T2/nas/secrets/magpie.key")" = 600 ]
  check "M3 the kept key is announced without its value" grep -q 'magpie.key already present' "$T2/out.log"
}

# --- 4: the install root reaches build-up.sh, explicit and discovered (M4) ----------------------
# M4: drop `KIN_RSI_NAS_ROOT='$REMOTE' ` from the build-up invocation -> this case goes red; the
# NAS would build against its $HOME default while the stack mounts the discovered root.
t_install_passes_the_discovered_root() {
  local T; sandbox; T=$T
  local rc=0
  run_install "$T" "$T/i1.log" NAS_REMOTE="$T/nas" || rc=$?
  check "M4 explicit root: install exits 0" [ "$rc" = 0 ]
  check "M4 explicit root reaches build-up" grep -qF "KIN_RSI_NAS_ROOT='$T/nas'" "$T/ssh.log"

  local T2; sandbox; T2=$T
  rc=0
  run_install "$T2" "$T2/i2.log" FAKE_HOME="$T2/nas2" || rc=$?
  check "M4 discovered root: install exits 0" [ "$rc" = 0 ]
  check "M4 the discovery probe runs first" grep -qE '^-n -o BatchMode=yes .*printf %s' "$T2/ssh.log"
  check "M4 the probed root is installed into" test -d "$T2/nas2/secrets"
  check "M4 discovered root reaches build-up" grep -qF "KIN_RSI_NAS_ROOT='$T2/nas2'" "$T2/ssh.log"
}

# --- 5: a non-gateway key stops the smoke before claude runs (M5) -------------------------------
# M5: smoke-nas.sh's bad-key branch `exit 1` -> `exit 0` -> this case goes red (the smoke goes on
# to the claude call, which answers NAS_LANE_OK, and reports success).
t_smoke_stops_on_bad_gateway_key() {
  local T; sandbox; T=$T
  local rc=0
  run_smoke "$T" "$T/out.log" \
    FAKE_AUTH_OUT='not an enabled magpie gateway key (redacted)' FAKE_CLAUDE_OUT='NAS_LANE_OK' || rc=$?
  check "M5 a bad gateway key exits 1" [ "$rc" = 1 ]
  check "M5 the cause is named" grep -q 'not an enabled magpie gateway key' "$T/out.log"
  check "M5 the approval guidance is printed" grep -q 'do it only with approval' "$T/out.log"
  check "M5 claude was never invoked" [ ! -s "$T/claude.log" ]
}

# --- 6: the smoke passes only on NAS_LANE_OK (M8) ----------------------------------------------
# M8: `grep -q 'NAS_LANE_OK'` -> `grep -q ''` in smoke-nas.sh -> the SOMETHING ELSE half goes red
# (any output is accepted and the smoke exits 0).
t_smoke_needs_lane_ok() {
  local T; sandbox; T=$T
  local rc=0
  run_smoke "$T" "$T/i1.log" FAKE_AUTH_OUT='{"ok":true}' FAKE_CLAUDE_OUT='SOMETHING ELSE' || rc=$?
  check "M8 a non-answer exits 1" [ "$rc" = 1 ]
  check "M8 a non-answer prints no SMOKE OK" bash -c "! grep -q 'SMOKE OK' '$T/i1.log'"
  check "M8 the claude lane was asked" [ -s "$T/claude.log" ]

  local T2; sandbox; T2=$T
  rc=0
  run_smoke "$T2" "$T2/i2.log" FAKE_AUTH_OUT='{"ok":true}' FAKE_CLAUDE_OUT='NAS_LANE_OK' || rc=$?
  check "M8 the expected answer exits 0" [ "$rc" = 0 ]
  check "M8 the expected answer prints SMOKE OK" grep -q 'SMOKE OK' "$T2/i2.log"
  check "M8 the claude lane was asked (ok path)" [ -s "$T2/claude.log" ]
}

# --- 7: no committed NAS file names a real account, home or address (M6) -----------------------
# M6: add a literal home directory for a named account to install-nas.sh -> this case goes red.
# Allowed forms are $REMOTE, $HOME, $KIN_RSI_NAS_ROOT and the container path /work/home; the
# pattern requires a letter after the slash, so /home/.claude and /work/home cannot match.
# This suite is under the scanned tree, so the home prefix is spelled as a class (`/User[s]/`)
# that matches the path without containing it literally.
t_nas_scripts_name_no_account() {
  local files hits re
  re='/home/[A-Za-z][A-Za-z0-9_-]*|/User[s]/|([0-9]{1,3}\.){3}[0-9]{1,3}'
  files="$(find "$NASDIR" -type f \( -name '*.sh' -o -name '*.yml' -o -name 'Dockerfile' -o -name '*.py' \))"
  hits="$(printf '%s\n' "$files" | while IFS= read -r f; do
    grep -HnE "$re" "$f"
  done)"
  check "M6 the scan covers the published scripts" [ "$(printf '%s\n' "$files" | wc -l | tr -d ' ')" -ge 10 ]
  check "M6 no account, home or address literal" [ -z "$hits" ]
  check "M6 the scan sees the allowed container path" grep -q '/work/home' "$NASDIR/install-nas.sh"
}

if [ "${1:-}" = "--sandbox" ]; then sandbox; trap - EXIT; echo "$T"; exit 0; fi
if [ -n "${1:-}" ]; then "$1"; finish; exit $?; fi    # test-install-preflight.sh <function> — one test

t_install_fails_closed_without_home
t_install_honours_remote_root
t_install_never_prints_the_key
t_install_passes_the_discovered_root
t_smoke_stops_on_bad_gateway_key
t_smoke_needs_lane_ok
t_nas_scripts_name_no_account
finish
