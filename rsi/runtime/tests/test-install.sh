#!/bin/bash
# test-install.sh — the launchd installer is all or nothing.
#
# install.sh must validate every template and every file a job's ProgramArguments runs
# before it writes a single plist, and it must report a failed launchctl bootstrap.
# A half-installed control tree produced three false gate failures on 2026-11-16.
#
# Hermetic: temp HOME, stubbed launchctl/plutil first on PATH, a temp copy of rsi/runtime
# at the depth install.sh expects (CTRL = <tree>/rsi/runtime/../..). The copy skips the
# gitignored run artifacts, so it never grows with the loop's evidence. No real launchd, no
# network. Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"

# test_tree_skips_run_artifacts plants evidence-shaped files in the live runtime; they must not
# outlive the run, even when the case fails.
PROBE_FILES=(); PROBE_DIRS=()
cleanup_probes() {
  local p
  for p in ${PROBE_FILES[@]+"${PROBE_FILES[@]}"}; do rm -f "$p"; done
  for p in ${PROBE_DIRS[@]+"${PROBE_DIRS[@]}"}; do rmdir "$p" 2>/dev/null || true; done
}
trap 'cleanup_probes; rm -rf "$T"' EXIT

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

# Exclusions for the fixture copy. install.sh reads only the templates and the files their jobs
# run, so the loop's live evidence never belongs in a fixture: rsi/runtime/runs/ is gitignored
# live state (a worktree with 4.3 GB of it made five copies die with "No space left on device",
# then report an unrelated installer failure), and __pycache__/*.pyc are byte-code caches.
# Derive them from the repo's own .gitignore files so this list cannot drift from what the repo
# already treats as disposable.
TAR_EXCLUDES=()
while IFS= read -r pat; do
  case "$pat" in ''|'#'*|'!'*) continue ;; esac
  pat="${pat#/}"; pat="${pat%/}"
  case "$pat" in
    runtime/*) TAR_EXCLUDES+=("--exclude=./${pat#runtime/}") ;;
    __pycache__|'*.pyc') TAR_EXCLUDES+=("--exclude=$pat") ;;
  esac
done < <(cat "$RT/../.gitignore" "$RT/../../.gitignore" 2>/dev/null)

# tree <name> — a copy of rsi/runtime whose CTRL resolves to $T/<name>. It carries only what the
# installer can read, so its size stays flat as the live loop accumulates run logs.
tree() {
  local d="$T/$1"
  mkdir -p "$d/rsi/runtime"
  ( set -o pipefail
    cd "$RT" && tar -cf - ${TAR_EXCLUDES[@]+"${TAR_EXCLUDES[@]}"} . | tar -xf - -C "$d/rsi/runtime"
  ) || fail "tree: cannot copy $RT to $d/rsi/runtime"
  echo "tree $1: $(du -sk "$d" | cut -f1) KB" >&2
  printf '%s\n' "$d"
}

reset_home() { rm -rf "$T/home"; mkdir -p "$T/home"; }
plists() { find "$T/home/Library/LaunchAgents" -maxdepth 1 -name '*.plist' 2>/dev/null; }
nplists() { plists | wc -l | tr -d ' '; }
bootstraps() { if [ -f "$1" ]; then grep -c '^bootstrap ' "$1"; else echo 0; fi; }

# program_files <template> — every <string> in ProgramArguments, one per line. Same parse as
# install.sh's program_files(): the fixture guard pins the files the installer will demand.
program_files() {
  awk '
    /<key>ProgramArguments<\/key>/ { args = 1 }
    args {
      rest = $0
      while (match(rest, /<string>[^<]*<\/string>/)) {
        print substr(rest, RSTART + 8, RLENGTH - 17)
        rest = substr(rest, RSTART + RLENGTH)
      }
      if ($0 ~ /<\/array>/) args = 0
    }
  ' "$1"
}

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

# The fixture copy must not carry the loop's run artifacts: rsi/runtime/runs/ is live evidence,
# not an installer input. A blanket cp -R copied it for every case; in a worktree whose runs/
# held 4.3 GB the gate died with "No space left on device" and then named an unrelated failure.
test_tree_skips_run_artifacts() {
  local d probe_run="$RT/runs/probe-artifact" probe_pyc="$RT/__pycache__/probe.pyc"
  if [ ! -d "$RT/runs" ]; then mkdir -p "$RT/runs"; PROBE_DIRS+=("$RT/runs"); fi
  if [ ! -d "$RT/__pycache__" ]; then mkdir -p "$RT/__pycache__"; PROBE_DIRS+=("$RT/__pycache__"); fi
  PROBE_FILES+=("$probe_run" "$probe_pyc")
  dd if=/dev/zero of="$probe_run" bs=1024 count=1024 2>/dev/null ||
    fail "tree-skips-run-artifacts: cannot plant $probe_run"
  printf 'probe\n' > "$probe_pyc" || fail "tree-skips-run-artifacts: cannot plant $probe_pyc"
  [ -s "$probe_run" ] && [ -s "$probe_pyc" ] ||
    fail "tree-skips-run-artifacts: probe artifacts are missing from $RT"

  d="$(tree tree-probe)" || fail "tree-skips-run-artifacts: tree failed"
  [ ! -e "$d/rsi/runtime/runs" ] ||
    fail "tree-skips-run-artifacts: the copy carries runs/ ($(du -sk "$d/rsi/runtime/runs" 2>/dev/null | cut -f1) KB)"
  [ ! -e "$d/rsi/runtime/__pycache__" ] ||
    fail "tree-skips-run-artifacts: the copy carries __pycache__/"
  [ ! -e "$d/rsi/runtime/runs/probe-artifact" ] ||
    fail "tree-skips-run-artifacts: a run artifact was copied"
  [ ! -e "$d/rsi/runtime/__pycache__/probe.pyc" ] ||
    fail "tree-skips-run-artifacts: a .pyc was copied"
  cleanup_probes
  return 0
}

# The exclusion must not cut a file install.sh reads: every template, and every file its
# ProgramArguments names, has to exist and be non-empty in the fixture copy.
test_tree_keeps_what_install_reads() {
  local d tmpl rel arg templates=0 files=0
  d="$(tree keeps-inputs)" || fail "tree-keeps-what-install-reads: tree failed"
  for tmpl in "$RT"/launchd/*.plist.tmpl "$RT"/nas/launchd/*.plist.tmpl; do
    [ -f "$tmpl" ] || continue
    templates=$((templates + 1))
    rel="${tmpl#"$RT"/}"
    [ -s "$d/rsi/runtime/$rel" ] ||
      fail "tree-keeps-what-install-reads: template $rel is missing or empty in the copy"
    while IFS= read -r arg; do
      case "$arg" in
        __CTRL__/*)
          files=$((files + 1))
          [ -s "$d/${arg#__CTRL__/}" ] ||
            fail "tree-keeps-what-install-reads: $rel runs ${arg#__CTRL__/}, missing or empty in the copy"
          ;;
      esac
    done < <(program_files "$tmpl")
  done
  [ "$templates" -gt 0 ] || fail "tree-keeps-what-install-reads: no templates found under $RT"
  [ "$files" -gt 0 ] || fail "tree-keeps-what-install-reads: no ProgramArguments files parsed"
  return 0
}

run() { local name="$1"; shift; "$@" || exit 1; echo "PASS $name"; }
# Fixture guards first: a copy that carries run artifacts or drops an installer input makes every
# installer case below meaningless.
run tree-skips-run-artifacts test_tree_skips_run_artifacts
run tree-keeps-what-install-reads test_tree_keeps_what_install_reads
run installs-all-four test_installs_all_four
run bad-plist-changes-nothing test_bad_plist_changes_nothing
run missing-runtime-file-changes-nothing test_missing_runtime_file_changes_nothing
run bootstrap-failure-reported test_bootstrap_failure_reported
run idempotent-second-run test_idempotent_second_run
