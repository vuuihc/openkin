#!/usr/bin/env python3
"""UI-inconsistency ratchet. Counts come from scripts/ui_inventory.py; they may only go down.
  ratchet.py init   <worktree>   write baseline from <worktree>
  ratchet.py check  <worktree>   exit 1 if any tracked count is above baseline
  ratchet.py update <worktree>   lower the baseline to current (never raises it)
Baseline: rsi/state/ratchet.json (local, gitignored)."""
import json, os, re, subprocess, sys
mode, wt = sys.argv[1], os.path.abspath(sys.argv[2])
here = os.path.dirname(os.path.abspath(__file__))
base_path = os.path.join(here, "..", "state", "ratchet.json")
TRACK = {"裸 <button": "raw_button", "<input": "raw_input", "role=\"dialog\"": "role_dialog", "createPortal": "create_portal", "rounded-* + border 表面": "rounded_border_surface"}
def measure():
    out = subprocess.run(["python3", "scripts/ui_inventory.py"], cwd=wt, capture_output=True, text=True).stdout
    res = {}
    for line in out.splitlines():
        m = re.match(r"\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", line)
        if m and m.group(1) in TRACK:
            res[TRACK[m.group(1)]] = int(m.group(2))
    return res
cur = measure()
if not cur:
    print("RATCHET_ERROR: could not read ui_inventory output"); sys.exit(2)
os.makedirs(os.path.dirname(base_path), exist_ok=True)
if mode == "init" or not os.path.exists(base_path):
    json.dump(cur, open(base_path, "w"), indent=1); print("RATCHET baseline", cur); sys.exit(0)
base = json.load(open(base_path))
worse = {k: (base.get(k), v) for k, v in cur.items() if k in base and v > base[k]}
if mode == "update":
    for k, v in cur.items():
        base[k] = min(base.get(k, v), v)
    json.dump(base, open(base_path, "w"), indent=1); print("RATCHET updated", base); sys.exit(0)
print("RATCHET current", cur, "baseline", base)
if worse:
    print("RATCHET_FAIL increased (baseline,current):", worse); sys.exit(1)
print("RATCHET_PASS"); sys.exit(0)
