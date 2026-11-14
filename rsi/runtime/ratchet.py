#!/usr/bin/env python3
"""UI-inconsistency ratchet.

The durable contract is `scripts/check-ui-inventory.py` plus its checked-in
`scripts/ui-inventory-baseline.json`: it measures occurrences and files for
every metric, fails closed on a missing or malformed baseline, and rewrites
the baseline only through an explicit `--update`.

    ratchet.py check  <worktree>   exit nonzero when the inventory grew
    ratchet.py update <worktree>   rewrite the durable baseline from the tree
    ratchet.py init   <worktree>   same as update (first-generation spelling)

The checker is used whenever the target worktree carries it; a missing
baseline is not a reason to fall back, because the checker already fails
closed on one. A tree that predates the checker (for example an unmodified
`origin/main`) falls back to the first-generation measurement in
`scripts/ui_inventory.py` and the local, gitignored, lower-only
`rsi/state/ratchet.json`. That fallback cannot see file counts or the
standalone `kin-btn` row and its `update` still uses `min`; it exists only so
old trees stay checkable and is never used once the checker lands.
"""
import json
import os
import re
import subprocess
import sys

CHECKER = "scripts/check-ui-inventory.py"
DURABLE_BASELINE = "scripts/ui-inventory-baseline.json"

HERE = os.path.dirname(os.path.abspath(__file__))
LEGACY_BASELINE = os.path.normpath(os.path.join(HERE, "..", "state", "ratchet.json"))
LEGACY_INVENTORY = "scripts/ui_inventory.py"
LEGACY_TRACK = {
    "裸 <button": "raw_button",
    "<input": "raw_input",
    'role="dialog"': "role_dialog",
    "createPortal": "create_portal",
    "rounded-* + border 表面": "rounded_border_surface",
}


def run(args):
    return subprocess.run(["python3", *args], cwd=WT).returncode


def durable():
    """Delegate measurement, comparison and update to the checked-in checker."""
    if MODE == "check":
        code = run([CHECKER])
        if code:
            print(f"RATCHET_FAIL durable inventory checker exited {code}")
            return code
        print("RATCHET_PASS")
        return 0
    code = run([CHECKER, "--update"])
    if code:
        print(f"RATCHET_ERROR durable inventory update exited {code}")
        return code
    with open(os.path.join(WT, DURABLE_BASELINE), encoding="utf-8") as fh:
        metrics = json.load(fh)["metrics"]
    # occurrences/files, so a corrected measurement is visible in the gate log.
    print(
        "RATCHET updated",
        {key: f"{row['occurrences']}/{row['files']}" for key, row in metrics.items()},
    )
    return 0


def legacy_measure():
    out = subprocess.run(
        ["python3", LEGACY_INVENTORY], cwd=WT, capture_output=True, text=True
    ).stdout
    res = {}
    for line in out.splitlines():
        m = re.match(r"\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", line)
        if m and m.group(1) in LEGACY_TRACK:
            res[LEGACY_TRACK[m.group(1)]] = int(m.group(2))
    return res


def legacy():
    """First-generation lower-only ratchet, for trees without the checker."""
    cur = legacy_measure()
    if not cur:
        print("RATCHET_ERROR: could not read ui_inventory output")
        return 2
    os.makedirs(os.path.dirname(LEGACY_BASELINE), exist_ok=True)
    if MODE == "init" or not os.path.exists(LEGACY_BASELINE):
        with open(LEGACY_BASELINE, "w") as fh:
            json.dump(cur, fh, indent=1)
        print("RATCHET baseline", cur)
        return 0
    with open(LEGACY_BASELINE) as fh:
        base = json.load(fh)
    if MODE == "update":
        for key, value in cur.items():
            base[key] = min(base.get(key, value), value)
        with open(LEGACY_BASELINE, "w") as fh:
            json.dump(base, fh, indent=1)
        print("RATCHET updated", base)
        return 0
    print("RATCHET current", cur, "baseline", base)
    worse = {k: (base.get(k), v) for k, v in cur.items() if k in base and v > base[k]}
    if worse:
        print("RATCHET_FAIL increased (baseline,current):", worse)
        return 1
    print("RATCHET_PASS")
    return 0


if len(sys.argv) != 3 or sys.argv[1] not in ("init", "check", "update"):
    print("usage: ratchet.py check|update|init <worktree>", file=sys.stderr)
    sys.exit(2)
MODE, WT = sys.argv[1], os.path.abspath(sys.argv[2])
sys.exit(durable() if os.path.isfile(os.path.join(WT, CHECKER)) else legacy())
