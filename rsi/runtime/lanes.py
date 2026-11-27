#!/usr/bin/env python3
"""Lane registry for the parallel Kin RSI loop.

Every worker lane owns one slot (1..RSI_MAX_LANES), one worktree/branch and one JSON
record in $STATE/lanes/<n>.json.  A lane is ACTIVE while it is `claimed` (≤ CLAIM_TTL old)
or `running` with a live pid.  Claims declare the repo paths the lane will touch; a claim
that overlaps another active lane's paths is refused (exit 3).  Mutations hold an flock.

  lanes.py status                      table of lanes (+ last result of idle ones)
  lanes.py facts [--now EPOCH]         mutable facts (sendback queue, active lanes, cloud claims,
                                       merged tail) as one paste-able key=value block
  lanes.py idle                        idle lane numbers, one per line (honours load guard and the spare-lane floor)
  lanes.py claim N --slug S --item ID --brief FILE [--mode new|rework] --paths P [P ...]
  lanes.py get N                       shell-quotable key=value lines
  lanes.py cloud-claim --slug S --item ID --brief FILE --paths P [P ...]   hand a slice to an external agent (expires after 3h unlaunched)
  lanes.py cloud-list | cloud-release SLUG
  lanes.py start N PID | finish N --status S [--pr N] [--note T] | claimed

Exit codes: 2 a whitespace-joined --paths argument splits into a non-path token,
3 overlap/busy, 4 no such lane or lane busy, 5 bad paths, 6 missing brief,
7 UX gate, 8 host pressure, 9 item already merged (pass --redeliver or use a new id),
10 the last usable lane is reserved for an unclaimed rework.
An unknown subcommand exits 2 and names the command that withdraws a claim (`finish N --status
cancelled`); a mistyped command never reads or writes state.
`facts` exits 0 whenever the block prints, and 2 only when $STATE itself cannot be read (then
every value is `unknown`).
"""
import subprocess, argparse, datetime, fcntl, fnmatch, json, os, sys, time, glob, shlex

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("RSI_STATE") or os.path.normpath(os.path.join(HERE, "..", "state"))
LDIR = os.path.join(STATE, "lanes")
# Worker event logs streamed by dispatch.sh: <stamp>-dispatch-lane<N>-<slug>-worker.jsonl.
# Overridable so a hermetic test can point at its own runs dir.
RUNS = os.environ.get("RSI_RUNS") or os.path.join(HERE, "runs")
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
# The second simultaneous local worker is optional capacity: 16 GB is the scarce resource on
# this Mac (Ethan 2026-11-18), so a spare lane starts only with real headroom. The FIRST worker
# keeps the ordinary thresholds above; reworks are never held by this gate. Headroom is current
# VM pressure plus free swap, never used swap: macOS keeps swapped pages allocated after the
# pressure passes, so used swap is a cumulative high-water readout (2026-11-19: 2706 MB used
# with pressure normal, refusing every spare lane for a day).
LANE2_MEM_MIN_MB = float(os.environ.get("RSI_LANE2_MEM_MIN_MB", "5120"))
LANE2_PRESSURE_MAX = int(os.environ.get("RSI_LANE2_PRESSURE_MAX", "1"))
LANE2_SWAP_FREE_MIN_MB = float(os.environ.get("RSI_LANE2_SWAP_FREE_MIN_MB", "512"))

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

def spare_lane_pressure():
    """Reason a *second* simultaneous local worker must wait, or empty if it may start.

    Two agent lanes plus a merge-lane gate plus a browser walk is what swapped this machine
    hard on 2026-11-18; the spare lane is what yields to the NAS instead. Only consulted when
    one local lane is already active (the first worker is governed by host_pressure).

    Used swap is not the measure: macOS keeps swapped pages allocated after pressure has
    passed, so "swap used" is a cumulative high-water readout — 2706 MB with
    kern.memorystatus_vm_pressure_level = 1 refused every second lane on 2026-11-19. The
    11-18 protection is warning-or-worse VM pressure plus a real swap-free headroom floor,
    both read fresh; an unreadable probe fails open, as before.
    """
    avail = avail_mem_mb()
    if avail is not None and avail < LANE2_MEM_MIN_MB:
        return "avail mem %.0fMB < %.0fMB" % (avail, LANE2_MEM_MIN_MB)
    lvl = vm_pressure_level()
    if lvl is not None and lvl > LANE2_PRESSURE_MAX:
        return "vm_pressure_level %d > %d" % (lvl, LANE2_PRESSURE_MAX)
    free = swap_free_mb()
    if free is not None and free < LANE2_SWAP_FREE_MIN_MB:
        return "swap free %.0fMB < %.0fMB" % (free, LANE2_SWAP_FREE_MIN_MB)
    return ""

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
ALL_LANES = MAX_LANES

def init_state():
    """Create the state subtrees and size the lane table from existing records.

    Called only after the unknown-subcommand guard: a mistyped command must not read,
    write or create anything under $STATE.
    """
    global ALL_LANES
    try:
        os.makedirs(os.path.join(LDIR, "history"), exist_ok=True); os.makedirs(os.path.join(CDIR, "expired"), exist_ok=True)
    except OSError:
        # `facts` must report an unreadable state dir as `state=unknown` (exit 2) instead of dying
        # here; every other subcommand keeps crashing on the same OSError, exactly as before.
        if sys.argv[1:2] != ["facts"]:
            raise
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

def silent_minutes(n, slug):
    """Minutes since the newest worker event log for this lane was written, or None.

    Deliberately the log mtime, not started_at: a worker that has been alive 39m but
    silent for 30m is the failure this exposes (a stuck Bash call, 2026-11-18).
    """
    if not slug:
        return None
    pat = os.path.join(RUNS, "*-dispatch-lane%d-%s-worker.jsonl" % (n, slug))
    try:
        mtimes = [os.path.getmtime(f) for f in glob.glob(pat)]
    except OSError:
        return None
    if not mtimes:
        return None
    return int(max(0.0, time.time() - max(mtimes)) / 60)

def fmt(d, n=None):
    if not d: return "idle (never used)"
    st = d.get("status")
    age = int((time.time() - (d.get("started_at") or d.get("claimed_at") or 0)) / 60)
    base = f"{st:8} {d.get('item','?')} {d.get('slug','?')} mode={d.get('mode','new')}"
    if is_active(d):
        sil = silent_minutes(n, d.get("slug")) if n is not None else None
        silent = "-" if sil is None else f"{sil}m"
        return f"ACTIVE   {base} age={age}m silent={silent} paths={','.join(d.get('paths', []))}"
    return f"idle     last: {base} pr={d.get('pr','-')} note={d.get('note','')[:90]}"

def cmd_status(a):
    reap()
    for n in range(1, ALL_LANES + 1):
        print(f"lane {n}: {fmt(load(n), n)}")
    try:
        press = host_pressure()
        avail = avail_mem_mb()
        used = swap_used_mb()
        lvl = vm_pressure_level()
        swfree = swap_free_mb()
        print("loadavg1=%.1f max=%.0f mem_avail_mb=%s swap_used_mb=%s vm_pressure=%s swap_free_mb=%s%s" % (
            os.getloadavg()[0], load_max(),
            ("%.0f" % avail) if avail is not None else "-1",
            ("%.0f" % used) if used is not None else "-1",
            ("%d" % lvl) if lvl is not None else "-1",
            ("%.0f" % swfree) if swfree is not None else "-1",
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
        ignore = getattr(a, "ignore_pressure", False)
        if press and not ignore:
            print(f"host pressure ({press}); not filling local workers", file=sys.stderr); return
        cap = MAX_LANES
        free = [n for n in range(1, cap + 1) if not is_active(load(n))]
        # A spare lane is a measurement, not a slot: whatever `idle` licences, `cmd_claim` will
        # re-check, so both must ask the spare floor the same question. That is "a worker is
        # already active" (today's path) and also a cold start where idle would print TWO lanes
        # (2026-11-20 20:32: idle said 1,2 at 4386 MB and the second claim died with REFUSED).
        # Lane 1 stays governed by host_pressure above; --ignore-pressure skips both floors.
        if free and not ignore and (len(free) > 1 or len(free) < cap):
            spare = spare_lane_pressure()
            if spare:
                print(f"spare lane held ({spare}); one local worker at a time", file=sys.stderr)
                if len(free) < cap:
                    return
                free = free[:1]
        for n in free: print(n)

def delivered_item(item):
    """The loop's own record that `item` already landed, or None.

    $STATE/merged.log carries one line per merged PR:
        YYYY-MM-DD HH:MM PR #N <slug> <item> merged <sha> <url>
    Only rows whose 3rd field is "PR" and 7th is "merged" count; the item is field 6.
    Malformed rows and a missing/empty log (a fresh state dir) are ignored, so the guard
    fails open rather than guessing.
    """
    if not item:
        return None
    try:
        with open(os.path.join(STATE, "merged.log")) as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    for ln in reversed(lines):
        f = ln.split()
        if len(f) < 7 or f[2] != "PR" or f[6] != "merged" or f[5] != item:
            continue
        return dict(date=f[0], pr=f[3].lstrip("#"), sha=f[7] if len(f) > 7 else "?", slug=f[4])
    return None

def merged_refuse(item, redeliver, mode="new"):
    """Refuse (exit 9) an item whose PR already merged, unless a rework or --redeliver.

    Ledgers drift: an item can still read "queued" hours after its PR shipped, and a prose
    note has failed to stop the redo four times in one day (2026-11-19). The merged log is
    the loop's durable delivery record, so the claim is the chokepoint that reads it.
    A rework targets an open PR, so it is never held by this guard.
    """
    if mode == "rework":
        return
    d = delivered_item(item)
    if not d:
        return
    if redeliver:
        print(f"note: {item} merged in PR #{d['pr']} ({d['sha']}); delivering again on purpose",
              file=sys.stderr)
        return
    print(f"REFUSED: {item} already merged in PR #{d['pr']} ({d['sha']}, {d['date']}); "
          f"use a new item id or pass --redeliver")
    sys.exit(9)

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

def path_tokens(arg):
    """The path tokens one --paths argument holds: itself when it names a real file or dir.

    `git diff --raw` prints a path containing a space unquoted, so lane.sh hands a tracked
    "design/Kin Main Window (standalone).orig.html" to claim as one argv word. Splitting that
    would refuse a file that exists, so an argument whose whole text names something that exists
    stays one path; only an argument that names nothing is read as a whitespace-joined list.
    """
    if os.path.exists(os.path.join(HERE, "..", "..", norm(arg))):
        return [arg]
    return arg.split()

def refuse_joined_non_paths(args):
    """Refuse a whitespace-joined --paths argument that splits into a non-path token.

    A caller that passed one quoted "$PATHS" delivered a single argv word, and `claim` recorded
    the whole 30-path blob as one path that can never match a file; lane.sh then called every
    touched file outside the footprint and row 3 `delete-pagesb2c-del` lost its claim and idled
    for a fill cycle (followup 1832, 2026-11-24 07:36). Splitting is only safe when every token
    is a path: dropping a bad token would claim a narrower scope than the caller asked for, so
    a joined argument holding prose stops here instead.
    """
    for arg in args:
        if not any(c.isspace() for c in arg):
            continue
        toks = path_tokens(arg)
        if toks == [arg]:
            continue  # one real path that happens to contain a space
        bad = [t for t in toks if not is_valid_path(norm(t))]
        if bad:
            print(f"REFUSED: --paths argument contains whitespace and splits into a non-path token: '{bad[0]}' (from '{arg}')"); sys.exit(2)

def unclaimed_sendbacks():
    """Sendbacks no lane has taken yet, oldest first (by mtime).

    A file alone is not "waiting". `lane.sh` archives a sendback only at the end of its
    rework run (lane.sh:273), so for the whole run the file still sits in the queue; the
    slug an active lane already runs is filtered out, mirroring the skip at lane.sh:93.
    A size-only sendback whose cap the CEO waived (`source: hold-size` plus
    `merge/<slug>.size-ok`) is filtered too, because autofill never picks it up and the
    reservation would persist with no rework coming. A sendback whose PR is already
    terminal is not filtered here; autofill archives it on its next pass (lane.sh:101-104),
    which is what clears it. A sendback autofill skips without archiving (no diff vs main,
    lane.sh:112; no paths, lane.sh:117) still counts: only an archive or a claim clears a
    queue entry.
    """
    active = set()
    for n in range(1, ALL_LANES + 1):
        d = load(n)
        if is_active(d): active.add(d.get("slug"))
    out = []
    for f in glob.glob(os.path.join(STATE, "sendback", "*.md")):
        slug = os.path.basename(f)[:-3]
        if slug in active: continue
        try:
            src = ""
            with open(f, errors="replace") as fh:
                for line in fh:
                    if line.startswith("source:"):
                        src = line.split(":", 1)[1].strip(); break
            if src == "hold-size" and os.path.isfile(os.path.join(STATE, "merge", slug + ".size-ok")):
                continue
            out.append((os.path.getmtime(f), f))
        except OSError: continue
    return [f for _, f in sorted(out)]


def cmd_claim(a):
    refuse_joined_non_paths(a.paths)
    paths = [norm(p) for arg in a.paths for p in path_tokens(arg) if norm(p) not in IGNORED]
    bad = [p for p in paths if not is_valid_path(p)]
    if not paths or bad:
        print(f"REFUSED: declare specific files/dirs (too broad or empty: {bad or 'none given'})"); sys.exit(5)
    if not os.path.isfile(a.brief): print(f"REFUSED: brief {a.brief} missing"); sys.exit(6)
    ux_gate_refuse(a.item)
    merged_refuse(a.item, a.redeliver, a.mode)
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
        # The spare-lane gate belongs with the admission decision, not only with `idle`: a claim
        # made directly (autofill, a rework dispatcher) must meet the same headroom rule. Reworks
        # are minutes and may preempt it, exactly like host_pressure above.
        if a.mode != "rework":
            busy = [n for n in range(1, ALL_LANES + 1) if n != a.lane and is_active(load(n))]
            if busy:
                spare = spare_lane_pressure()
                if spare:
                    print(f"REFUSED: spare lane held ({spare}); one local worker at a time"); sys.exit(8)
        # An open PR outranks a fresh slice: a sendback that appears while the director is still
        # running (a merge cycle wrote it 4-10 min into the fill) used to find every usable lane
        # taken, so the rework waited for the next merge kick (2026-11-20 09:06: #435 and #436 sat
        # 40 min while two NEW slices ran; the 2026-11-18 lesson was the same shape). Refuse only
        # the claim that would leave no lane at all, so the post-dispatch `autofill rest` gets one.
        if a.mode != "rework":
            held = unclaimed_sendbacks()
            if held:
                free_after = [n for n in range(1, MAX_LANES + 1) if n != a.lane and not is_active(load(n))]
                if not free_after:
                    print(f"REFUSED: unclaimed rework {os.path.basename(held[0])[:-3]} gets the last free lane; run `lane.sh autofill`")
                    sys.exit(10)
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
    merged_refuse(a.item, a.redeliver)
    refuse_joined_non_paths(a.paths)
    paths = [norm(p) for arg in a.paths for p in path_tokens(arg) if norm(p) not in IGNORED]
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

SG = datetime.timezone(datetime.timedelta(hours=8))

def sg_time(ts):
    return datetime.datetime.fromtimestamp(ts, SG)

def dir_state(path):
    """`missing`, `ok` or `unreadable` for a mutable directory under $STATE.

    A missing directory is a real "nothing here" (0/none). A path that exists but is not a
    readable directory is a failed read, and must never be reported as 0/none.
    """
    if not os.path.exists(path):
        return "missing"
    if not os.path.isdir(path):
        return "unreadable"
    try:
        os.listdir(path)
    except OSError:
        return "unreadable"
    return "ok"

def merged_rows():
    """Well-formed $STATE/merged.log rows in file order, or None when the log exists unreadably.

    A row is well formed when it carries the `DATE TIME PR #N slug item merged SHA` fields
    (an optional url may follow), the 3rd field is PR and the 7th is merged, and date and time
    parse. Malformed rows and a missing log are simply not rows, like delivered_item().
    """
    path = os.path.join(STATE, "merged.log")
    if not os.path.exists(path):
        return []
    try:
        with open(path, errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    rows = []
    for ln in lines:
        f = ln.split()
        if len(f) < 8 or f[2] != "PR" or f[6] != "merged":
            continue
        try:
            datetime.datetime.strptime(f[0], "%Y-%m-%d"); datetime.datetime.strptime(f[1], "%H:%M")
        except ValueError:
            continue
        rows.append(f)
    return rows

def cmd_facts(a):
    """Print the loop's mutable facts as one paste-able key=value block.

    STATUS.md is written by a director model that characterizes these directories in prose,
    and the prose was false four times on 2026-11-20 (16:27 said the sendback queue was empty
    while a rework had waited since 16:23). One command, read once and pasted verbatim, cannot
    drift from the directories it describes. `unknown` is a third state beside 0 and none: a
    path that exists but cannot be read must never print as empty.
    """
    now = float(a.now) if a.now is not None else time.time()
    print("now=" + sg_time(now).strftime("%Y-%m-%dT%H:%M:%S+08:00"))
    try:
        os.listdir(STATE)
    except OSError:
        for k in ("state", "sendback_pending", "sendback", "lanes_active", "lanes",
                  "cloud_claims", "cloud", "merged_today", "merged_last"):
            print(k + "=unknown")
        sys.exit(2)
    print("state=ok")

    if dir_state(os.path.join(STATE, "sendback")) == "unreadable":
        print("sendback_pending=unknown"); print("sendback=unknown")
    else:
        try:
            ages = ["%s:%dm" % (os.path.basename(f), max(0, int((now - os.path.getmtime(f)) / 60)))
                    for f in unclaimed_sendbacks()]
        except OSError:
            ages = None
        if ages is None:
            print("sendback_pending=unknown"); print("sendback=unknown")
        else:
            print("sendback_pending=%d" % len(ages))
            shown = ages[:6] + (["+%d more" % (len(ages) - 6)] if len(ages) > 6 else [])
            print("sendback=" + (",".join(shown) if shown else "none"))

    if dir_state(LDIR) == "unreadable":
        print("lanes_active=unknown"); print("lanes=unknown")
    else:
        act = []
        for n in range(1, ALL_LANES + 1):
            d = load(n)
            if is_active(d): act.append("%s:%s" % (d.get("item", "?"), d.get("slug", "?")))
        print("lanes_active=%d" % len(act))
        print("lanes=" + (",".join(act) if act else "none"))

    if dir_state(CDIR) == "unreadable":
        print("cloud_claims=unknown"); print("cloud=unknown")
    else:
        try:
            claims = cloud_claims()
        except OSError:
            claims = None
        if claims is None:
            print("cloud_claims=unknown"); print("cloud=unknown")
        else:
            lab = []
            for c in claims:
                s = "%s:%s" % (c.get("item", "?"), c.get("slug", "?"))
                if c.get("status"): s += ":%s" % c["status"]
                lab.append(s)
            print("cloud_claims=%d" % len(lab))
            print("cloud=" + (",".join(lab) if lab else "none"))

    rows = merged_rows()
    if rows is None:
        print("merged_today=unknown"); print("merged_last=unknown")
    else:
        today = sg_time(now).strftime("%Y-%m-%d")
        todays = [f for f in rows if f[0] == today]
        print("merged_today=%d" % len(todays))
        print("merged_last=" + ("%s %s at %s" % (todays[-1][4], todays[-1][7], todays[-1][1])
                                if todays else "none"))

p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="c", required=True)
sub.add_parser("status").set_defaults(f=cmd_status)
i = sub.add_parser("idle"); i.add_argument("--ignore-pressure", action="store_true"); i.set_defaults(f=cmd_idle)
sub.add_parser("claimed").set_defaults(f=cmd_claimed)
sub.add_parser("host-ok").set_defaults(f=cmd_host_ok)

sub.add_parser("slugs").set_defaults(f=cmd_slugs)
fa = sub.add_parser("facts"); fa.add_argument("--now", type=float); fa.set_defaults(f=cmd_facts)
c = sub.add_parser("claim"); c.add_argument("lane", type=int); c.add_argument("--slug", required=True); c.add_argument("--item", required=True)
c.add_argument("--brief", required=True); c.add_argument("--mode", default="new", choices=["new", "rework"]); c.add_argument("--paths", nargs="+", default=[]); c.add_argument("--redeliver", action="store_true"); c.set_defaults(f=cmd_claim)
cc = sub.add_parser("cloud-claim"); cc.add_argument("--slug", required=True); cc.add_argument("--item", required=True); cc.add_argument("--brief", required=True); cc.add_argument("--paths", nargs="+", default=[]); cc.add_argument("--redeliver", action="store_true"); cc.set_defaults(f=cmd_cloud_claim)
cr = sub.add_parser("cloud-release"); cr.add_argument("slug"); cr.set_defaults(f=cmd_cloud_release)
sub.add_parser("cloud-list").set_defaults(f=cmd_cloud_list)
g = sub.add_parser("get"); g.add_argument("lane", type=int); g.set_defaults(f=cmd_get)
s = sub.add_parser("start"); s.add_argument("lane", type=int); s.add_argument("pid", type=int); s.set_defaults(f=cmd_start)
f = sub.add_parser("finish"); f.add_argument("lane", type=int); f.add_argument("--status", required=True); f.add_argument("--pr", default=""); f.add_argument("--note", default=""); f.set_defaults(f=cmd_finish)
# A claim is withdrawn by finishing the lane with a status other than claimed/running, and the
# line below spells that command out. Ledgers written since 2026-11-27 17:19 record
# `release <lane>` — a subcommand that never existed — so argparse's choice list, which does
# contain `finish`, taught the reader nothing. An unknown word gets the working command on
# stderr, before state is initialised, read or written. No `release` alias: it would let the
# next ledger record the wrong command again. --help (any leading "-") and every real
# subcommand still go through argparse exactly as before. The guard keys on being run as a
# program: test-lanes-history.sh loads this file with runpy and a stubbed parse_args to call a
# helper in place, and there argv[1] is the script path.
if __name__ == "__main__" and len(sys.argv) > 1 and not sys.argv[1].startswith("-") and sys.argv[1] not in sub.choices:
    sys.stderr.write("lanes.py: unknown subcommand: %s\n" % sys.argv[1])
    sys.stderr.write('  withdraw a claim: lanes.py finish <lane> --status cancelled --note "<why>"\n')
    sys.stderr.write("  subcommands: %s\n" % ", ".join(sorted(sub.choices)))
    sys.exit(2)
init_state()
a = p.parse_args(); a.f(a)
