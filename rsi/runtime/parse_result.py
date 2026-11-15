#!/usr/bin/env python3
"""Read a claude -p stream-json log; print the final result text; exit 1 if it errored."""
import json, sys
path = sys.argv[1]
last = None
for line in open(path, errors="replace"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("type") == "result":
        last = d
if last is None:
    print("NO_RESULT (process died or log empty)")
    sys.exit(1)
result = str(last.get("result", "") or "")
print(result[-6000:] if len(result) > 6000 else result)
print("\n[cost_usd=%s turns=%s is_error=%s status=%s]" % (last.get("total_cost_usd"), last.get("num_turns"), last.get("is_error"), last.get("api_error_status")))
sys.exit(1 if last.get("is_error") else 0)
