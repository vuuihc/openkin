#!/bin/bash
# install.sh — (re)install the launchd jobs from the templates. Usage: install.sh [pulse merge dream daily]
#
# All or nothing: every template is rendered, linted, and checked for the files its job
# runs before a single plist is written. A bad template or a missing runtime file leaves
# $HOME/Library/LaunchAgents untouched, because a half-installed control tree runs jobs
# that cannot start (three false gate failures on 2026-11-16).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; CTRL="$(cd "$HERE/../../.." && pwd)"; UIDN="$(id -u)"
jobs=("$@"); [ ${#jobs[@]} -eq 0 ] && jobs=(pulse merge dream daily)

die_job() { echo "install: $1: $2" >&2; exit 1; }

# program_files <template> — every <string> in ProgramArguments, one per line.
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

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kin-launchd.XXXXXX")" || die_job install "cannot create a staging dir"
trap 'rm -rf "$STAGE"' EXIT

# Stage and validate everything first; any failure exits before a plist is installed.
for j in "${jobs[@]}"; do
  tmpl="$HERE/$j.plist.tmpl"; [ -f "$tmpl" ] || tmpl="$HERE/../nas/launchd/$j.plist.tmpl"
  [ -f "$tmpl" ] || die_job "$j" "no template $HERE/$j.plist.tmpl"
  while IFS= read -r arg; do
    case "$arg" in
      __CTRL__/*)
        f="$CTRL/${arg#__CTRL__/}"
        [ -s "$f" ] || die_job "$j" "missing or empty $f (run by $tmpl)"
        ;;
    esac
  done < <(program_files "$tmpl")
  staged="$STAGE/com.ethan.kin-rsi-$j.plist"
  sed -e "s#__CTRL__#$CTRL#g" -e "s#__HOME__#$HOME#g" "$tmpl" > "$staged" || die_job "$j" "cannot render $tmpl"
  if ! out="$(plutil -lint "$staged" 2>&1)"; then
    die_job "$j" "plutil rejected $tmpl: $out"
  fi
done

mkdir -p "$HOME/Library/LaunchAgents" || die_job install "cannot create $HOME/Library/LaunchAgents"
for j in "${jobs[@]}"; do
  mv "$STAGE/com.ethan.kin-rsi-$j.plist" "$HOME/Library/LaunchAgents/com.ethan.kin-rsi-$j.plist" ||
    die_job "$j" "cannot write $HOME/Library/LaunchAgents"
done

rc=0
for j in "${jobs[@]}"; do
  dst="$HOME/Library/LaunchAgents/com.ethan.kin-rsi-$j.plist"
  launchctl bootout "gui/$UIDN/com.ethan.kin-rsi-$j" 2>/dev/null
  if launchctl bootstrap "gui/$UIDN" "$dst"; then
    echo "loaded $j"
  else
    echo "install: $j: launchctl bootstrap failed ($dst)" >&2
    rc=1
  fi
done
exit "$rc"
