#!/bin/bash
# install.sh — (re)install the four launchd jobs from the templates. Usage: install.sh [pulse merge dream daily]
HERE="$(cd "$(dirname "$0")" && pwd)"; CTRL="$(cd "$HERE/../../.." && pwd)"; UIDN="$(id -u)"
jobs=("$@"); [ ${#jobs[@]} -eq 0 ] && jobs=(pulse merge dream daily)
for j in "${jobs[@]}"; do
  dst="$HOME/Library/LaunchAgents/com.ethan.kin-rsi-$j.plist"
  sed -e "s#__CTRL__#$CTRL#g" -e "s#__HOME__#$HOME#g" "$HERE/$j.plist.tmpl" > "$dst.new" && plutil -lint "$dst.new" >/dev/null || { echo "bad plist $j"; rm -f "$dst.new"; continue; }
  mv "$dst.new" "$dst"
  launchctl bootout "gui/$UIDN/com.ethan.kin-rsi-$j" 2>/dev/null
  launchctl bootstrap "gui/$UIDN" "$dst" && echo "loaded $j"
done
