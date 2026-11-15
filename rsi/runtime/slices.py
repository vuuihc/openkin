#!/usr/bin/env python3
"""Astryx slice scheduler: which slices of rsi/astryx-slices.json can start now.

  slices.py ready [--json]   ready slices (deps merged, not in flight), flagged if they overlap an active lane
  slices.py status           done / in-flight / ready / waiting counts per track
  slices.py show ID          the full seed for one slice
Done = ITEM appears in state/merged.log. In flight = active lane, or an open PR whose branch/item belongs to it.
"""
import json, os, sys, glob, re, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
RSI = os.path.normpath(os.path.join(HERE, ".."))
STATE = os.environ.get("RSI_STATE") or os.path.join(RSI, "state")
sys.path.insert(0, HERE)
SL = json.load(open(os.path.join(RSI, "astryx-slices.json")))["slices"]
BY = {s["id"]: s for s in SL}

def merged():
    out = set()
    try:
        for l in open(os.path.join(STATE, "merged.log")):
            t = l.split()
            if len(t) > 6 and t[2] == "PR": out.add(t[5])
    except FileNotFoundError: pass
    return out

def lanes():
    rows = []
    for f in glob.glob(os.path.join(STATE, "lanes", "[0-9]*.json")) + glob.glob(os.path.join(STATE, "lanes", "history", "*.json")):
        try: rows.append(json.load(open(f)))
        except Exception: pass
    return rows

def open_prs():
    try:
        out = subprocess.run(["/opt/homebrew/bin/gh", "pr", "list", "--repo", "vuuihc/openkin", "--state", "open", "--limit", "60", "--json", "number"], capture_output=True, text=True, timeout=40).stdout
        return {p["number"] for p in json.loads(out)}
    except Exception: return None

def inflight():
    ops = open_prs(); fl = {}
    for r in lanes():
        it = r.get("item"); st = r.get("status")
        if not it: continue
        active = st in ("claimed", "running")
        pr = r.get("pr")
        in_review = bool(pr) and ops is not None and int(pr) in ops
        if active or in_review: fl[it] = ("lane %s" % r.get("lane")) + ((" PR #%s" % pr) if pr else "")
    return fl

def active_paths():
    import lanes as L  # reuses overlap(); lanes.py is import-safe only via subprocess, so replicate cheaply
    return None

def overlap(a, b):
    a, b = a.strip("/"), b.strip("/")
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")

def active_claims():
    res = []
    for f in glob.glob(os.path.join(STATE, "lanes", "[0-9]*.json")):
        try: d = json.load(open(f))
        except Exception: continue
        if d.get("status") in ("claimed", "running"): res.append(d)
    return res

def compute():
    done = merged(); fl = inflight(); rows = []
    claims = active_claims()
    for s in SL:
        if s.get("existing"): continue
        i = s["id"]
        if i in done: st = "done"
        elif i in fl: st = "inflight: " + fl[i]
        elif all(d in done for d in s["deps"]): st = "ready"
        else: st = "waiting: " + ",".join(d for d in s["deps"] if d not in done)
        ov = ""
        if st == "ready":
            for c in claims:
                for p in s["paths"]:
                    if p == "ui/package.json" or p == "ui/package-lock.json":
                        pass
                    for q in c.get("paths", []):
                        if overlap(p, q): ov = "lane %s (%s)" % (c.get("lane"), c.get("item")); break
                    if ov: break
                if ov: break
        rows.append((s, st, ov))
    return rows

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "show":
        print(json.dumps(BY[sys.argv[2]], indent=1, ensure_ascii=False)); return
    rows = compute()
    if cmd == "ready":
        # Existing Q3a counts as satisfied only once merged; deps on it show as waiting until then.
        out = [(s, ov) for s, st, ov in rows if st == "ready"]
        if "--json" in sys.argv: print(json.dumps([dict(id=s["id"], title=s["title"], size=s["size"], deps=s["deps"], paths=s["paths"], overlaps=ov) for s, ov in out], ensure_ascii=False, indent=1)); return
        if not out: print("(no ready Astryx slice)")
        for s, ov in out:
            print("%-5s %s size=%s deps=%s%s\n       paths: %s" % (s["id"], s["title"], s["size"], ",".join(s["deps"]) or "-", ("  ** OVERLAPS " + ov) if ov else "", ", ".join(s["paths"])))
        return
    # status
    tr = {}
    for s, st, ov in rows:
        k = s["track"]; d = tr.setdefault(k, dict(done=0, inflight=0, ready=0, waiting=0, total=0))
        d["total"] += 1; d[("inflight" if st.startswith("inflight") else "waiting" if st.startswith("waiting") else st)] += 1
    tot = sum(d["total"] for d in tr.values()); dn = sum(d["done"] for d in tr.values())
    print("Astryx programme: %d/%d slices merged" % (dn, tot))
    for k, d in sorted(tr.items()): print("  track %s: %s" % (k, " ".join("%s=%d" % kv for kv in d.items())))
    for s, st, ov in rows:
        if st.startswith("inflight"): print("  in flight: %-5s %s [%s]" % (s["id"], s["title"], st))
main()
