#!/bin/bash
# ux-gate.sh <worktree> <slug> <item> <pr#> <diff-hash> [role]
#   ux-gate.sh --accepts-review <review-file>   exit 0 only when the gate's own review decision
#                                               (grounding + thresholds) accepts the cached text;
#                                               merge.sh asks before reusing a strong-ux cache
# The UX gate of the merge lane (CEO 2026-11-15, after Ethan: "don't ship something that is not even demo-quality"). For a PR that touches
# UI source it (1) walks the affected journeys in the real console at 390/1100(/1280) on a throwaway daemon and saves screenshots,
# (2) has a vision reviewer (Hydrogen first — multimodal; gpt-6.1-sol fallback) score the five rubric
# axes from rsi/roles/ux-reviewer.md, (3) decides. Threshold (recomputed here, the model's own verdict is not trusted): every axis >= 3
# AND mean >= 3.5 AND no walk hard failure. Writes state/merge/<slug>.ux.txt (the sendback body) and state/ux/<slug>/ (scores.json).
# exit 0 PASS | 1 FAIL (sendback body written) | 2 UNAVAILABLE (infra; the PR stays verified but is NOT merged, needs-ceo note)
#   An unavailable outcome starts a cooldown (state/merge/<slug>.uxcooldown, RSI_UX_COOLDOWN_MIN minutes, default 30): later ticks for
#   the same diff exit 2 at once, without walking, dispatching or deleting the last walk's screenshots. A new diff hash retries at once.
#   RSI_UX_COOLDOWN_MIN=0    disable the cooldown (test hook)
#   RSI_UX_WALK_CMD=<cmd>    test hook: run instead of the walker, gets the screenshot dir as $1, must leave walk.json + a .png there
#                            a red run's confirm re-walk passes the journey selector (J2,J9) as an optional $2;
#                            a variant's second sample is the same call into state/ux/<slug>/confirm2;
#                            older callers (retry-test.sh) pass only $1 and stay valid
#   RSI_UX_REVIEW_CMD=<cmd>  test hook: run instead of the model, gets the prompt file as $1 and prints the reviewer text
#                            (a non-zero exit without UX_SCORES counts as unavailable, same as a failed dispatch)
#   RSI_UX_STATE=<dir>       state root override for tests; defaults to the worktree's rsi/state. Not RSI_STATE: the loop
#                            already exports that as the controller state, so it cannot serve as a test-local override.
# A reproduced walk red (1b) convicts only when its journey is attributable to this PR's own diff
# (1b0, R-ux-outside-reds 2026-11-22): journeys.json `paths`, first match wins, with test files,
# web/dist/ and the copy-only locales catch-all excluded. Unattributable reproductions are printed,
# saved to state/ux/<slug>/outside.txt and counted in confirm.summary as evidence, not blocked,
# and the reviewer prompt names them as evidence about the product rather than about this PR. An
# unreadable spec, an unmatched path that is not documentation, loop plumbing or the RN client
# (docs/, rsi/, scripts/, web/, mobile-rn/, *.md) or an empty union fails closed: every reproduced
# red convicts, exactly as before this rule.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
if [ -n "${RSI_UX_STATE:-}" ]; then STATE="$RSI_UX_STATE"; export RSI_STATE="$STATE"; fi
# 2c. A below-3 axis must be grounded in a finding that names it (CEO 2026-11-19, #383).
# #383 was sent to a rework round on `feedback=2` while its findings said "no regression
# observed" and never named the axis: a lane, an 11-minute walk and a vision review billed to
# an unexplained number. A score is evidence, not a verdict: re-ask the same reviewer once for
# the evidence, and when it still cannot name it, record "no verdict" (unavailable) instead of
# sending the PR back. The axis word inside the machine `UX_SCORES:` line never counts.
# Defined before any state is touched: merge.sh asks the same predicate before it reuses a
# cached strong UX review, so the rule lives here once instead of being restated there.
ungrounded_axes() { # <review-file> -> comma list of axes <3 that no finding line names
  python3 - "$1" <<'PY'
import re, sys
txt = open(sys.argv[1], errors="replace").read()
axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
m = re.findall(r"UX_SCORES:\s*(.+)", txt)
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]):
        sc[k] = int(v)
body = "\n".join(l for l in txt.splitlines() if not re.match(r"^\s*[-*_>#]*\s*UX_(SCORES|VERDICT):", l))
print(",".join(a for a in axes if a in sc and sc[a] < 3 and not re.search(r"(?i)\b%s\b" % a, body)))
PY
}
# The gate's own review decision, shared with merge.sh's cached-review reuse: only a review this
# accepts may become a verdict by reuse. Exit 0 accept, 1 reject.
accepts_review() { # <review-file>
  [ -s "$1" ] || return 1
  [ -z "$(ungrounded_axes "$1" 2>/dev/null)" ] || return 1
  python3 - "$1" <<'PY'
import re, sys
axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
txt = open(sys.argv[1], errors="replace").read()
m = re.findall(r"UX_SCORES:\s*(.+)", txt)
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]): sc[k] = int(v)
sys.exit(0 if all(a in sc for a in axes) and all(sc[a] >= 3 for a in axes) and sum(sc[a] for a in axes) / 5 >= 3.5 else 1)
PY
}
if [ "${1:-}" = "--accepts-review" ]; then accepts_review "${2:-}"; exit $?; fi
WT="$1"; SLUG="$2"; ITEM="$3"; N="$4"; DH="$5"; ROLE="${6:-reviewer}"
UXD="$STATE/ux/$SLUG"; SHOTS="$STATE/shots/$SLUG/journeys"; ERR="$STATE/merge/$SLUG.ux.txt"
COOL="$STATE/merge/$SLUG.uxcooldown"; mkdir -p "$STATE/merge"
COOL_MIN="${RSI_UX_COOLDOWN_MIN:-30}"; case "$COOL_MIN" in ''|*[!0-9]*) COOL_MIN=30;; esac
unavailable() { # reason: record it, start the cooldown, exit 2 (never PASS/FAIL, never delete walk evidence)
  local rsn; rsn="$(printf '%s' "$1" | tr '\n' ' ')"   # the marker is one line: <expiry> <hash> <reason>
  printf '%s\n' "$1" > "$UXD/unavailable.txt"
  if [ "$COOL_MIN" -gt 0 ]; then
    printf '%s %s %s\n' "$(( $(date +%s) + COOL_MIN * 60 ))" "$DH" "$rsn" > "$COOL" 2>/dev/null || true
  fi
  exit 2
}
# 0. cooldown from an earlier unavailable run on this exact diff: no walk, no dispatch, no rm -rf of $SHOTS
if [ "$COOL_MIN" -gt 0 ] && [ -s "$COOL" ]; then
  CEXP=""; CDH=""; CRSN=""; read -r CEXP CDH CRSN < "$COOL" 2>/dev/null || true
  if [ "${CDH:-}" = "$DH" ] && [ "${CEXP:-0}" -gt "$(date +%s)" ] 2>/dev/null; then
    mkdir -p "$UXD"
    printf '%s\n' "${CRSN:-cooldown}" > "$UXD/unavailable.txt"
    echo "ux-gate: cooling down until $(date -r "$CEXP" '+%F %H:%M' 2>/dev/null || echo "epoch $CEXP") (${CRSN:-cooldown})"
    exit 2
  fi
fi
rm -rf "$SHOTS"; mkdir -p "$UXD" "$SHOTS"; : > "$ERR"
$GIT -C "$WT" diff --name-only origin/main...HEAD > "$UXD/changed.txt"
# 1. walk (affected journeys only; unmapped paths walk everything)
if [ -n "${RSI_UX_WALK_CMD:-}" ]; then bash -c "$RSI_UX_WALK_CMD" _ "$SHOTS" > "$UXD/walk.out" 2>&1 || true
else bash "$RSI_DIR/runtime/ux-walk.sh" "$WT" "$SHOTS" "@$UXD/changed.txt" > "$UXD/walk.out" 2>&1 || true; fi
if [ -e "$SHOTS/UNAVAILABLE" ]; then unavailable "ux walk unavailable: $(cat "$SHOTS/UNAVAILABLE")"; fi
[ -s "$SHOTS/walk.json" ] || unavailable "walker wrote no walk.json"
HARD="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(d.get("hardFail",[])))' "$SHOTS/walk.json")"
# Known walk artefacts (state/ux-known-artifacts.txt): exact hard-fail lines that are environment
# defects, not this PR's. They are printed and saved, never silently swallowed; an empty or absent
# file leaves the gate exactly as strict as before.
KNOWN="$STATE/ux-known-artifacts.txt"
UX_IGNORED=""
if [ -n "$HARD" ] && [ -s "$KNOWN" ]; then
  UX_IGNORED="$(printf '%s\n' "$HARD" | grep -F -f "$KNOWN" || true)"
  if [ -n "$UX_IGNORED" ]; then
    HARD="$(printf '%s\n' "$HARD" | grep -v -F -f "$KNOWN" || true)"
    printf '%s\n' "$UX_IGNORED" > "$UXD/ignored.txt"
    echo "ux-gate: ignored known walk artefacts ($KNOWN):"
    printf '%s\n' "$UX_IGNORED" | sed 's/^/  - /'
  fi
fi
NSHOT="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
[ "$NSHOT" -gt 0 ] || unavailable "walk produced no screenshots"
# 1b. Confirm a red once before it bills a rework round (R-ux-gate-confirm-red, 2026-11-18).
# One hard-fail line from one walk used to convict a UI PR for a whole rework round; #296 was
# billed a 9-minute lane and $0.89 for `J9/mac: scroll-kept ...`, which three independent walks
# of the same tree could not reproduce. A red is now re-walked once, on the same tree, for the
# journeys its failing lines name. Only failures the second walk reproduces survive; the rest
# are recorded as flaked in the sendback and scores.json, so the rework lane and the retro can
# count false reds by source. A green run walks once and never creates $UXD/confirm. A confirm
# that cannot run keeps the first-walk failures: fail closed, never turn a red into "unavailable".
# A line only the confirm walk produced is a variant and is sampled once more (1b1): seen twice
# it convicts, seen once it is evidence, and a second sample that cannot run keeps its conviction.
CONF_JSON="$UXD/confirm.json"; CONF_SUMMARY=""
rm -f "$CONF_JSON" "$UXD/confirm.txt" "$UXD/confirm.summary" "$UXD/confirm.hard" "$UXD/green.txt" \
      "$UXD/outside.txt" "$UXD/attributed.txt" "$UXD/variant.pending"   # this attempt's evidence only
# This run's own evidence only: a stale UNAVAILABLE or walk.json from an earlier attempt on the
# same slug must not decide the confirmation.
rm -rf "$UXD/confirm" "$UXD/confirm2"
if [ -n "$HARD" ]; then
  # A hard fail names its journey two ways: walk.mjs writes `<journey>/<viewport>: ` for a step
  # failure, and `<J<nn>>-<viewport>-<NN>-<step>: ` for a screenshot check such as "blank page"
  # or "horizontal page overflow". Both are localisable, so both select the re-walk; treating the
  # screenshot form as unattributable billed #330 a rework round for two blank-page lines its own
  # confirm walk could not reproduce. Only a line that names no journey at all is kept and skips
  # the confirm: re-walking everything would double the cost for a failure we cannot target.
  JOURNEYS="$(printf '%s\n' "$HARD" | sed -n -e 's#^\([A-Za-z0-9_]*\)/.*#\1#p' -e 's#^\(J[0-9][0-9]*\)-.*#\1#p' | sort -u | paste -sd, -)"
  if [ -n "$JOURNEYS" ]; then
    # 1b0. Attribution (R-ux-outside-reds, 2026-11-22): a reproduced red convicts only when its
    # journey is one this PR's own changed paths can reach. AGENTS.md requires every user-visible
    # change to touch both locale files, and journeys.json maps that catch-all to every journey, so
    # almost every UI PR walked the whole product and a pre-existing red anywhere was billed to it:
    # #585 scored 4/4/4/4/4 PASS with every reported hard-fail outside /routines and was still sent
    # back. Same rule as the walker (first paths row whose `|`-separated alternative is a prefix
    # wins), read from the branch's own journeys.json. Test files, manifests, web/dist/ and the
    # RN client's mobile-rn/ are not rendered surfaces; the copy-only locales row selects journeys
    # for walking, not conviction. An RN screen cannot draw a console journey, so it never enters
    # the union (R-ux-rn-attribution, 2026-11-27); every other unmatched surface still does.
    # Any unreadable spec, unmatched path outside documentation/loop plumbing, or empty union
    # fails closed to today's rule: every reproduced red convicts. Unattributable reproductions
    # are still printed, saved and counted, never silently dropped.
    python3 - "$WT/rsi/runtime/ux/journeys.json" "$UXD/changed.txt" > "$UXD/attributed.txt" <<'PY'
import json, re, sys

spec, changed = sys.argv[1], sys.argv[2]
def closed(why):
    print("ATTRCLOSED " + why)
    sys.exit(0)
try:
    with open(spec, encoding="utf-8") as f:
        doc = json.load(f)
    rows = doc.get("paths") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        closed("journeys.json has no paths list")
    with open(changed, encoding="utf-8", errors="replace") as f:
        files = [line.strip() for line in f if line.strip()]
except Exception as exc:
    closed("read error: " + " ".join(str(exc).split()))
parsed = []
for row in rows:
    if not (isinstance(row, list) and len(row) >= 2
            and isinstance(row[0], str) and isinstance(row[1], list)):
        closed("malformed paths row")
    parsed.append((row[0], [j for j in row[1] if isinstance(j, str)]))
def skipped(path):
    if path.startswith("web/dist/") or "__tests__/" in path:
        return True
    # *.test.ts(x), *.dom.test.tsx, *.test.py, *.spec.*, *.mutants.json
    return bool(re.search(r"\.(test\.[A-Za-z0-9]+|test\.py|spec\.[A-Za-z0-9]+|mutants\.json)$", path))
# Documentation and loop plumbing are not rendered surfaces and cannot reach a journey.
# mobile-rn/ is the Expo client: it renders no console route, so an RN change cannot cause a
# web-console journey's red and cannot close the union (R-ux-rn-attribution, 2026-11-27: #822's
# RN screen beside the shared Markdown.tsx closed the union on `mobile-rn/...`, walked all 17
# journeys, and billed J12's list-order artefact to a diff that cannot reach it). Its proof is
# scripts/check.sh's mobile-rn job, not this walk. Every other path with no row falls back to
# journeys.json's own "no match = all journeys", so it can: an `internal/api/...` change beside a
# routines page may have caused the red the walk filed as outside, and freeing it would merge a
# real regression.
def not_surface(path):
    return path.startswith(("docs/", "rsi/", "scripts/", "web/", "mobile-rn/")) or path.endswith(".md")
union = set()
for path in files:
    if skipped(path):
        continue
    hit = next(((pat, js) for pat, js in parsed
                if any(path.startswith(p) for p in pat.split("|"))), None)
    if hit is None:
        if not_surface(path):
            continue
        if path.startswith("ui/"):
            closed("unmapped ui path: " + path)
        closed("unmapped path: " + path)
    if hit[0] == "ui/src/i18n/locales/":
        continue
    union.update(hit[1])
if not union:
    closed("empty union (copy-only or non-UI diff)")
print("ATTRJ=" + ",".join(sorted(union, key=lambda j: (len(j), j))))
PY
    ATTR_OUT="$(cat "$UXD/attributed.txt" 2>/dev/null || true)"
    case "$ATTR_OUT" in
      ATTRJ=*) ;;
      *) # A helper that could not decide must not free a red: keep today's rule.
         ATTR_OUT="${ATTR_OUT#ATTRCLOSED }"
         [ -n "$ATTR_OUT" ] || ATTR_OUT="helper produced no verdict"
         ATTR_OUT="ATTRCLOSED $ATTR_OUT"
         echo "ux-gate: journey attribution failed closed (${ATTR_OUT#ATTRCLOSED }); every reproduced red still convicts" ;;
    esac
    mkdir -p "$UXD/confirm"
    if [ -n "${RSI_UX_WALK_CMD:-}" ]; then
      bash -c "$RSI_UX_WALK_CMD" _ "$UXD/confirm" "$JOURNEYS" > "$UXD/confirm/walk.out" 2>&1; CRC=$?
    else
      bash "$RSI_DIR/runtime/ux-walk.sh" "$WT" "$UXD/confirm" "$JOURNEYS" > "$UXD/confirm/walk.out" 2>&1; CRC=$?
    fi
    CRSN=""; CHARD=""
    if [ -e "$UXD/confirm/UNAVAILABLE" ]; then CRSN="$(tr '\n' ' ' < "$UXD/confirm/UNAVAILABLE")"
    elif [ "${CRC:-0}" -eq 2 ]; then CRSN="walker exit 2"
    elif [ ! -s "$UXD/confirm/walk.json" ]; then CRSN="no confirm walk.json"
    else
      CHARD="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(d.get("hardFail",[])))' "$UXD/confirm/walk.json")" \
        || { CRSN="confirm walk.json unreadable"; CHARD=""; }
    fi
    # A confirm whose evidence cannot be parsed or decided keeps the first walk's red: an empty
    # CHARD would otherwise record every first-walk failure as flaked and could pass a real one.
    if [ -z "$CRSN" ]; then
      if [ -n "$CHARD" ] && [ -s "$KNOWN" ]; then
        CHARD="$(printf '%s\n' "$CHARD" | grep -v -F -f "$KNOWN" || true)"
      fi
      # 1b1. A hard-fail line only the confirm walk produced is a variant, and one confirm
      # sample must not convict it (R-ux-confirm-variant, 2026-11-24). #656's 06:29 confirm
      # walk invented `J9/mac: scroll-kept ... is at 2201, want 320±48` — a line the full-spec
      # first walk never produced, as its reproduced=0 proves (reproduced is the intersection)
      # — and the gate opened a fourth rework round for it while §1c called the first walk's
      # reds "not evidence" for the same run. A variant is now sampled once more on the same
      # tree through the same walker seam and the same selector: seen twice it convicts like a
      # reproduced red, seen once it is evidence (confirm.json variant=<n>, the summary's
      # variant=<n>, confirm.txt under a variant heading) and confirm.hard stays empty for it.
      # Fail closed: a second sample that cannot run — exit 2, no walk.json, an unreadable
      # walk.json — keeps the variant's conviction, never turns a red into "unavailable".
      # No second sample runs when the confirm produced no variant, so a reproduced red and a
      # green first walk keep their old cost.
      VAR_PENDING=""; VS="not-needed"; C2SN=""; CHARD2=""
      python3 - "$HARD" "$CHARD" "$ATTR_OUT" "$UXD/variant.pending" <<'PY'
import json, re, sys
orig = set(l for l in sys.argv[1].splitlines() if l)
raw = sys.argv[3].strip()
attr = None
if raw.startswith("ATTRJ="):
    attr = set(j for j in raw[len("ATTRJ="):].split(",") if j)
# The same two journey forms and the same in-scope rule as the decision below: a line that
# names no journey (kept and billed as before), or one on a journey this PR's diff cannot
# reach (recorded as outside), never needs a second sample. Spelled as two matches rather
# than the decision's one-liner so the sibling suite's mutant anchor stays unique.
def journey(line):
    m = re.match(r"^([A-Za-z0-9_]+)/", line)
    if m:
        return m.group(1)
    m = re.match(r"^(J[0-9]+)-", line)
    return m.group(1) if m else ""
def comparable(line):
    if ": rows " not in line or " are [" not in line or "], want [" not in line:
        return line
    head, rest = line.split(" are ", 1)
    marker = "], want ["
    mid = rest.find(marker)
    if mid < 0:
        return line
    try:
        are = json.loads(rest[:mid + 1])
        want = json.loads(rest[mid + len("], want "):])
    except (TypeError, ValueError):
        return line
    if not isinstance(are, list) or not isinstance(want, list):
        return line
    if any(not isinstance(token, str) or not token for token in want) or len(set(want)) != len(want):
        return line
    if any(i != j and token in other for i, token in enumerate(want) for j, other in enumerate(want)):
        return line
    order = []
    for row in are:
        if not isinstance(row, str):
            continue
        hits = [i for i, token in enumerate(want) if isinstance(token, str) and token in row]
        order.extend(hits)
    return head + " are <wanted-token-order " + json.dumps(order, separators=(",", ":")) + "> want " + json.dumps(want, ensure_ascii=False, separators=(",", ":"))
orig_keys = set(comparable(l) for l in orig)
with open(sys.argv[4], "w") as f:
    for line in sys.argv[2].splitlines():
        if not line or comparable(line) in orig_keys:
            continue
        j = journey(line)
        if j and (attr is None or j in attr):
            f.write(line + "\n")
PY
      PYRC=$?
      [ "$PYRC" -eq 0 ] || CRSN="variant scan failed"
      VAR_PENDING="$(cat "$UXD/variant.pending" 2>/dev/null || true)"
      if [ -z "$CRSN" ] && [ -n "$VAR_PENDING" ]; then
        mkdir -p "$UXD/confirm2"
        if [ -n "${RSI_UX_WALK_CMD:-}" ]; then
          bash -c "$RSI_UX_WALK_CMD" _ "$UXD/confirm2" "$JOURNEYS" > "$UXD/confirm2/walk.out" 2>&1; C2RC=$?
        else
          bash "$RSI_DIR/runtime/ux-walk.sh" "$WT" "$UXD/confirm2" "$JOURNEYS" > "$UXD/confirm2/walk.out" 2>&1; C2RC=$?
        fi
        VS="ok"
        if [ -e "$UXD/confirm2/UNAVAILABLE" ]; then VS="unavailable"; C2SN="$(tr '\n' ' ' < "$UXD/confirm2/UNAVAILABLE")"
        elif [ "${C2RC:-0}" -eq 2 ]; then VS="unavailable"; C2SN="walker exit 2"
        elif [ ! -s "$UXD/confirm2/walk.json" ]; then VS="unavailable"; C2SN="no second-sample walk.json"
        else
          CHARD2="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(d.get("hardFail",[])))' "$UXD/confirm2/walk.json")" \
            || { VS="unavailable"; C2SN="second-sample walk.json unreadable"; CHARD2=""; }
        fi
        if [ "$VS" = "ok" ] && [ -n "$CHARD2" ] && [ -s "$KNOWN" ]; then
          CHARD2="$(printf '%s\n' "$CHARD2" | grep -v -F -f "$KNOWN" || true)"
        fi
      fi
      if [ -z "$CRSN" ]; then
        # Written to a file rather than captured: macOS bash 3.2 lexes quotes inside a heredoc
        # nested in $( ), so a body comment with an apostrophe breaks the parse. A standalone
        # heredoc is literal and keeps the python readable.
        python3 - "$HARD" "$CHARD" "$JOURNEYS" "$UXD/confirm.txt" "$CONF_JSON" "$UXD/confirm.summary" "$UXD/confirm.hard" "$SHOTS/walk.json" "$SHOTS" "$UXD/green.txt" "$ATTR_OUT" "$UXD/outside.txt" "$VAR_PENDING" "$VS" "$CHARD2" "$C2SN" <<'PY'
import json, os, re, sys
orig = [l for l in sys.argv[1].splitlines() if l]
conf = [l for l in sys.argv[2].splitlines() if l]
def comparable(line):
    if ": rows " not in line or " are [" not in line or "], want [" not in line:
        return line
    head, rest = line.split(" are ", 1)
    marker = "], want ["
    mid = rest.find(marker)
    if mid < 0:
        return line
    try:
        are = json.loads(rest[:mid + 1])
        want = json.loads(rest[mid + len("], want "):])
    except (TypeError, ValueError):
        return line
    if not isinstance(are, list) or not isinstance(want, list):
        return line
    if any(not isinstance(token, str) or not token for token in want) or len(set(want)) != len(want):
        return line
    if any(i != j and token in other for i, token in enumerate(want) for j, other in enumerate(want)):
        return line
    order = []
    for row in are:
        if not isinstance(row, str):
            continue
        hits = [i for i, token in enumerate(want) if isinstance(token, str) and token in row]
        order.extend(hits)
    return head + " are <wanted-token-order " + json.dumps(order, separators=(",", ":")) + "> want " + json.dumps(want, ensure_ascii=False, separators=(",", ":"))
journeys = sys.argv[3]
# Which journeys this PR's diff can reach (1b0). Anything but a parsed set — including a helper
# that could not read the spec — keeps every reproduced red: fail closed, never free a red.
attr_raw = sys.argv[11].strip()
attr = None
if attr_raw.startswith("ATTRJ="):
    attr = set(j for j in attr_raw[len("ATTRJ="):].split(",") if j)
# The fail-closed reason travels into the summary so a reader can tell a copy-only diff from an
# unmapped page without opening the log.
if attr is None:
    attr_label = "fail-closed (%s)" % attr_raw[len("ATTRCLOSED "):] if attr_raw.startswith("ATTRCLOSED ") else "fail-closed"
else:
    attr_label = ",".join(sorted(attr, key=lambda j: (len(j), j)))
def journey(line):
    m = re.match(r"^([A-Za-z0-9_]+)/", line) or re.match(r"^(J[0-9]+)-", line)
    return m.group(1) if m else ""
def in_scope(line):
    return attr is None or journey(line) in attr
# 1b1. A hard-fail line only the confirm walk produced is a variant (the pending set the shell
# just computed and sampled again). Only one the second sample also produced survives into
# `conf`; one seen in a single sample is dropped here, so the unchanged `final` rule below stays
# the one definition of what bills. An unavailable second sample convicts every pending variant.
pending = [l for l in sys.argv[13].splitlines() if l]
vsample = sys.argv[14].strip()
seen2_keys = set(comparable(l) for l in sys.argv[15].splitlines() if l)
if vsample == "ok":
    variant_convicted = [l for l in pending if comparable(l) in seen2_keys]
    variant = [l for l in pending if comparable(l) not in seen2_keys]
else:
    # fail closed: an unavailable second sample keeps the variant conviction
    variant_convicted = list(pending)
    variant = []
pending_keys = set(comparable(l) for l in variant)
conf = [l for l in conf if comparable(l) not in pending_keys]
conf_keys = set(comparable(l) for l in conf)
reproduced = [l for l in orig if journey(l) and comparable(l) in conf_keys]
flaked = [l for l in orig if journey(l) and comparable(l) not in conf_keys]
unattributed = [l for l in orig if not journey(l)]
# A reproduced (or new) confirm failure on a journey this diff cannot reach is evidence, not a
# blocking reason: printed, saved to outside.txt and counted, exactly like the flaked list. A line
# that names no journey can never be attributed, so it stays in final.
outside = [l for l in conf if journey(l) and not in_scope(l)]
# The confirm walk's filtered lines are the surviving hard failures: the reproduced first-walk
# lines and the variants the second sample also produced. Unattributable first-walk lines stay.
final = [l for l in conf if in_scope(l) or not journey(l)] + unattributed
# §1c's flag, computed here so its invariant lives in one place: CONFIRM_ONLY requires an empty
# confirm.hard, so a confirmed variant (or an unattributable confirm line) can never coexist
# with "the first walk's reds are not evidence". The shell re-checks confirm.hard itself.
confirm_only = not reproduced and bool(flaked) and not final
with open(sys.argv[4], "w") as f:
    f.write("journeys=%s reproduced=%d flaked=%d outside=%d variant=%d attributed=%s\n"
            % (journeys, len(reproduced), len(flaked), len(outside), len(variant), attr_label))
    for l in flaked:
        f.write(l + "\n")
    if variant:
        f.write("variant (seen in one confirm sample only; not blocking):\n")
        for l in variant:
            f.write(l + "\n")
summary = ("walk confirm: re-walked %s once → reproduced=%d flaked=%d outside=%d variant=%d attributed=%s"
           % (journeys, len(reproduced), len(flaked), len(outside), len(variant), attr_label))
if pending:
    if vsample == "ok":
        summary += ("\nsecond sample: re-walked %s again → %d confirmed, %d seen once (not blocking)"
                    % (journeys, len(variant_convicted), len(variant)))
    else:
        summary += ("\nsecond sample: unavailable (%s) — variant lines kept"
                    % (sys.argv[16].strip() or "unknown"))
if flaked:
    summary += "\nflaked (failed the first walk, not reproduced; not blocking):\n" + "\n".join(flaked)
if variant:
    summary += "\nvariant (seen in one confirm sample only; not blocking):\n" + "\n".join(variant)
if outside:
    summary += "\noutside this PR's surfaces (evidence, not blocking):\n" + "\n".join(outside)
open(sys.argv[6], "w").write(summary + "\n")
doc = {"journeys": journeys, "reproduced": len(reproduced), "flaked": len(flaked),
       "outside": len(outside), "variant": len(variant),
       "variant_confirmed": len(variant_convicted),
       "variant_sample": vsample if pending else "not-needed",
       "confirm_only": confirm_only, "attributed": attr_label}
if pending and vsample != "ok":
    doc["variant_unavailable"] = sys.argv[16].strip() or "unavailable"
json.dump(doc, open(sys.argv[5], "w"))
open(sys.argv[7], "w").write("\n".join(final) + ("\n" if final else ""))
open(sys.argv[12], "w").write("\n".join(outside) + ("\n" if outside else ""))
# R-ux-confirm-evidence: the confirm walk only re-walks the journeys its red named, so the
# reviewer also needs the first walk's screens for the journeys that stayed green. Same journey()
# regex as the decision above, so both agree on what "this journey was named" means. Written only
# in the flaked-only state (reproduced=0 and flaked>0) — the state §1c marks CONFIRM_ONLY — so
# every other run leaves the file empty and the prompt unchanged. Line 1: journey ids, line 2:
# their first-walk pngs. No first-walk hardFail line is ever copied here: those are the flakes.
greens = []
if not reproduced and flaked:
    named = set(journey(l) for l in flaked)
    try:
        first = json.load(open(sys.argv[8], errors="replace"))
    except (OSError, ValueError):
        first = {}
    screens = first.get("screens") if isinstance(first, dict) else None
    for screen in screens if isinstance(screens, list) else []:
        j = screen.get("journey") if isinstance(screen, dict) else ""
        if isinstance(j, str) and re.match(r"^J[0-9]+$", j) and j not in named and j not in greens:
            greens.append(j)
    pngs = []
    try:
        names = os.listdir(sys.argv[9])
    except OSError:
        names = []
    for f in sorted(names):
        if f.endswith(".png") and any(f.startswith(g + "-") for g in greens):
            pngs.append(os.path.join(sys.argv[9], f))
    open(sys.argv[10], "w").write(" ".join(greens) + "\n" + " ".join(pngs) + "\n")
else:
    open(sys.argv[10], "w").write("\n\n")
PY
        PYRC=$?
        [ "$PYRC" -eq 0 ] || CRSN="confirm decision failed"
      fi
    fi
    if [ -z "$CRSN" ]; then
      HARD="$(cat "$UXD/confirm.hard")"
      CONF_SUMMARY="$(cat "$UXD/confirm.summary")"
      # The summary already carries the outside lines; printing them again here duplicated the
      # block on stdout (the `ux-gate:` line below prints it once).
    else
      # Never unavailable() from here: the first walk already produced a verdict, and an infra
      # hiccup on the second must not turn a red into "not merged / needs-ceo".
      CONF_SUMMARY="walk confirm: unavailable (${CRSN% }) — first-walk failures kept"
    fi
    printf 'ux-gate: %s\n' "$CONF_SUMMARY"
  fi
fi
# 1c. When the confirm walk reproduced nothing, its evidence is the only evidence about this
# PR (R-ux-gate-confirm-carry, 2026-11-19). #389's first walk hard-failed 33 lines, the confirm
# walk on the same tree reproduced 0, and the reviewer still scored density=2 feedback=2 off the
# flaked first-walk screenshots: a below-3 verdict, a rework round and a block for evidence the
# gate had just disproved. CONFIRM_ONLY marks that state: §2 points the reviewer at
# $UXD/confirm and names the flakes as not evidence, and §2c grounds a below-3 axis in that walk
# or records no verdict. Every other state (reproduced > 0, no confirm.json, flaked == 0) keeps
# today's path exactly.
CONFIRM_ONLY=0
# Only a confirm decision that completed sets the flag: a partial write can leave
# confirm.json behind while the first walk's HARD is kept (CRSN set), and that state
# must not both bill those lines and call them not evidence. The decision's own
# confirm_only also requires an empty final, and the confirm.hard test repeats that
# here: CONFIRM_ONLY must never coexist with a conviction (R-ux-confirm-variant).
if [ -s "$CONF_JSON" ] && [ ! -s "$UXD/confirm.hard" ] && [ -z "${CRSN:-}" ]; then
  if python3 - "$CONF_JSON" >/dev/null 2>&1 <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("confirm_only") else 1)
PY
  then CONFIRM_ONLY=1; fi
fi
# 1d. The union evidence set (R-ux-confirm-evidence, 2026-11-20). #467: the first walk walked
# J1/J11/J12 green, the confirm re-walk reproduced nothing, and the stricter rule below then
# judged all five axes off the one journey whose screens the confirm walk re-took. In
# CONFIRM_ONLY the evidence is the union, attributed per journey: the confirm screens for the
# journeys it re-walked, and the first walk's screens for the journeys its red did not name
# (green.txt, written by the confirm decision above with the same journey() regex). The flaked
# journey's first-walk screens and every first-walk hard-fail line stay out.
GREEN=""; GREEN_SHOTS=""; CONF_SHOTS=""
if [ "$CONFIRM_ONLY" = 1 ]; then
  CONF_SHOTS="$(ls "$UXD/confirm"/*.png 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
  if [ -s "$UXD/green.txt" ]; then
    GREEN="$(sed -n 1p "$UXD/green.txt")"
    GREEN_SHOTS="$(sed -n 2p "$UXD/green.txt")"
  fi
fi
# A below-3 axis in the CONFIRM_ONLY state must be grounded in the evidence the reviewer was
# handed: a screenshot file under $UXD/confirm, or a line from confirm/walk.json — and, for the
# journeys the confirm walk did not re-walk, a first-walk screenshot or screen (§1d). Never a
# first-walk hardFail line: in this state those are the flakes. The axis word on the machine
# `UX_SCORES:` line never counts, same rule as ungrounded_axes. accepts_review keeps
# ungrounded_axes: merge.sh reuses a cached review with the same CLI and semantics as before.
ungrounded_axes_confirm() { # <review-file> <confirm-dir> [first-walk-dir] [green journeys]
  python3 - "$1" "$2" "${3:-}" "${4:-}" <<'PY'
import json, os, re, sys
txt = open(sys.argv[1], errors="replace").read()
cdir, fdir = sys.argv[2], sys.argv[3]
green = set(sys.argv[4].split())
axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
m = re.findall(r"UX_SCORES:\s*(.+)", txt)
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]):
        sc[k] = int(v)
tokens = []
for root, _dirs, files in os.walk(cdir):
    for f in files:
        if f.endswith(".png"):
            tokens.append(f)
# Ground on walk.json's parsed values, not its source lines: the walker writes
# JSON.stringify(..., null, 1), so each value arrives quoted and escaped and a finding
# that quotes the same failure in plain text could never match it. The values a finding
# can legitimately quote are the hard-failure lines, each screen's screenshot name and
# notes, and its lint readings (as key=value, so a bare number cannot ground any line).
def _walk(path):
    try:
        d = json.load(open(path, errors="replace"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}
def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)
def _screen_tokens(screens, keep=None):
    out = []
    for screen in screens if isinstance(screens, list) else []:
        if not isinstance(screen, dict):
            continue
        if keep is not None and screen.get("journey") not in keep:
            continue
        for t in _strings([screen.get("name"), screen.get("notes")]):
            if t.strip():
                out.append(t)
        lint = screen.get("lint")
        if isinstance(lint, dict):
            out.extend("%s=%s" % (k, json.dumps(v)) for k, v in lint.items())
    return out
walk = _walk(os.path.join(cdir, "walk.json"))
for t in _strings(walk.get("hardFail")):
    if t.strip():
        tokens.append(t)
tokens.extend(_screen_tokens(walk.get("screens")))
# §1d's union: the first walk's screenshots for the journeys the confirm walk did not re-walk
# stay evidence. Hard-fail lines from that walk are deliberately absent — they are the flakes.
if green and fdir:
    try:
        names = os.listdir(fdir)
    except OSError:
        names = []
    for f in names:
        if f.endswith(".png") and any(f.startswith(g + "-") for g in green):
            tokens.append(f)
    tokens.extend(_screen_tokens(_walk(os.path.join(fdir, "walk.json")).get("screens"), green))
def grounded(line):
    return any(tok in line for tok in tokens)
gaps = []
for a in axes:
    if a not in sc or sc[a] >= 3:
        continue
    found = False
    for line in txt.splitlines():
        if re.match(r"^\s*[-*_>#]*\s*UX_(SCORES|VERDICT):", line):
            continue
        if re.search(r"(?i)\b%s\b" % a, line) and grounded(line):
            found = True
            break
    if not found:
        gaps.append(a)
print(",".join(gaps))
PY
}
ground_gaps() { # <review-file> -> below-3 axes not grounded in the evidence the reviewer was told to use
  if [ "$CONFIRM_ONLY" = 1 ]; then ungrounded_axes_confirm "$1" "$UXD/confirm" "$SHOTS" "$GREEN"; else ungrounded_axes "$1"; fi
}
# 2. vision review
BASELINE="$STATE/shots/baseline"   # walk of the installed build before the programme (empty daemon); refresh with ux-walk.sh on current main
APPROVED_PROTO="$STATE/ux-proto/final"
BODY="$($GH pr view "$N" --repo "$GH_REPO" --json body --jq .body 2>/dev/null | head -c 3000 | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
PR_SHOTS="$(ls "$STATE/shots/$SLUG"/*.png 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
PF="$STATE/briefs/$SLUG-ux-review.md"; mkdir -p "$STATE/briefs"
# A confirm-only run's evidence is §1d's union; every other run keeps $SHOTS.
EVID="$SHOTS"; [ "$CONFIRM_ONLY" = 1 ] && EVID="$UXD/confirm"
EVID_MORE=""; GREEN_REASK=""
if [ "$CONFIRM_ONLY" = 1 ] && [ -n "$GREEN" ]; then
  EVID_MORE=" The first walk's screenshots for journeys with no surviving failure ($GREEN) are also evidence: $GREEN_SHOTS (their names, notes and lint are in $SHOTS/walk.json)."
  GREEN_REASK=" and the first walk's screenshots for the journeys with no surviving failure ($GREEN): $GREEN_SHOTS"
fi
{
  echo "You are the UX REVIEWER (read-only) for PR #$N (item $ITEM, branch rsi/$SLUG, worktree $WT). The worker was a different model."
  echo "Follow $RSI_DIR/roles/ux-reviewer.md and the rubric in $RSI_DIR/UX-RUBRIC.md EXACTLY. Do not run builds or tests."
  echo "Evidence you MUST open with the Read tool (images are viewable): the walk screenshots in $EVID (names are <journey>-<viewport>-<n>-<step>.png; the matching .aria.txt is the accessibility tree), and $EVID/walk.json (objective lint per screen: small tap targets, search boxes, overflow, console errors).${EVID_MORE}"
  [ -n "$PR_SHOTS" ] && echo "PR feature screenshots captured at 390x844 and 1100x760 (MUST also open with the Read tool, especially when a sub-surface such as workspace diffs or filtered states is not seeded in the generic journey walk): $PR_SHOTS"
  echo "Compare against: the BEFORE screenshots in $BASELINE (same names where they exist; the installed build before this programme) and the target prototype in $APPROVED_PROTO (the clickable shell Ethan approved; the product should converge on it, not on the old UI)."
  echo "Look at the attached diff only to explain what you see (do not run git/shell; the diff is provided). What the PR claims: $BODY"
  [ -n "$HARD" ] && { echo; echo "Walk hard failures (each is an automatic reject unless you can show it is a walker artefact):"; echo "$HARD"; }
  [ -n "$UX_IGNORED" ] && { echo; echo "Known walk artefacts ignored for this run (pre-existing fixture gap, not a defect of this PR; still report it as 'not verifiable: needs seed data'):"; echo "$UX_IGNORED"; }
  # Outside lines stay in $EVID/walk.json (hardFail) and $SHOTS, so the reviewer can still see
  # them; without this block it could ground a below-3 axis on a red the gate already ruled out
  # of this PR's scope and send the PR back anyway (the #389 / R-ux-gate-confirm-carry class).
  if [ -s "$UXD/outside.txt" ]; then
    echo
    echo "These reproduced failures are on journeys outside this PR's surfaces: evidence about the product, not about this PR. Do not score an axis below 3 on them, do not treat them as hard failures, and do not ground a finding in their screenshots or walk.json lines:"
    sed 's/^/  - /' "$UXD/outside.txt"
  fi
  if [ "$CONFIRM_ONLY" = 1 ]; then
    echo
    echo "A second walk on the same tree did not reproduce these first-walk failures, so they are not evidence about this PR — do not score or ground an axis on them:"
    # The flaked lines only: confirm.txt's variant section (1b1) is a different list and must
    # not be read as an unreproduced first-walk failure.
    awk 'NR > 1 && /^variant \(/ { exit } NR > 1' "$UXD/confirm.txt" 2>/dev/null
    echo "The confirm walk re-walked ${JOURNEYS:-the flaked journeys}; its screenshots are the evidence for those journeys: ${CONF_SHOTS:-none recorded} (names, notes and lint in $UXD/confirm/walk.json)."
    if [ -n "$GREEN" ]; then
      echo "The journeys with no surviving failure ($GREEN) were not re-walked; their first-walk screenshots named above remain evidence for them (names, notes and lint in $SHOTS/walk.json)."
    fi
    echo "A below-3 axis must cite one of those files or a line from one of those walk.json files; a finding grounded only in the flakes above is not a verdict."
  fi
  echo "Note: a throwaway daemon may be EMPTY (see $EVID/seed.log); then judge empty/loading states and structure, and say 'not verifiable: needs seed data' for what you cannot see. Never invent what the screen shows."
  echo
  echo "Output format (last lines, exactly): "
  echo "UX_SCORES: clarity=N density=N consistency=N feedback=N keyboard=N      (integers 1-5; 3 = acceptable, 5 = as good as T3 Code)"
  echo "UX_VERDICT: PASS or FAIL"
  echo "Before those lines list concrete findings: screen name, what is wrong, how it affects which journey, the fix. Quote screenshot names."
  echo "For every axis you score below 3, write a finding line that STARTS with the axis name (e.g. \`feedback: after-wait-390.png ...\`) and names the screenshot plus what is missing. That line becomes the rework instruction; a below-3 score with no such line is not a verdict."
  echo "A claim about a control's size or tap target must quote a MEASUREMENT that is in the evidence: a walk.json lint reading (e.g. smallTapTargets), or a measured box the PR records. A Tailwind/CSS class name is NOT a measurement — a class is overridden by min-width/min-height rules and media queries, so it does not tell you what was rendered. If a class name is the only support for a size claim, write 'not measurable from the evidence' and do not score that axis below 3 for it."
} > "$PF"
UXR="$UXD/review.txt"
SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null || true)"
UROLE="ux-reviewer"; [ "$ROLE" = "reviewer-alt" ] && UROLE="ux-reviewer-alt"
run_review() { # <prompt-file> <out-file> [fresh] -> DRC; fresh=1 never reuses the cached strong UX review
  if [ -n "${RSI_UX_REVIEW_CMD:-}" ]; then bash -c "$RSI_UX_REVIEW_CMD" _ "$1" > "$2" 2>&1; DRC=$?
  elif [ "${3:-}" != fresh ] && [ -n "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux" ] && [ "$(awk '{print $1}' "$STATE/merge/$SLUG.strong-ux")" = "$SHA" ] && [ -s "$STATE/merge/$SLUG.strong-ux.txt" ]; then
    echo "ux-gate: reuse strong UX review for ${SHA:0:8} (verdict=$(awk '{print $2}' "$STATE/merge/$SLUG.strong-ux"))"
    cp "$STATE/merge/$SLUG.strong-ux.txt" "$2"; DRC=0
  elif python3 "$RSI_DIR/runtime/escalate.py" --no-strong-available >/dev/null 2>&1; then
    unavailable "ux reviewer held: no strong reviewer available (Hydrogen/sol limited)"
  else
    # A fresh pass must be a real second opinion. dispatch.sh's escalate --check reuses the
    # strong-ux cache the first call just wrote for this same SHA (dispatch.sh:354-377), so the
    # reviewer would never be called again and every ungrounded score would end as unavailable
    # without a real re-ask. Drop it first; the re-ask's stamp_review rewrites it.
    [ "${3:-}" = fresh ] && rm -f "$STATE/merge/$SLUG.strong-ux" "$STATE/merge/$SLUG.strong-ux.txt"
    RSI_ITEM="$ITEM" RSI_NO_HEAVY=1 BUDGET_GUARD=8 DISPATCH_MAX_SECS=1500 "$RSI_DIR/runtime/dispatch.sh" "$UROLE" "$WT" "$1" "merge-$SLUG-ux" > "$2" 2>&1; DRC=$?
    [ "${DRC:-0}" -eq 3 ] && unavailable "ux reviewer held: no strong reviewer available (dispatch hold)"
  fi
  return "${DRC:-0}"
}
run_review "$PF" "$UXR"; DRC=$?
[ "${DRC:-0}" -ne 0 ] && ! grep -qE 'UX_SCORES:' "$UXR" 2>/dev/null && unavailable "ux reviewer unavailable: dispatch exit $DRC"
# 2c. Grounding is decided by `ground_gaps`: the shared `ungrounded_axes` rule, or the stricter
# confirm-evidence rule when the confirm walk reproduced nothing. `GAPS` is the axes < 3 that no
# finding line grounds. A flaked-only red is handled like an ungrounded axis — re-ask once, then
# "no verdict" — never a sendback and never a merge.
GAPS="$(ground_gaps "$UXR" 2>/dev/null)" || unavailable "grounding check failed; no verdict"
UX_REASKED=0; export UX_REASKED
if [ -n "$GAPS" ]; then
  echo "ux-gate: reviewer scored $GAPS below 3 without naming it in a finding — re-asking once"
  UXR2="$UXD/review.2.txt"; rm -f "$UXR2"
  { cat "$PF"; echo; echo "--- second pass ---"; \
    if [ "$CONFIRM_ONLY" = 1 ]; then
      echo "Your previous answer scored $GAPS below 3, but it grounds that score only in failures the confirm walk could not reproduce. Those are not evidence about this PR. Re-answer this review from the evidence this PR is judged on: the confirm walk's screenshots ($UXD/confirm)${GREEN_REASK}."
      echo "These are the first-walk failures the second walk on the same tree did not reproduce:"; awk 'NR > 1 && /^variant \(/ { exit } NR > 1' "$UXD/confirm.txt" 2>/dev/null
    else
      echo "Your previous answer scored $GAPS below 3, but its findings never name that axis. Re-answer this review."
    fi; \
    echo "For every axis you score below 3, write one finding line that STARTS with the axis name, names the screenshot file, and says what is missing or wrong. If you cannot point at the evidence, raise the score to 3."; \
    echo "Keep the last two lines exactly UX_SCORES: ... and UX_VERDICT: ..."; echo; echo "Your previous answer:"; cat "$UXR"; } > "$PF.2"
  run_review "$PF.2" "$UXR2" fresh || true
  if grep -qE 'UX_SCORES:' "$UXR2" 2>/dev/null; then cp "$UXR2" "$UXR"; UX_REASKED=1; export UX_REASKED; fi
  GAPS="$(ground_gaps "$UXR" 2>/dev/null)" || unavailable "grounding check failed after the re-ask; no verdict"
  if [ -n "$GAPS" ]; then
    [ "$UX_REASKED" = 1 ] \
      && unavailable "reviewer scored $GAPS below 3 without naming the evidence (asked twice); no verdict" \
      || unavailable "reviewer scored $GAPS below 3 and the re-ask produced no review; no verdict"
  fi
fi
# 3. decide (recomputed from the numbers; the model's own verdict only matters as a tie to the text)
python3 - "$UXR" "$UXD/scores.json" "$ERR" "$SHOTS" "$HARD" "$CONF_JSON" "$CONF_SUMMARY" <<'PY'
import os, re, sys, json
txt = open(sys.argv[1], errors="replace").read(); out, err, shots, hard = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
conf_json, conf_summary = sys.argv[6], sys.argv[7]
m = re.findall(r"UX_SCORES:\s*(.+)", txt); axes = ["clarity", "density", "consistency", "feedback", "keyboard"]
sc = {}
if m:
    for k, v in re.findall(r"(\w+)\s*=\s*([1-5])\b", m[-1]): sc[k] = int(v)
vm = re.findall(r"UX_VERDICT:\s*(PASS|FAIL)", txt); verdict = vm[-1] if vm else "NONE"
ok = all(a in sc for a in axes)
mean = sum(sc[a] for a in axes) / 5 if ok else 0
reasons = []
if not ok: reasons.append("reviewer gave no complete UX_SCORES line (need clarity, density, consistency, feedback, keyboard)")
else:
    low = [a for a in axes if sc[a] < 3]
    if low: reasons.append("axis below 3: " + ", ".join("%s=%d" % (a, sc[a]) for a in low))
    if mean < 3.5: reasons.append("mean %.1f < 3.5" % mean)
if hard.strip(): reasons.append("walk hard failures:\n" + hard)
if verdict == "FAIL" and not reasons: reasons.append("reviewer verdict FAIL (see findings)")
doc = {"scores": sc, "mean": round(mean, 2), "verdict": verdict, "pass": not reasons, "reasons": reasons,
       "reasked": os.environ.get("UX_REASKED") == "1"}
try:
    doc["walk_confirm"] = json.load(open(conf_json))
except Exception:
    pass
json.dump(doc, open(out, "w"), indent=1)
if reasons:
    conf = ("\n" + conf_summary.rstrip() + "\n") if conf_summary.strip() else ""
    with open(err, "w") as f:
        f.write("=== UX GATE FAILED ===\n" + "\n".join(reasons) + "\n" + conf + "\nScreenshots: " + shots + "\nReviewer findings (tail):\n" + txt[-5000:])
    sys.exit(1)
PY
rc=$?
rm -f "$COOL"   # a complete outcome (PASS or FAIL) ends the cooldown; only unavailable keeps it
[ $rc -eq 0 ] && exit 0
exit 1
