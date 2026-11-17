#!/bin/bash
# test-install.sh — the launchd installer is all or nothing.
#
# install.sh must validate every template and every file a job's ProgramArguments runs
# before it writes a single plist, and it must report a failed launchctl bootstrap.
# A half-installed control tree produced three false gate failures on 2026-11-16.
#
# Hermetic: temp HOME, stubbed launchctl/plutil first on PATH, a temp copy of rsi/runtime
# at the depth install.sh expects (CTRL = <tree>/rsi/runtime/../..). No real launchd, no
# network. Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

mkdir -p "$T/bin"
# plutil stub: `plutil -lint <file>` accepts exactly the XML property lists the real tool does.
cat > "$T/bin/plutil" <<'SH'
#!/bin/bash
[ "${1:-}" = "-lint" ] || { echo "usage: plutil -lint <file>" >&2; exit 2; }
python3 - "$2" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as fh:
    plistlib.load(fh)
PY
SH
# launchctl stub: records every call; STUB_LAUNCHCTL_FAIL makes that label's bootstrap fail.
cat > "$T/bin/launchctl" <<'SH'
#!/bin/bash
echo "$*" >> "${STUB_LAUNCHCTL_LOG:?}"
if [ "${1:-}" = "bootstrap" ] && [ -n "${STUB_LAUNCHCTL_FAIL:-}" ]; then
  case "$*" in *"$STUB_LAUNCHCTL_FAIL"*) exit 1 ;; esac
fi
exit 0
SH
chmod +x "$T/bin/plutil" "$T/bin/launchctl"

# tree <name> — a copy of rsi/runtime whose CTRL resolves to $T/<name>.
tree() {
  local d="$T/$1"
  mkdir -p "$d/rsi"
  cp -R "$RT" "$d/rsi/runtime"
  printf '%s\n' "$d"
}

reset_home() { rm -rf "$T/home"; mkdir -p "$T/home"; }
plists() { find "$T/home/Library/LaunchAgents" -maxdepth 1 -name '*.plist' 2>/dev/null; }
nplists() { plists | wc -l | tr -d ' '; }
bootstraps() { if [ -f "$1" ]; then grep -c '^bootstrap ' "$1"; else echo 0; fi; }

# run_install <ctrl-tree> <log> [jobs...] — HOME and the stubs are the temp ones.
run_install() {
  local ctrl="$1" log="$2"; shift 2
  STUB_LAUNCHCTL_LOG="$log" \
  HOME="$T/home" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    bash "$ctrl/rsi/runtime/launchd/install.sh" "$@"
}

# --- cases -------------------------------------------------------------------------------------

# The happy path: four jobs, four plists, four bootstraps, no placeholders left behind.
test_installs_all_four() {
  local d log j; d="$(tree all-four)"; reset_home; log="$T/log-all-four"
  run_install "$d" "$log" || fail "installs-all-four: installer exited non-zero"
  [ "$(nplists)" = 4 ] || fail "installs-all-four: $(nplists) plists installed, want 4"
  for j in pulse merge dream daily; do
    [ -s "$T/home/Library/LaunchAgents/com.ethan.kin-rsi-$j.plist" ] ||
      fail "installs-all-four: $j plist missing"
  done
  [ "$(bootstraps "$log")" = 4 ] || fail "installs-all-four: $(bootstraps "$log") bootstrap calls, want 4"
  grep -q '__CTRL__\|__HOME__' "$T/home/Library/LaunchAgents"/*.plist &&
    fail "installs-all-four: a plist still holds a template placeholder"
  return 0
}

# One invalid template: nothing is written, and the failing job is named.
test_bad_plist_changes_nothing() {
  local d log err; d="$(tree bad-plist)"; reset_home; log="$T/log-bad-plist"; err="$T/err-bad-plist"
  printf '<plist version="1.0"><dict><key>Label</key>\n' > "$d/rsi/runtime/launchd/dream.plist.tmpl"
  if run_install "$d" "$log" 2>"$err"; then fail "bad-plist-changes-nothing: installer exited 0"; fi
  [ "$(nplists)" = 0 ] || fail "bad-plist-changes-nothing: wrote $(nplists) plists"
  grep -q 'dream' "$err" || fail "bad-plist-changes-nothing: stderr does not name dream: $(cat "$err")"
  return 0
}

# A file a job runs is gone: nothing is written, and the missing path is named.
test_missing_runtime_file_changes_nothing() {
  local d log err; d="$(tree missing-file)"; reset_home; log="$T/log-missing-file"; err="$T/err-missing-file"
  rm -f "$d/rsi/runtime/run.sh"
  if run_install "$d" "$log" 2>"$err"; then fail "missing-runtime-file-changes-nothing: installer exited 0"; fi
  [ "$(nplists)" = 0 ] || fail "missing-runtime-file-changes-nothing: wrote $(nplists) plists"
  grep -q 'run\.sh' "$err" || fail "missing-runtime-file-changes-nothing: stderr does not name run.sh: $(cat "$err")"
  return 0
}

# A failed bootstrap is reported, not swallowed, and fails the installer.
test_bootstrap_failure_reported() {
  local d log err; d="$(tree bootstrap-fail)"; reset_home; log="$T/log-bootstrap-fail"; err="$T/err-bootstrap-fail"
  if STUB_LAUNCHCTL_FAIL=com.ethan.kin-rsi-merge run_install "$d" "$log" 2>"$err"; then
    fail "bootstrap-failure-reported: installer exited 0"
  fi
  grep -q 'merge' "$err" || fail "bootstrap-failure-reported: stderr does not name merge: $(cat "$err")"
  return 0
}

# Re-running with everything present succeeds; it does not depend on a clean first run.
test_idempotent_second_run() {
  local d log; d="$(tree idempotent)"; reset_home; log="$T/log-idempotent"
  run_install "$d" "$log" || fail "idempotent-second-run: first run failed"
  run_install "$d" "$log" || fail "idempotent-second-run: second run failed"
  [ "$(nplists)" = 4 ] || fail "idempotent-second-run: $(nplists) plists installed, want 4"
  [ "$(bootstraps "$log")" = 8 ] || fail "idempotent-second-run: $(bootstraps "$log") bootstrap calls, want 8"
  return 0
}

run() { local name="$1"; shift; "$@" || exit 1; echo "PASS $name"; }
run installs-all-four test_installs_all_four
run bad-plist-changes-nothing test_bad_plist_changes_nothing
run missing-runtime-file-changes-nothing test_missing_runtime_file_changes_nothing
run bootstrap-failure-reported test_bootstrap_failure_reported
run idempotent-second-run test_idempotent_second_run
