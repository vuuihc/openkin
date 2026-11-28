#!/bin/bash
# screenshots-obligation.sh — MANDATE 5: a change to a user-visible surface must ship
# captures or say honestly why it cannot. One predicate for both clients, so an RN
# surface PR carries the same obligation as a console .tsx PR; the inline gate in
# merge.sh only ever matched ui/src and let a phone-only change through uncaptured
# (rn-approval-dock, 2026-11-28: an untrue "not visible" waiver took a review round;
# rn-layout-screenshot-arm, 2026-11-28: a src/layout primitive missed the matcher).
#
# Usage: screenshots-obligation.sh <changed-paths-file> <body-file> <shots-dir>
#   changed-paths-file  repo-relative paths, one per line (merge.sh's $CH)
#   body-file           the PR body text
#   shots-dir           local capture dir (may not exist)
# Prints "SHOTS_OK: <reason>" (exit 0) or "SHOTS_FAIL: <reason>" (exit 1).
# Side-effect free: no network, no gh, no state writes.
set -u

if [ $# -ne 3 ]; then
  echo "usage: screenshots-obligation.sh <changed-paths-file> <body-file> <shots-dir>" >&2
  exit 2
fi
PATHS="$1"; BODY="$2"; SHOTS="$3"
ok()  { echo "SHOTS_OK: $*"; exit 0; }
bad() { echo "SHOTS_FAIL: $*"; exit 1; }

[ -f "$PATHS" ] || bad "changed-path list is not readable: $PATHS"
[ -f "$BODY" ] || bad "PR body file is not readable: $BODY"

# Visible surfaces: the console's .tsx (the rule merge.sh has always used) plus every
# hand-written phone .tsx under mobile-rn/src/ or mobile-rn/app/ — screens, native
# modules, layout primitives and app routes alike, so a new family needs no matcher
# edit. Non-.tsx modules carry no surface; tests, specs and mutant manifests are not
# surfaces.
UI_VIS="$(grep -E '^ui/src/.*\.tsx$' "$PATHS" 2>/dev/null | grep -vE '\.(test|spec)\.' || true)"
RN_VIS="$(grep -E '^mobile-rn/(src|app)/.*\.tsx$' "$PATHS" 2>/dev/null | grep -vE '\.(test|spec|mutants)\.' || true)"
[ -z "$UI_VIS$RN_VIS" ] && ok "no user-visible surface changed"

# Real captures satisfy the obligation regardless of what the body says.
if [ -d "$SHOTS" ] && [ -n "$(ls -A "$SHOTS" 2>/dev/null)" ]; then
  ok "captures present in $SHOTS"
fi

# The body's Screenshots line: a link or image is evidence; `none:` needs a reason.
# PR bodies may mark the line as a bullet or a bold label.
SHOT_LINES="$(grep -iE '^[[:space:]>*_-]*\*{0,2}screenshots?:' "$BODY" 2>/dev/null \
  | sed -E 's/^[^:]*:\*{0,2}[[:space:]]*//' || true)"
# The worker contract names a `## Screenshots` section, but a heading carries no colon, so
# the inline matcher above never saw it and an honest `none:` paragraph beneath read as "no
# Screenshots line" (rn-usage-i18n, 2026-11-28 08:40). Collect the section's own non-empty
# lines — up to the next heading, bounded — and let the same loop below classify them; a
# heading with no usable line still falls through to the no-usable-line failure.
SHOT_SECTION="$(awk '/^[[:space:]]*#{1,6}[[:space:]]*[*_]*[Ss]creenshots[*_]*:?[[:space:]]*$/{f=1;n=0;next} f&&/^[[:space:]]*#{1,6}[[:space:]]/{f=0} f&&NF&&n<5{print;n++}' "$BODY" 2>/dev/null || true)"
SHOT_LINES="$SHOT_LINES"$'\n'"$SHOT_SECTION"
EVIDENCE=""; NONE_SEEN=""; NONE_REASON=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    *http://*|*https://*|*'!['*) EVIDENCE=1; continue ;;
  esac
  case "$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')" in
    none:*)
      NONE_SEEN=1
      NONE_REASON="$(printf '%s' "$line" | sed -E 's/^[Nn][Oo][Nn][Ee]:[[:space:]]*//')"
      ;;
  esac
done <<< "$SHOT_LINES"
[ -n "$EVIDENCE" ] && ok "PR body carries a screenshots link or image"

if [ -n "$NONE_SEEN" ]; then
  # An RN-visible change always renders something; "not visible" is the untrue waiver
  # that cost the rn-approval-dock round. A named capture gap of 20+ chars still passes.
  if [ -n "$RN_VIS" ]; then
    case "$(printf '%s' "$NONE_REASON" | tr '[:upper:]' '[:lower:]')" in
      *"not visible"*|*"not user-visible"*|*"no ui/ change"*|*"nothing to see"*)
        bad "this change is user-visible on the phone; name the capture gap (simulator floor, device unavailable, capture pending) instead of \"not visible\"" ;;
    esac
  fi
  [ "${#NONE_REASON}" -ge 20 ] \
    || bad "'Screenshots: none:' needs a reason of at least 20 characters (MANDATE 5)"
  ok "PR body states why captures are missing: $NONE_REASON"
fi

# No usable line at all. The ui/src sentence stays byte-identical to the old inline
# gate's; the phone cases name the surface that now carries the obligation. One copy
# of the widths so a sweep has one line to keep in step (runtime/claim-copies.json).
CAPTURE="Capture 390x844, 820x1180 and 1100x760 before/after, or state why nothing is visible."
if [ -n "$UI_VIS" ] && [ -n "$RN_VIS" ]; then
  bad "UI and phone .tsx changed but no screenshots in $SHOTS/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). $CAPTURE"
elif [ -n "$RN_VIS" ]; then
  bad "Phone .tsx changed but no screenshots in $SHOTS/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). $CAPTURE"
else
  bad "UI .tsx changed but no screenshots in $SHOTS/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). $CAPTURE"
fi
