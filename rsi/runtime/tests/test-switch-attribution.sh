#!/bin/bash
# test-switch-attribution.sh — the area switch's split must be printed, and never faked.
#
# `switch-latency.mjs --print` is the claim check for docs/plans/2026-11-20-switch-latency.md:
# the document's numbers have to be readable back from the JSON without a daemon or a
# browser. That makes the printer the place where a half-measured run must stay visible:
#
#   - a leg whose runs all attributed prints the nearest-rank split per phase;
#   - a partly attributed leg says `attributed n/N (k unmeasured)` and never prints a
#     split over more runs than it names;
#   - a leg with no attributed run prints `attributed 0/N (<reason>)` and no phase line
#     at all, so a run that could not split cannot be read as a fast read or a fast render;
#   - a guard JSON still exits 2 with its recorded guard, never a table;
#   - a JSON from before attribution existed prints table 1 byte for byte as it did;
#   - `legs-resolve-area-tokens`: every `[data-area="X"]` a leg clicks or waits for is an
#     `id:` in ui/src/lib/areas.ts, and `mac-area-to-area` clicks something, names a read
#     (`/api/...`), and ends its destination on the page's own content rather than on the
#     nav's `aria-current` alone. A leg that measures a retired area proves nothing.
#
# Nearest-rank p50/p90 are computed by hand from the fixture runs, not by calling the
# script's stats(): with 5 runs p50 is the 3rd smallest and p90 the 5th.
#
# Hermetic: bash + node only, fixtures in a mktemp dir. No daemon, no browser, no
# network, no rsi/state. Prints "PASS <case>" per case; every case runs even when an
# earlier one fails, and the exit status is non-zero if any did.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$ROOT/rsi/runtime/ux/switch-latency.mjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

FAILED=0
CASE_FAILED=0
name=""
fail() { echo "FAIL $name: $*" >&2; CASE_FAILED=1; FAILED=1; }
start() { name="$1"; CASE_FAILED=0; echo "CASE $name"; }
finish() {
  if [ "$CASE_FAILED" -eq 0 ]; then echo "PASS $name"; else echo "FAIL $name" >&2; fi
}
# print_json <fixture> — run the claim check; stdout/stderr land in $T/out, $T/err.
print_json() {
  node "$SCRIPT" --print "$1" > "$T/out" 2> "$T/err"
  status=$?
}
expect_contains() { grep -Fq -- "$1" "$T/out" || fail "output does not contain: $1"; }
expect_absent() { if grep -Fq -- "$1" "$T/out"; then fail "output must not contain: $1"; fi; }
expect_status() { [ "$status" -eq "$1" ] || fail "exit $status, want $1 (stderr: $(cat "$T/err"))"; }

# --- 1. a fully attributed leg prints the exact nearest-rank split -------------------------------
# dispatch [3,4,5,6,7] -> p50 5, p90 7; read [50,55,60,65,70] -> p50 60, p90 70;
# render [20,25,30,35,40] -> p50 30, p90 40. Totals are the per-run sums.
start "attributed-split-prints"
cat > "$T/all.json" <<'EOF'
{"schema": 1, "sha": "aaaaaaa", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 5,
      "dispatch": {"runs": [3, 4, 5, 6, 7], "p50": 5, "p90": 7, "min": 3, "max": 7},
      "read": {"runs": [50, 55, 60, 65, 70], "p50": 60, "p90": 70, "min": 50, "max": 70},
      "render": {"runs": [20, 25, 30, 35, 40], "p50": 30, "p90": 40, "min": 20, "max": 40},
      "unattributed": []}}
}}
EOF
print_json "$T/all.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 5/5 dispatch p50 5 p90 7 · read p50 60 p90 70 · render p50 30 p90 40"
expect_absent "unmeasured"
finish

# --- 2. a partly attributed leg names the shortfall and splits only over the measured runs -------
# Run 3 is unattributed; dispatch [3,4,6,7] -> p50 4, p90 7; read [50,55,65,70] -> p50 55, p90 70;
# render [20,25,35,40] -> p50 25, p90 40.
start "partial-attribution-is-honest"
cat > "$T/partial.json" <<'EOF'
{"schema": 1, "sha": "bbbbbbb", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 4,
      "dispatch": {"runs": [3, 4, 6, 7], "p50": 4, "p90": 7, "min": 3, "max": 7},
      "read": {"runs": [50, 55, 65, 70], "p50": 55, "p90": 70, "min": 50, "max": 70},
      "render": {"runs": [20, 25, 35, 40], "p50": 25, "p90": 40, "min": 20, "max": 40},
      "unattributed": [{"run": 3, "reason": "no /api/projects resource entry after the press"}]}}
}}
EOF
print_json "$T/partial.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 4/5 (1 unmeasured) dispatch p50 4 p90 7 · read p50 55 p90 70 · render p50 25 p90 40"
finish

# --- 3. no attributed run prints the reason and no phase numbers --------------------------------
start "no-attribution-prints-no-split"
cat > "$T/none.json" <<'EOF'
{"schema": 1, "sha": "ccccccc", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 0, "reason": "no /api/projects resource entry after the press"}},
  "mac-chat-to-chat": {"viewport": "1100x760", "p50": 55, "p90": 70, "min": 40, "max": 70, "runs": [40, 50, 55, 60, 70],
    "attribution": {"total": 5, "attributed": 0, "reason": "no data read named for this leg"}}
}}
EOF
print_json "$T/none.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 0/5 (no /api/projects resource entry after the press)"
expect_contains "attr mac-chat-to-chat attributed 0/5 (no data read named for this leg)"
expect_absent "dispatch p50"
finish

# --- 4. a guard JSON is not a table -------------------------------------------------------------
start "guard-fixture-exits-2"
cat > "$T/guard.json" <<'EOF'
{"schema": 1, "sha": "ddddddd", "runs": 5, "legs": {}, "guard": {"code": "a", "name": "destination-never-appeared", "detail": "the destination never became visible"}}
EOF
print_json "$T/guard.json"
expect_status 2
grep -Fq "this JSON recorded a guard, not numbers:" "$T/err" || fail "stderr does not name the guard: $(cat "$T/err")"
finish

# --- 5. a JSON from before attribution still prints table 1 unchanged ---------------------------
start "legacy-json-table-unchanged"
cat > "$T/legacy.json" <<'EOF'
{"schema": 1, "sha": "eeeeeee", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116]}
}}
EOF
print_json "$T/legacy.json"
expect_status 0
expect_contains "switch latency — eeeeeee · 5 measured runs + 1 warm-up per leg · nearest-rank p50/p90 · ms"
# The table's column layout is its public shape: 21 + 12 + 6 + 8 + 8 + 8.
expect_contains "$(printf '%-21s%-12s%6s%8s%8s%8s' 'mac-area-to-area' '1100x760' 95 116 73 116)"
expect_contains "runs mac-area-to-area: 73, 84, 95, 106, 116"
expect_contains "loadavg before 0.5 0.6 0.7 · after 0.5 0.6 0.7 (1m 5m 15m)"
expect_absent "attr "
finish

# --- 6. every leg's area tokens resolve, and the area leg gates on content ----------------------
# The legs are read from the script's own LEGS block, never from a copy: a leg that
# clicks a retired area (projects) or waits only for the nav's aria-current measures
# nothing on screen. This case is RED on a tree whose area leg still names projects.
start "legs-resolve-area-tokens"
cat > "$T/legs-check.mjs" <<'EOF'
import fs from 'node:fs';
const [scriptPath, areasPath] = process.argv.slice(2);
const fail = (why) => { console.error(why); process.exit(1); };
const src = fs.readFileSync(scriptPath, 'utf8');
const at = src.indexOf('const LEGS = [');
const end = at < 0 ? -1 : src.indexOf('\n];', at);
if (at < 0 || end < 0) fail('switch-latency.mjs has no LEGS block');
const legs = src.slice(at, end + 3);

const areaIds = [...fs.readFileSync(areasPath, 'utf8').matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
if (!areaIds.length) fail(`no area ids parsed from ${areasPath}`);
const tokens = [...new Set([...legs.matchAll(/\[data-area="([^"]+)"\]/g)].map((m) => m[1]))];
if (!tokens.length) fail('no [data-area="X"] token in the LEGS block');
for (const token of tokens) {
  if (!areaIds.includes(token)) fail(`leg area token "${token}" is not an id in areas.ts (have ${areaIds.join(', ')})`);
}

const legAt = legs.indexOf("name: 'mac-area-to-area'");
if (legAt < 0) fail('no mac-area-to-area leg');
const rest = legs.slice(legAt);
const next = rest.indexOf("name: '", 1);
const leg = next >= 0 ? rest.slice(0, next) : rest;

const literal = (m) => (m ? (m[1] ?? m[2]) : '');
const click = literal(leg.match(/\bclick:\s*(?:'([^']*)'|"([^"]*)")/));
if (!click.trim()) fail('mac-area-to-area has no click selector');

// Scan the destination array with quote and bracket awareness: `]` inside
// `[data-area="..."]` closes neither the selector nor the array.
const destAt = leg.indexOf('destination:');
const open = destAt < 0 ? -1 : leg.indexOf('[', destAt);
if (open < 0) fail('mac-area-to-area has no destination list');
const skip = (s, i) => {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j += 1; continue; }
    if (s[j] === q) return j;
  }
  return s.length - 1;
};
let depth = 0, close = -1;
for (let i = open; i < leg.length; i++) {
  const ch = leg[i];
  if (ch === "'" || ch === '"') { i = skip(leg, i); continue; }
  if (ch === '[') depth += 1;
  else if (ch === ']' && --depth === 0) { close = i; break; }
}
if (close < 0) fail('mac-area-to-area destination list is unterminated');
const body = leg.slice(open + 1, close);
const entries = [];
for (let i = 0; i < body.length; i++) {
  const ch = body[i];
  if (ch !== "'" && ch !== '"') continue;
  const endq = skip(body, i);
  entries.push(body.slice(i + 1, endq));
  i = endq;
}
if (!entries.length) fail('mac-area-to-area destination list is empty');
const last = entries[entries.length - 1].trim();
if (/^\[data-area="[^"]+"\]\[aria-current="page"\]$/.test(last)) {
  fail(`mac-area-to-area's last destination is only the nav state, not the page's content: ${last}`);
}

const dataPath = literal(leg.match(/\bdataPath:\s*(?:'([^']*)'|"([^"]*)")/));
if (!dataPath.startsWith('/api/')) fail(`mac-area-to-area names no /api/ dataPath (got "${dataPath}")`);
console.log(`area tokens ${tokens.join(', ')} · click ${click} · destination gate ${last} · read ${dataPath}`);
EOF
status=0
node "$T/legs-check.mjs" "$SCRIPT" "$ROOT/ui/src/lib/areas.ts" > "$T/out" 2> "$T/err" || status=$?
expect_status 0
finish

if [ "$FAILED" -ne 0 ]; then echo "switch-attribution: failed" >&2; exit 1; fi
echo "ok switch-attribution (6 cases)"
