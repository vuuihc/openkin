#!/usr/bin/env python3
"""Lane registry for the parallel Kin RSI loop.

Every worker lane owns one slot (1..RSI_MAX_LANES), one worktree/branch and one JSON
record in $STATE/lanes/<n>.json.  A lane is ACTIVE while it is `claimed` (≤ CLAIM_TTL old)
or `running` with a live pid.  Claims declare the repo paths the lane will touch; a claim
that overlaps another active lane's paths is refused (exit 3).  Mutations hold an flock.

  lanes.py status                      table of lanes (+ last result of idle ones)
  lanes.py idle                        idle lane numbers, one per line (honours load guard)
  lanes.py claim N --slug S --item ID --brief FILE [--mode new|rework] --paths P [P ...]
  lanes.py get N                       shell-quotable key=value lines
  lanes.py cloud-claim --slug S --item ID --brief FILE --paths P [P ...]   hand a slice to an external agent (expires after 3h unlaunched)
  lanes.py cloud-list | cloud-release SLUG
  lanes.py start N PID | finish N --status S [--pr N] [--note T] | claimed
"""
import subprocess, argparse, fcntl, fnmatch, json, os, sys, time, glob, shlex

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("RSI_STATE") or os.path.normpath(os.path.join(HERE, "..", "state"))
LDIR = os.path.join(STATE, "lanes")
MAX_LANES = int(os.environ.get("RSI_MAX_LANES", "3"))
CLAIM_TTL = 25 * 60

def ncpu():
    return os.cpu_count() or 4

def load_max():
    # Default: 2× logical cores. Values >= 10000 (the old default 100000) are
    # treated as unset so a leftover env cannot disable the guard.
    raw = os.environ.get("RSI_LOAD_MAX")
    try:
        v = float(raw) if raw else 0
    except ValueError:
        v = 0
    if v <= 0 or v >= 10000:
        return float(2 * ncpu())
    return v

LOAD_MAX = load_max()
MEM_AVAIL_MIN_MB = float(os.environ.get("RSI_MEM_AVAIL_MIN_MB", "2048"))
SWAP_USED_MAX_MB = float(os.environ.get("RSI_SWAP_USED_MAX_MB", "12288"))

def swap_usage_mb():
    """Return (used_mb, free_mb) from sysctl vm.swapusage, or (None, None)."""
    try:
        sw = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5).stdout
        used = float(sw.split("used =")[1].split("M")[0].strip())
        free = float(sw.split("free =")[1].split("M")[0].strip())
        return used, free
    except Exception:
        return None, None

def swap_free_mb():
    return swap_usage_mb()[1]

def swap_used_mb():
    return swap_usage_mb()[0]

def avail_mem_mb():
    """Estimate reclaimable+free memory from macOS vm_stat (pages free+inactive+speculative+purgeable)."""
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page_sz = 16384
        first = out.splitlines()[0] if out else ""
        if "page size of" in first:
            page_sz = int(first.split("page size of")[1].split("bytes")[0].strip())
        pages = 0.0
        for line in out.splitlines()[1:]:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k = k.strip().lower()
            if k in ("pages free", "pages inactive", "pages speculative", "pages purgeable"):
                pages += float(v.strip().rstrip("."))
        return (pages * page_sz) / (1024 * 1024)
    except Exception:
        return None

def vm_pressure_level():
    try:
        out = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out)
    except Exception:
        return None

def host_pressure():
    """Reason the Mac must not start a new local worker, or empty if it may."""
    try:
        load = os.getloadavg()[0]
        lim = load_max()
        if load > lim:
            return "load %.1f > %.0f (%d cores × 2)" % (load, lim, ncpu())
    except Exception:
        pass
    lvl = vm_pressure_level()
    if lvl is not None and lvl >= 4:
        return "vm_pressure_level %d >= 4" % lvl
    avail = avail_mem_mb()
    if avail is not None and avail < MEM_AVAIL_MIN_MB:
        return "avail mem %.0fMB < %.0fMB" % (avail, MEM_AVAIL_MIN_MB)
    used = swap_used_mb()
    if used is not None and used > SWAP_USED_MAX_MB:
        return "swap used %.0fMB > %.0fMB" % (used, SWAP_USED_MAX_MB)
    return ""
# Generated/derived files every UI lane touches; the merge lane rebuilds/merges them, so they never count as a claim.
IGNORED = {"web/dist/index.html"}
TOO_BROAD = {".", "", "*", "**", "ui", "ui/src", "internal", "web", "docs", "scripts", "desktop", "mobile", "cmd"}
CDIR = os.path.join(STATE, "cloud")          # slices handed to external (cloud) agents: claims keep local lanes off their paths
CLOUD_TTL = int(os.environ.get("RSI_CLOUD_TTL_MIN", "180")) * 60
os.makedirs(os.path.join(LDIR, "history"), exist_ok=True); os.makedirs(os.path.join(CDIR, "expired"), exist_ok=True)
# Lanes above MAX_LANES that are still running (after the limit was lowered) stay visible so claims/merge-lane see them.
_ex = [int(os.path.basename(f)[:-5]) for f in glob.glob(os.path.join(LDIR, "[0-9]*.json"))]
ALL_LANES = max([MAX_LANES] + _ex)


class Lock:
    def __enter__(self):
        self.f = open(os.path.join(LDIR, ".flock"), "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN); self.f.close()


def path_of(n): return os.path.join(LDIR, f"{n}.json")

def unique_history_path(slug, stamp=None):
    """A history filename that never overwrites an earlier row for the same slug."""
    stamp = stamp or time.strftime("%Y%m%d-%H%M%S")
    n, path = 1, os.path.join(LDIR, "history", f"{stamp}-{slug}.json")
    while os.path.exists(path):
        n += 1
        path = os.path.join(LDIR, "history", f"{stamp}-{slug}-{n}.json")
    return path

def load(n):
    try:
        return json.load(open(path_of(n)))
    except Exception:
        return None

def save(n, d):
    tmp = path_of(n) + ".tmp"
    json.dump(d, open(tmp, "w"), indent=1)
    os.replace(tmp, path_of(n))

def alive(pid):
    try:
        os.kill(int(pid), 0); return True
    except Exception:
        return False

def is_active(d):
    if not d: return False
    if d.get("status") == "claimed": return time.time() - d.get("claimed_at", 0) < CLAIM_TTL
    if d.get("status") == "running": return alive(d.get("pid", 0))
    return False

def norm(p):
    # NOT lstrip("./"): that strips characters, so ".gitignore" became "gitignore" and the claim was REFUSED (too broad),
    # which kept rework lanes idle for PRs that touch a dotfile (found 2026-11-15: #59/#63 waited >1h).
    p = p.strip()
    while p.startswith("./"): p = p[2:]
    return p.rstrip("/")

def overlap(a, b):
    a, b = norm(a), norm(b)
    if a == b or a.startswith(b + "/") or b.startswith(a + "/"): return True
    return fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a)

def reap():
    """A running lane whose pid died without finishing becomes `crashed` (idle)."""
    for n in range(1, ALL_LANES + 1):
        d = load(n)
        if d and d.get("status") == "running" and not alive(d.get("pid", 0)):
            d.update(status="crashed", finished_at=time.time()); save(n, d)
        elif d and d.get("status") == "claimed" and time.time() - d.get("claimed_at", 0) >= CLAIM_TTL:
            d.update(status="expired", finished_at=time.time()); save(n, d)

def fmt(d):
    if not d: return "idle (never used)"
    st = d.get("status")
    age = int((time.time() - (d.get("started_at") or d.get("claimed_at") or 0)) / 60)
    base = f"{st:8} {d.get('item','?')} {d.get('slug','?')} mode={d.get('mode','new')}"
    if is_active(d): return f"ACTIVE   {base} age={age}m paths={','.join(d.get('paths', []))}"
    return f"idle     last: {base} pr={d.get('pr','-')} note={d.get('note','')[:90]}"

def cmd_status(a):
    reap()
    for n in range(1, ALL_LANES + 1):
        print(f"lane {n}: {fmt(load(n))}")
    try:
        press = host_pressure()
        avail = avail_mem_mb()
        used = swap_used_mb()
        print("loadavg1=%.1f max=%.0f mem_avail_mb=%s swap_used_mb=%s%s" % (
            os.getloadavg()[0], load_max(),
            ("%.0f" % avail) if avail is not None else "-1",
            ("%.0f" % used) if used is not None else "-1",
            (" PRESSURE: " + press if press else "")))
    except Exception: pass

def cmd_host_ok(a):
    press = host_pressure()
    if press:
        print(press, file=sys.stderr); sys.exit(1)
    sys.exit(0)

def cmd_idle(a):
    with Lock():
        reap()
        press = host_pressure()
        # --ignore-pressure: the rework dispatcher needs the free slot even while host pressure defers NEW
        # slices; the claim itself re-checks and admits rework only (see cmd_claim).
        if press and not getattr(a, "ignore_pressure", False):
            print(f"host pressure ({press}); not filling local workers", file=sys.stderr); return
        cap = MAX_LANES
        for n in range(1, cap + 1):
            if not is_active(load(n)): print(n)

def ux_gate_refuse(item):
    """Slices marked "gate": "ux-approved" in astryx-slices.json (S1-S3: the visible shell) cannot be claimed until Ethan has looked at the
    prototype and created state/ux-proto/APPROVED. The merge lane enforces the same on landing (slices.py gate-ok)."""
    try:
        sl = {x["id"]: x for x in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "astryx-slices.json")))["slices"]}
    except Exception: return
    if sl.get(item, {}).get("gate") == "ux-approved" and not os.path.exists(os.path.join(STATE, "ux-proto", "APPROVED")):
        print(f"REFUSED: {item} is gated on state/ux-proto/APPROVED (UX prototype approval)"); sys.exit(7)

def is_valid_path(p):
    if p in TOO_BROAD:
        return False
    if "/" in p or "." in p:
        return True
    return os.path.isfile(os.path.join(HERE, "..", "..", p))

def cmd_claim(a):
    paths = [norm(p) for p in a.paths if norm(p) not in IGNORED]
    bad = [p for p in paths if not is_valid_path(p)]
    if not paths or bad:
        print(f"REFUSED: declare specific files/dirs (too broad or empty: {bad or 'none given'})"); sys.exit(5)
    if not os.path.isfile(a.brief): print(f"REFUSED: brief {a.brief} missing"); sys.exit(6)
    ux_gate_refuse(a.item)
    press = host_pressure()
    # A targeted rework is measured in minutes (2-11 min tonight) and fixes a PR that is already in
    # review; only severe load or critical memory pressure defers reworks. New slices stay gated.
    if press and (a.mode != "rework" or press.startswith("load") or press.startswith("vm_pressure")):
        print(f"REFUSED: host pressure ({press}); no new local worker"); sys.exit(8)
    if press:
        print(f"host pressure ({press}); allowing a short rework", file=sys.stderr)
    with Lock():
        reap()
        if not 1 <= a.lane <= MAX_LANES: print("REFUSED: no such lane"); sys.exit(4)
        cur = load(a.lane)
        if is_active(cur): print(f"REFUSED: lane {a.lane} busy ({cur.get('slug')})"); sys.exit(4)
        for c in cloud_claims():
            if c.get("item") == a.item: print(f"REFUSED: {a.item} is handed to a cloud agent ({c.get('slug')})"); sys.exit(3)
            for p in paths:
                for q in c.get("paths", []):
                    if overlap(p, q): print(f"REFUSED: overlap with cloud claim {c.get('item')} {c.get('slug')}: '{p}' vs '{q}'. Pick an item in a disjoint area."); sys.exit(3)
        for n in range(1, ALL_LANES + 1):
            o = load(n)
            if n == a.lane or not is_active(o): continue
            if o.get("slug") == a.slug: print(f"REFUSED: slug {a.slug} already active in lane {n}"); sys.exit(3)
            for p in paths:
                for q in o.get("paths", []):
                    if overlap(p, q):
                        print(f"REFUSED: overlap with lane {n} ({o.get('item')} {o.get('slug')}): '{p}' vs '{q}'. Pick an item in a disjoint area."); sys.exit(3)
        if cur:
            os.replace(path_of(a.lane), unique_history_path(cur.get('slug', 'x')))
        save(a.lane, dict(lane=a.lane, slug=a.slug, item=a.item, brief=a.brief, mode=a.mode, paths=paths,
                          status="claimed", claimed_at=time.time()))
    print(f"CLAIMED lane {a.lane}: {a.item} {a.slug} paths={paths}")

def cloud_claims(reap_expired=True):
    out = []
    now = time.time()
    for f in sorted(glob.glob(os.path.join(CDIR, "*.json"))):
        try: d = json.load(open(f))
        except Exception: continue
        raw_claimed = float(d.get("claimed_at") or 0)
        base = float(d.get("launched_at") or min(raw_claimed, now))
        exp = d.get("expires_at")
        if exp is not None:
            expired = now > float(exp)
        else:
            ttl = 5 * 3600 if d.get("taker") == "nas" else CLOUD_TTL
            expired = (now - base) > ttl
        if reap_expired and expired:
            os.replace(f, os.path.join(CDIR, "expired", os.path.basename(f))); continue
        out.append(d)
    return out

def cmd_cloud_claim(a):
    ux_gate_refuse(a.item)
    paths = [norm(p) for p in a.paths if norm(p) not in IGNORED]
    bad = [p for p in paths if p in TOO_BROAD]
    if not paths or bad: print(f"REFUSED: declare specific files/dirs (too broad or empty: {bad or 'none given'})"); sys.exit(5)
    if not os.path.isfile(a.brief): print(f"REFUSED: brief {a.brief} missing"); sys.exit(6)
    with Lock():
        reap()
        for n in range(1, ALL_LANES + 1):
            o = load(n)
            if not is_active(o): continue
            for p in paths:
                for q in o.get("paths", []):
                    if overlap(p, q): print(f"REFUSED: overlap with lane {n} ({o.get('item')}): '{p}' vs '{q}'"); sys.exit(3)
        for c in cloud_claims():
            if c.get("slug") == a.slug or c.get("item") == a.item: print(f"REFUSED: {a.item}/{a.slug} already handed to cloud"); sys.exit(3)
            for p in paths:
                for q in c.get("paths", []):
                    if overlap(p, q): print(f"REFUSED: overlap with cloud claim {c.get('item')} {c.get('slug')}: '{p}' vs '{q}'"); sys.exit(3)
        json.dump(dict(slug=a.slug, item=a.item, brief=a.brief, paths=paths, status="claimed", claimed_at=time.time()), open(os.path.join(CDIR, f"{a.slug}.json"), "w"))
    print(f"CLOUD-CLAIMED {a.item} {a.slug} brief={a.brief} paths={paths}")

def cmd_cloud_release(a):
    f = os.path.join(CDIR, f"{a.slug}.json")
    if os.path.exists(f): os.replace(f, os.path.join(CDIR, "expired", f"done-{a.slug}.json")); print("released", a.slug)

def cmd_cloud_list(a):
    now = time.time()
    for c in cloud_claims():
        ref_t = float(c.get("launched_at") or min(float(c.get("claimed_at") or now), now))
        print("%-6s %-28s age=%dm brief=%s paths=%s" % (c["item"], c["slug"], max(0.0, (now - ref_t) / 60), c["brief"], ",".join(c["paths"])))

def cmd_get(a):
    d = load(a.lane) or {}
    for k in ("slug", "item", "brief", "mode", "status", "pr"):
        print(f"L_{k.upper()}={shlex.quote(str(d.get(k, '')))}")

def cmd_start(a):
    with Lock():
        d = load(a.lane); d.update(status="running", pid=a.pid, started_at=time.time()); save(a.lane, d)

def cmd_finish(a):
    with Lock():
        d = load(a.lane) or {}
        d.update(status=a.status, finished_at=time.time(), note=a.note or "")
        if a.pr: d["pr"] = a.pr
        save(a.lane, d)

def cmd_claimed(a):
    with Lock():
        reap()
        for n in range(1, ALL_LANES + 1):
            d = load(n)
            if d and d.get("status") == "claimed" and time.time() - d.get("claimed_at", 0) < CLAIM_TTL: print(n)

def cmd_slugs(a):  # slugs of active lanes (merge lane must not touch their worktrees)
    reap()
    for n in range(1, ALL_LANES + 1):
        d = load(n)
        if is_active(d): print(d.get("slug"))

p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="c", required=True)
sub.add_parser("status").set_defaults(f=cmd_status)
i = sub.add_parser("idle"); i.add_argument("--ignore-pressure", action="store_true"); i.set_defaults(f=cmd_idle)
sub.add_parser("claimed").set_defaults(f=cmd_claimed)
sub.add_parser("host-ok").set_defaults(f=cmd_host_ok)

sub.add_parser("slugs").set_defaults(f=cmd_slugs)
c = sub.add_parser("claim"); c.add_argument("lane", type=int); c.add_argument("--slug", required=True); c.add_argument("--item", required=True)
c.add_argument("--brief", required=True); c.add_argument("--mode", default="new", choices=["new", "rework"]); c.add_argument("--paths", nargs="+", default=[]); c.set_defaults(f=cmd_claim)
cc = sub.add_parser("cloud-claim"); cc.add_argument("--slug", required=True); cc.add_argument("--item", required=True); cc.add_argument("--brief", required=True); cc.add_argument("--paths", nargs="+", default=[]); cc.set_defaults(f=cmd_cloud_claim)
cr = sub.add_parser("cloud-release"); cr.add_argument("slug"); cr.set_defaults(f=cmd_cloud_release)
sub.add_parser("cloud-list").set_defaults(f=cmd_cloud_list)
g = sub.add_parser("get"); g.add_argument("lane", type=int); g.set_defaults(f=cmd_get)
s = sub.add_parser("start"); s.add_argument("lane", type=int); s.add_argument("pid", type=int); s.set_defaults(f=cmd_start)
f = sub.add_parser("finish"); f.add_argument("lane", type=int); f.add_argument("--status", required=True); f.add_argument("--pr", default=""); f.add_argument("--note", default=""); f.set_defaults(f=cmd_finish)
a = p.parse_args(); a.f(a)
