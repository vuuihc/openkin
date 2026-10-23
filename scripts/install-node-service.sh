#!/usr/bin/env bash
# Install this Mac as a Kin node that survives reboots (macOS LaunchAgent).
#
# A node is what lets another device send work to this machine: it dials the Hub
# and holds the connection open. Run by hand it only exists until the next
# restart or logout, and nothing tells the Hub it is gone — the machine just
# stops being able to take work. A LaunchAgent starts it at login and restarts
# it if it dies.
#
# Usage:
#   ./scripts/install-node-service.sh --hub https://kin.example.com --token <device-token>
#   ./scripts/install-node-service.sh --hub ... --token - < ~/.kin/node-token
#   ./scripts/install-node-service.sh --hub ... --root ~/Workspace --root ~/src
#   ./scripts/install-node-service.sh --status
#   ./scripts/install-node-service.sh --uninstall
#
# Re-running with no flags at all is how an installed copy is refreshed: the Hub
# and the roots are read back out of the plist already in place. Roots must be
# absolute. KIN_STATE_DIR is honoured, and is passed on to the job.
#
# The device token goes to <state-dir>/node-token (0600) — the same file the
# daemon already reads by default — so nothing secret lands in the plist and a
# rotated token takes effect on the next restart.
#
# Prefer the Hub's public origin over its LAN address. A node whose Hub is a
# 192.168.x.x URL only works while this Mac is on that network, and macOS
# denies local-network access to a binary launchd started unless the user has
# granted it: the job comes up "healthy", dials, and dies with "no route to
# host" while the same URL works fine from a terminal.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="dev.openkin.node"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
NODE_DIR="$HOME/.kin/node"
STATE_DIR="${KIN_STATE_DIR:-$HOME/.kin}"
LOG_FILE="$NODE_DIR/node.log"

HUB=""
TOKEN=""
LABEL_OVERRIDE=""
# Treated exactly like --state-dir: the daemon reads KIN_STATE_DIR too, so a node
# that took its token from there must be handed the same value by launchd.
STATE_DIR_OVERRIDE="${KIN_STATE_DIR:-}"
ROOTS=()
MODE="install"

die() {
  echo "error: $*" >&2
  exit 1
}

# Every flag takes a value; without this a missing one either dies silently
# under `set -u` or eats the next flag as its argument.
need_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || die "$1 needs a value"
  # A missing value at the end of the line does not leave the next flag to eat:
  # `--hub https://h --token --root` would install a node whose device token is
  # the literal string "--root", load it, and report success. "-" stays legal —
  # it is how --token reads from stdin.
  [[ "$2" != --* ]] || die "$1 needs a value (found the flag $2)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) need_value "$@"; HUB="$2"; shift 2 ;;
    # "-" reads the token from stdin, which keeps it out of shell history and
    # out of the process table.
    --token) need_value "$@"; if [[ "$2" == "-" ]]; then read -rs TOKEN || true; else TOKEN="$2"; fi; shift 2 ;;
    # launchd runs the job with cwd /, so a relative root reaches the Hub as a
    # path that does not exist there.
    --root) need_value "$@"; [[ "$2" == /* ]] || die "--root must be an absolute path (got $2)"; ROOTS+=("$2"); shift 2 ;;
    --state-dir) need_value "$@"; STATE_DIR_OVERRIDE="$2"; shift 2 ;;
    --label) need_value "$@"; LABEL_OVERRIDE="$2"; shift 2 ;;
    --status) MODE="status"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help) sed -n '2,29p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [[ -n "$LABEL_OVERRIDE" ]]; then
  LABEL="$LABEL_OVERRIDE"
  PLIST="$AGENT_DIR/$LABEL.plist"
fi
if [[ -n "$STATE_DIR_OVERRIDE" ]]; then
  STATE_DIR="$STATE_DIR_OVERRIDE"
fi
TOKEN_FILE="$STATE_DIR/node-token"

uid="$(id -u)"

case "$MODE" in
  status)
    launchctl print "gui/$uid/$LABEL" 2>/dev/null | sed -n '1,20p' \
      || die "not installed (no $LABEL in gui/$uid)"
    echo "--- last log lines ($LOG_FILE) ---"
    tail -5 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
    exit 0
    ;;
  uninstall)
    launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL (the node binary and token stay in $NODE_DIR and $TOKEN_FILE)"
    exit 0
    ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || die "LaunchAgents are macOS only"

# ProgramArguments as one argument per line, in order, XML-unescaped.
#
# plutil ships with macOS; python3 does not (it arrives with the Xcode command
# line tools), so a reader that needs python3 cannot be relied on to explain a
# re-install that has nothing to go on.
plist_args() {
  plutil -convert xml1 -o - "$PLIST" 2>/dev/null | awk '
    /<key>ProgramArguments<\/key>/ { inargs = 1; next }
    inargs && /<string>/ {
      line = $0
      sub(/^.*<string>/, "", line)
      sub(/<\/string>.*$/, "", line)
      print line
      next
    }
    inargs && /<\/array>/ { exit }
  '
}

# Reverse of xml_escape, in the reverse order (&amp; last).
xml_unescape() {
  local s="$1"
  s="${s//&lt;/<}"; s="${s//&gt;/>}"; s="${s//&quot;/\"}"; s="${s//&apos;/\'}"
  s="${s//&amp;/&}"
  printf '%s' "$s"
}

# Re-running after a rebuild is the normal way to refresh the installed copy, so
# what the plist already in place says is the default rather than a set of flags
# the caller has to remember. Roots come back too: a refresh that quietly reset
# them to ~/Workspace would silently stop offering the projects the node was
# installed for.
PLIST_HUB=""
PLIST_ROOTS=()
if [[ -f "$PLIST" ]]; then
  prev=""
  while IFS= read -r arg; do
    case "$prev" in
      --hub) [[ -n "$PLIST_HUB" ]] || PLIST_HUB="$(xml_unescape "$arg")" ;;
      --root) PLIST_ROOTS+=("$(xml_unescape "$arg")") ;;
    esac
    prev="$arg"
  done < <(plist_args)
fi

if [[ -z "$HUB" && -n "$PLIST_HUB" ]]; then
  HUB="$PLIST_HUB"
  echo "==> reusing the Hub from $PLIST: $HUB"
fi
if [[ -z "$HUB" ]]; then
  if [[ -f "$PLIST" ]]; then
    die "--hub is required: could not read one from $PLIST"
  fi
  die "--hub is required (the Hub this node should dial)"
fi
[[ -x "$ROOT/kin" ]] || die "no $ROOT/kin — run 'make go-build' first"

if [[ ${#ROOTS[@]} -eq 0 && ${#PLIST_ROOTS[@]} -gt 0 ]]; then
  ROOTS=("${PLIST_ROOTS[@]}")
  echo "==> reusing the roots from $PLIST: ${ROOTS[*]}"
fi

if [[ -z "$TOKEN" ]]; then
  [[ -f "$TOKEN_FILE" ]] || die "--token is required the first time (device token from the Hub; '-' reads stdin)"
  echo "==> reusing the device token in $TOKEN_FILE"
fi

# Default to the directory people keep their repos in, so a fresh install can be
# given work without also having to declare roots.
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  if [[ -d "$HOME/Workspace" ]]; then
    ROOTS=("$HOME/Workspace")
  else
    ROOTS=("$HOME")
  fi
fi

echo "==> installing node binary → $NODE_DIR/kin"
mkdir -p "$NODE_DIR"
chmod 700 "$NODE_DIR"
# Copy rather than point at the checkout: worktrees come and go, and a login
# item that launches a deleted path fails silently at the next reboot.
cp "$ROOT/kin" "$NODE_DIR/kin"
chmod 755 "$NODE_DIR/kin"
if [[ -x "$ROOT/scripts/dev-sign.sh" ]]; then
  "$ROOT/scripts/dev-sign.sh" "$NODE_DIR/kin" >/dev/null || true
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [[ -n "$TOKEN" ]]; then
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

# launchd hands a job PATH=/usr/bin:/bin:/usr/sbin:/sbin. Agents do not live
# there — `claude` is in ~/.local/bin, `codex` under nvm — and the daemon
# resolves them with exec.LookPath and no fallback, so a node started this way
# would come up healthy and fail every turn it was handed. Capture the login
# shell's own PATH now; a login item that cannot find its tools is worse than
# no login item, because it looks like it is working.
login_path() {
  local captured
  captured="$("$SHELL" -ilc 'printf %s "$PATH"' 2>/dev/null | tail -1)" || true
  # zsh profiles sometimes list a literal "~/…", which PATH does not expand.
  captured="${captured//\~\//$HOME/}"
  if [[ -n "$captured" ]]; then
    printf '%s' "$captured"
  else
    printf '%s' "$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  fi
}

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}

# Real argv, not a shell line: the token comes from the file the daemon already
# reads, so there is nothing to quote and nothing secret to escape.
args_xml="    <string>$(xml_escape "$NODE_DIR/kin")</string>
    <string>supervise</string>
    <string>--hub</string>
    <string>$(xml_escape "$HUB")</string>"
for r in "${ROOTS[@]}"; do
  args_xml="$args_xml
    <string>--root</string>
    <string>$(xml_escape "$r")</string>"
done

env_xml="    <key>PATH</key>
    <string>$(xml_escape "$(login_path)")</string>"
if [[ -n "$STATE_DIR_OVERRIDE" ]]; then
  env_xml="$env_xml
    <key>KIN_STATE_DIR</key>
    <string>$(xml_escape "$STATE_DIR")</string>"
fi

mkdir -p "$AGENT_DIR"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$args_xml
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$env_xml
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash, but not after a clean stop: quitting on purpose
       must not bounce straight back. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
PLIST_EOF
chmod 600 "$PLIST"

plutil -lint "$PLIST" >/dev/null || die "generated plist is not valid"

echo "==> loading $LABEL"
launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
# A bootout is asynchronous: bootstrapping the same label immediately after it
# fails with "Bootstrap failed: 5: Input/output error" often enough to matter.
loaded=0
bootstrap_error=""
for _ in 1 2 3 4 5; do
  if bootstrap_error="$(launchctl bootstrap "gui/$uid" "$PLIST" 2>&1)"; then
    loaded=1
    break
  fi
  sleep 1
done
# launchctl's own words, not just a pointer at the log: a plist or permission
# problem never reaches the job's log at all.
[[ "$loaded" == "1" ]] || die "could not load $LABEL: ${bootstrap_error:-launchctl bootstrap failed}"
launchctl kickstart -k "gui/$uid/$LABEL"

sleep 3
if launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1; then
  echo "==> node service loaded (hub $HUB)"
  echo "    log:     $LOG_FILE"
  echo "    status:  $0 --status"
  echo "    remove:  $0 --uninstall"
  echo "    note:    re-run this script after rebuilding ./kin to refresh the installed copy"
else
  die "service did not load — check $LOG_FILE"
fi
