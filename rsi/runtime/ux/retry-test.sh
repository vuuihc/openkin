#!/bin/bash
# retry-test.sh — the UX gate's unavailability cooldown, fully stubbed: no model, no Chrome, no daemon, no network.
#   bash rsi/runtime/ux/retry-test.sh
# A stub walker (RSI_UX_WALK_CMD) leaves walk.json + one .png (or UNAVAILABLE); a stub reviewer (RSI_UX_REVIEW_CMD) counts
# dispatches and behaves per $RETRY_T/review.mode. RSI_UX_STATE points at a temp dir, so the real rsi/state is never touched.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; RT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
export RETRY_T="$T"
mkdir -p "$T/st" "$T/wt" "$T/gh"
cat > "$T/walk.sh" <<'SH'
#!/bin/bash
# $1 = screenshot dir. $RETRY_T/walk.mode=down makes the walker report UNAVAILABLE (daemon/chrome outage shape).
echo x >> "$RETRY_T/walkcalls"
if [ "$(cat "$RETRY_T/walk.mode" 2>/dev/null)" = down ]; then echo "daemon did not answer /api/health" > "$1/UNAVAILABLE"; exit 2; fi
printf '{"hardFail":[]}\n' > "$1/walk.json"
printf 'stub png\n' > "$1/j1-390-1-1.png"
SH
cat > "$T/review.sh" <<'SH'
#!/bin/bash
# $1 = prompt file. pass = full scores; noscore = reviewer text without UX_SCORES; anything else = unavailable dispatch (429).
echo x >> "$RETRY_T/reviewcalls"
case "$(cat "$RETRY_T/review.mode" 2>/dev/null)" in
  pass) echo "UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4"; echo "UX_VERDICT: PASS" ;;
  noscore) echo "looks fine"; echo "UX_VERDICT: PASS" ;;
  *) echo "API Error: Request rejected (429) - usage limit reached" >&2; exit 3 ;;
esac
SH
UXD="$T/st/ux/retry-test"; MARK="$T/st/merge/retry-test.uxcooldown"; SHOTS="$T/st/shots/retry-test/journeys"
SENT="$T/st/merge/retry-test.ux.txt"   # the sendback body the cooldown tick must not delete
nrev() { [ -e "$T/reviewcalls" ] && wc -l < "$T/reviewcalls" | tr -d ' ' || echo 0; }
nwalk() { [ -e "$T/walkcalls" ] && wc -l < "$T/walkcalls" | tr -d ' ' || echo 0; }
gate() { # <diff-hash> [extra env assignments...]  -> the gate's exit code
  local dh="$1"; shift
  env RSI_UX_STATE="$T/st" GH_CONFIG_DIR="$T/gh" GH_TOKEN= \
      RSI_UX_WALK_CMD="bash $T/walk.sh \"\$1\"" RSI_UX_REVIEW_CMD="bash $T/review.sh \"\$1\"" "$@" \
      bash "$RT/ux-gate.sh" "$T/wt" retry-test TEST 0 "$dh" >/dev/null 2>&1
}

# 1+2. unavailable reviewer -> cooldown marker; the next tick on the same diff must not dispatch, walk or delete evidence.
echo down > "$T/review.mode"
gate aaaa; r1=$?
e=$(cut -d' ' -f1 "$MARK" 2>/dev/null); d=$(( ${e:-0} - $(date +%s) ))
[ "$d" -ge 1740 ] && [ "$d" -le 1860 ] \
  && ok "the cooldown expires on the default 30-minute wait (${d}s out)" \
  || bad "cooldown expiry is ${d}s out, want 1740..1860 (30 min)"
printf 'sentinel\n' > "$UXD/walk.out"
printf 'stale\n' > "$UXD/unavailable.txt"     # the cooled tick must refresh both with run 1's stored reason
printf 'sendback\n' > "$SENT"                 # ...and must keep run 1's sendback body and screenshots
gate aaaa; r2=$?
[ "$r1" -eq 2 ] && [ "$r2" -eq 2 ] && [ "$(nrev)" -eq 1 ] && [ -s "$MARK" ] \
  && ok "unavailable writes a cooldown and does not re-dispatch" \
  || bad "unavailable: exits $r1/$r2 reviews=$(nrev) marker=$([ -s "$MARK" ] && echo yes || echo no), want 2/2 1 yes"
[ "$(cat "$UXD/walk.out" 2>/dev/null)" = sentinel ] && [ -d "$SHOTS" ] && [ "$(nwalk)" -eq 1 ] \
  && [ "$(cat "$UXD/unavailable.txt" 2>/dev/null)" = "ux reviewer unavailable: dispatch exit 3" ] \
  && [ -s "$SHOTS/j1-390-1-1.png" ] && [ "$(cat "$SENT" 2>/dev/null)" = sendback ] \
  && ok "cooldown skips the walk and keeps the screenshots and sendback body" \
  || bad "cooldown tick touched walk.out/shots/reason/sendback (walk.out='$(cat "$UXD/walk.out" 2>/dev/null)' shots=$([ -d "$SHOTS" ] && echo yes || echo no) png=$([ -s "$SHOTS/j1-390-1-1.png" ] && echo yes || echo no) walks=$(nwalk) reason='$(cat "$UXD/unavailable.txt" 2>/dev/null)' sendback='$(cat "$SENT" 2>/dev/null)')"

# 3. a different diff hash (pushed fix) bypasses the cooldown at once.
gate bbbb; r3=$?
[ "$r3" -eq 2 ] && [ "$(nrev)" -eq 2 ] && [ "$(cut -d' ' -f2 "$MARK" 2>/dev/null)" = bbbb ] \
  && ok "a new diff hash retries at once" \
  || bad "new diff hash: exit $r3 reviews=$(nrev) marker-hash=$(cut -d' ' -f2 "$MARK" 2>/dev/null), want 2 2 bbbb"

# 4. a complete outcome (here PASS) clears the marker, and the following run dispatches again.
echo pass > "$T/review.mode"
printf '%s %s expired-marker\n' "$(( $(date +%s) - 60 ))" cccc > "$MARK"
gate cccc; r4=$?
gone=$([ -e "$MARK" ] && echo no || echo yes)
gate cccc; r5=$?
[ "$r4" -eq 0 ] && [ "$gone" = yes ] && [ "$r5" -eq 0 ] && [ "$(nrev)" -eq 4 ] \
  && ok "a complete run clears the cooldown" \
  || bad "complete run: exits $r4/$r5 marker-gone=$gone reviews=$(nrev), want 0/0 yes 4"

# 5. RSI_UX_COOLDOWN_MIN=0 disables the wait, even over an active marker left by the default 30-min cooldown.
echo down > "$T/review.mode"
gate dddd; rd=$?                      # default: writes an active marker for dddd
b=$(nrev)
gate dddd RSI_UX_COOLDOWN_MIN=0; r6=$?
gate dddd RSI_UX_COOLDOWN_MIN=0; r7=$?
[ "$rd" -eq 2 ] && [ "$r6" -eq 2 ] && [ "$r7" -eq 2 ] && [ "$(( $(nrev) - b ))" -eq 2 ] \
  && ok "cooldown 0 disables the wait" \
  || bad "cooldown 0: exits $rd/$r6/$r7 reviews=$(( $(nrev) - b )) after the marker, want 2/2/2 2"

# 6. A reachable reviewer that gives no scores is a FAIL (gate-test noscore invariant), never unavailable/cooldown.
echo noscore > "$T/review.mode"
gate eeee; r8=$?
[ "$r8" -eq 1 ] && [ ! -e "$MARK" ] \
  && ok "no scores from a live reviewer is FAIL and leaves no cooldown" \
  || bad "noscore: exit $r8 marker=$([ -e "$MARK" ] && echo present || echo absent), want 1 absent"

# 7. A walker outage takes the same path: cooldown on the first tick, no walk and no dispatch on the second.
echo down > "$T/walk.mode"; echo down > "$T/review.mode"; b=$(nrev); w=$(nwalk)
gate ffff; r9=$?
gate ffff; r10=$?
[ "$r9" -eq 2 ] && [ "$r10" -eq 2 ] && [ "$(( $(nwalk) - w ))" -eq 1 ] && [ "$(nrev)" -eq "$b" ] \
  && [ "$(cut -d' ' -f2 "$MARK" 2>/dev/null)" = ffff ] \
  && ok "walker unavailability also cools down without dispatching" \
  || bad "walker outage: exits $r9/$r10 walks=$(( $(nwalk) - w )) dispatched=$(( $(nrev) - b )), want 2/2 1 0"
rm -f "$T/walk.mode"

[ ! -e "$RT/../state/merge/retry-test.uxcooldown" ] && [ ! -e "$RT/../state/ux/retry-test/scores.json" ] \
  && ok "real rsi/state untouched" || bad "cooldown leaked into the worktree rsi/state"
exit $fail
