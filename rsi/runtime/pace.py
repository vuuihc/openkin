#!/usr/bin/env python3
"""pace.py — one line of urgency for a CEO patrol.

Local only (no network, no daemon): reads the loop's own ledgers and answers
"are we on pace for the phase target, and is the pipeline flowing?".

  python3 rsi/runtime/pace.py [--min-per-day N] [--json] [--latency] [--repo DIR] [--state DIR]

`--latency` adds a per-stage split of the same open->merge wait, for the 24h and
7d windows: verify is every verifier run at or before MERGED summed (a reworked
PR is verified more than once; each run includes gate-lock wait + gate + review,
never just the gate), verify_to_merge is the last verify line's minute to MERGED
(land lock, sync, merge command, plus any UX-gate/CI wait inside the landing
process), and pre_verify is what is left: open to the first verifier start and
any gap between runs (dispatch, slot queue, CI hold, rework wait). It also
reports the last recorded queue_wait per PR separately and verify split by
gate=ran / gate=cached, one entry per run. The log is minute-stamped, so every
stage here is minute resolution; a PR whose summed verify + verify_to_merge
exceeds open_to_merge is counted as n_negative and kept out of pre_verify rather
than printing a negative stage. Without the flag the output is byte-identical
to before.

Unshipped follows the release gate (release-check.sh), not the clock: the older of
the node=/hub= commits in state/last_release is the baseline, and every subject
between it and refs/remotes/origin/main ending in "(#N)" is unshipped. A PR merged
in the release minute therefore still reads unshipped. Only the local origin/main
ref is read — the patrol updates it — and when there is no usable marker or ref the
script falls back to the merged.log count; --json names the source that answered.

Sources
  state/last_release  `<target>=<sha>` per release target (node, hub)
  state/merged.log    one line per landed PR (time, PR, slug, item, sha)
  state/merge/cycles.log  `MERGED open_to_merge=NNm` per landed PR (latency)
  state/releases.log  `RELEASED <sha> node=.. hub=.. unshipped_before=..`
  rsi/GOAL.md         `<!-- phase: <name> target=YYYY-MM-DDTHH:MM -->`

Verdict is deliberately simple and falsifiable: ON-PACE when the last 24h
landed at least --min-per-day merges and the phase still has time left;
BEHIND otherwise; NO-PHASE when GOAL.md carries no marker. It is a prompt for
a decision (cut scope, unblock a lane), never a score to optimise.
"""
import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

RSI = Path(__file__).resolve().parents[1]  # rsi/
REPO = Path(__file__).resolve().parents[2]  # repo root
GOAL = RSI / "GOAL.md"
STATE = RSI / "state"
NOW = datetime.now()

STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})")
LATENCY = re.compile(r"open_to_merge=(\d+)m")
PRNUM = re.compile(r"#(\d+)\b")
VERIFY = re.compile(r"\bverify=(\d+)m")
GATE = re.compile(r"\bgate=(ran|cached)\b")
QUEUE_WAIT = re.compile(r"\bqueue_wait=(\d+)m")
PHASE = re.compile(r"<!--\s*phase:\s*(\S+)\s+target=(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})\s*-->")
PR_SUBJECT = re.compile(r"\(#[0-9]+\)$")


def lines(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def merge_times(state):
    out = []
    for ln in lines(state / "merged.log"):
        m = STAMP.match(ln)
        if m and " merged " in ln:
            out.append(datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M"))
    return out


def minute(ln):
    """The line's minute stamp, or None when it is unreadable (garbage log)."""
    m = STAMP.match(ln)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def latencies(state, since):
    out = []
    for ln in lines(state / "merge" / "cycles.log"):
        when = minute(ln)
        if when is None or when < since or " MERGED " not in ln:
            continue
        n = LATENCY.search(ln)
        if n:
            out.append(int(n.group(1)))
    return out


def stage_stats(vals):
    return {"n": len(vals), "p50": pct(vals, 0.5), "p90": pct(vals, 0.9),
            "max": max(vals) if vals else None}


def latency_split(state, since):
    """Split open->merge for merged PRs in the window; minute resolution.

    The log stamps minutes, so a verify=NNm line ends at its line's minute and
    started NN minutes earlier. Every verify= line at or before MERGED is one
    verifier run on the way to that merge, so verify is their sum: a reworked PR
    is verified more than once and joining only the last line hid the earlier
    gate=ran runs. The last line alone anchors verify_to_merge = MERGED minute -
    that line's minute, and pre_verify = open_to_merge - verify -
    verify_to_merge holds dispatch, slot queue, CI hold and any wait between
    runs. Each run is bucketed by its own gate=ran / gate=cached (n counts runs
    there, while verify.n counts merged PRs). queue_wait reports the last
    recorded wait per PR; a missing queue_wait= means none was recorded, not
    zero. A non-positive residual is counted in n_negative and left out of
    pre_verify instead of skewing it.
    """
    merged, verifies, queues = {}, {}, {}
    for ln in lines(state / "merge" / "cycles.log"):
        when = minute(ln)
        n = PRNUM.search(ln)
        if when is None or not n:
            continue
        pr = int(n.group(1))
        if " MERGED " in ln:
            o = LATENCY.search(ln)
            if o:
                merged[pr] = (when, int(o.group(1)))
        elif " verifier_started " in ln:
            q = QUEUE_WAIT.search(ln)
            if q:
                queues.setdefault(pr, []).append((when, int(q.group(1))))
        else:
            v = VERIFY.search(ln)
            if v:
                g = GATE.search(ln)
                verifies.setdefault(pr, []).append(
                    (when, int(v.group(1)), g.group(1) if g else "?"))

    pre, ver, vtm, qw, ran, cached = [], [], [], [], [], []
    negative = 0
    runs = 0
    in_window = {pr: ev for pr, ev in merged.items() if ev[0] >= since}
    for pr, (merged_at, open_min) in in_window.items():
        q = [x for x in queues.get(pr, []) if x[0] <= merged_at]
        if q:
            qw.append(max(q, key=lambda x: x[0])[1])
        seen = sorted((v for v in verifies.get(pr, []) if v[0] <= merged_at),
                      key=lambda v: v[0])
        if not seen:
            continue
        total_verify = sum(v for _, v, _ in seen)
        land = int((merged_at - seen[-1][0]).total_seconds() // 60)
        residual = open_min - total_verify - land
        if residual < 0:
            negative += 1
        else:
            pre.append(residual)
        ver.append(total_verify)
        vtm.append(land)
        runs += len(seen)
        for _, v_min, gate in seen:
            if gate == "ran":
                ran.append(v_min)
            elif gate == "cached":
                cached.append(v_min)

    wait = stage_stats(qw)
    wait["with_queue_wait"] = len(qw)
    return {"merged_n": len(in_window), "n_negative": negative,
            "verify_runs": runs,
            "pre_verify": stage_stats(pre), "verify": stage_stats(ver),
            "verify_to_merge": stage_stats(vtm), "queue_wait": wait,
            "verify_gate_ran": stage_stats(ran),
            "verify_gate_cached": stage_stats(cached)}


def stage_line(label, s, extra=""):
    def fmt(v):
        return f"{v}m" if v is not None else "-"
    return (f"  {label:<18} n={s['n']} p50={fmt(s['p50'])} "
            f"p90={fmt(s['p90'])} max={fmt(s['max'])}{extra}")


def print_latency(lat):
    for window in ("24h", "7d"):
        d = lat[window]
        print(f"latency by stage, {window} (n={d['merged_n']} merged; "
              f"minute resolution; verify = every verifier run before merge summed):")
        print(stage_line("pre_verify", d["pre_verify"],
                         f" skipped_negative={d['n_negative']}"))
        print(stage_line("verify", d["verify"],
                         f" runs={d['verify_runs']} summed over n merged PRs"))
        print(stage_line("verify_to_merge", d["verify_to_merge"]))
        print(stage_line("queue_wait", d["queue_wait"],
                         f" recorded={d['queue_wait']['with_queue_wait']}"
                         f"/{d['merged_n']} merged (missing != 0)"))
        print(stage_line("verify gate=ran", d["verify_gate_ran"]))
        print(stage_line("verify gate=cached", d["verify_gate_cached"]))


def last_release(state):
    for ln in reversed(lines(state / "releases.log")):
        if "RELEASED" in ln:
            m = STAMP.match(ln)
            if not m:
                continue
            when = datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M")
            sha = ln.split("RELEASED", 1)[1].split()[0] if "RELEASED" in ln else "?"
            return when, sha
    return None, None


def git(repo, *args):
    """stdout of a local git read, or None when git is missing or the read fails."""
    try:
        p = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


def baseline(repo, state):
    """The SHA the older release target last shipped, or None.

    Same rule as release-check.sh: node= and hub= are compared by ancestry, so a
    release that shipped the node but failed on the Hub is retried instead of
    counted done. A marker that is not a commit here counts as absent.
    """
    try:
        text = (state / "last_release").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    old = None
    for key in ("node", "hub"):
        m = re.search(rf"^{key}=(\S+)", text, re.MULTILINE)
        if not m:
            continue
        sha = m.group(1)
        if git(repo, "rev-parse", "--verify", "-q", sha + "^{commit}") is None:
            continue
        if old is None or git(repo, "merge-base", "--is-ancestor", sha, old) is not None:
            old = sha
    return old


def unshipped_from_git(repo, state):
    """(unshipped, commits) from the gate's baseline, or None when git cannot answer."""
    base = baseline(repo, state)
    if base is None:
        return None
    if git(repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/main") is None:
        return None
    log = git(repo, "log", "--format=%s", f"{base}..refs/remotes/origin/main")
    if log is None:
        return None
    subjects = log.splitlines()
    return sum(1 for s in subjects if PR_SUBJECT.search(s)), len(subjects)


def phase():
    for ln in lines(GOAL):
        m = PHASE.search(ln)
        if m:
            return m.group(1), datetime.strptime(m.group(2) + " " + m.group(3), "%Y-%m-%d %H:%M")
    return None, None


def pct(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    k = max(0, min(len(vals) - 1, int(round((len(vals) - 1) * p))))
    return vals[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-per-day", type=float, default=20.0,
                    help="24h merges below this is BEHIND (default 20; 11-15..17 held 22-95/day)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--latency", action="store_true",
                    help="add the pre_verify / verify / verify_to_merge split (24h and 7d)")
    ap.add_argument("--repo", default=None, help="checkout to count from (default: this repo)")
    ap.add_argument("--state", default=None, help="state dir (default: rsi/state beside this script)")
    a = ap.parse_args()
    repo = Path(a.repo) if a.repo else REPO
    state = Path(a.state) if a.state else STATE

    merges = merge_times(state)
    day_ago = NOW - timedelta(days=1)
    week_ago = NOW - timedelta(days=7)
    m24 = [t for t in merges if t >= day_ago]
    m7 = [t for t in merges if t >= week_ago]
    today = NOW.strftime("%Y-%m-%d")
    mtoday = [t for t in merges if t.strftime("%Y-%m-%d") == today]

    lat = latencies(state, day_ago)
    rel_at, rel_sha = last_release(state)
    counted = unshipped_from_git(repo, state)
    if counted is None:
        unshipped = len([t for t in merges if rel_at is None or t > rel_at])
        commits, source = unshipped, "merged.log"
    else:
        unshipped, commits = counted
        source = "git"

    name, target = phase()
    hours_left = (target - NOW).total_seconds() / 3600 if target else None

    if not name:
        verdict = "NO-PHASE"
    elif m24.__len__() >= a.min_per_day and (hours_left or 0) > 0:
        verdict = "ON-PACE"
    else:
        verdict = "BEHIND"

    data = {
        "merges_24h": len(m24), "merges_7d": len(m7), "merges_today": len(mtoday),
        "p50_open_to_merge_m": pct(lat, 0.5), "p90_open_to_merge_m": pct(lat, 0.9),
        "latency_n": len(lat),
        "last_release_sha": rel_sha,
        "last_release_at": rel_at.strftime("%Y-%m-%d %H:%M") if rel_at else None,
        "unshipped": unshipped, "commits": commits,
        "unshipped_source": source, "release_min": 5,
        "phase": name,
        "phase_target": target.strftime("%Y-%m-%d %H:%M") if target else None,
        "phase_hours_left": round(hours_left, 1) if hours_left is not None else None,
        "verdict": verdict,
    }
    if a.latency:
        data["latency"] = {"resolution_min": 1,
                           "24h": latency_split(state, day_ago),
                           "7d": latency_split(state, week_ago)}
    if a.json:
        print(json.dumps(data, ensure_ascii=False))
        return 0 if verdict != "BEHIND" else 3

    p50 = f"{data['p50_open_to_merge_m']}m" if data["p50_open_to_merge_m"] is not None else "-"
    p90 = f"{data['p90_open_to_merge_m']}m" if data["p90_open_to_merge_m"] is not None else "-"
    print(f"merges: 24h={data['merges_24h']} 7d={data['merges_7d']} today={data['merges_today']}")
    print(f"open->merge: p50={p50} p90={p90} (n={data['latency_n']}, 24h)")
    print(f"release: last {rel_sha} at {data['last_release_at']}, unshipped={unshipped}/5")
    if target:
        print(f"phase: {name} target={data['phase_target']} left={data['phase_hours_left']}h")
    print(f"pace verdict: {verdict}"
          + (f" ({len(m24)} merges/24h vs min {a.min_per_day:g})" if name else " (no phase marker in GOAL.md)"))
    if a.latency:
        print_latency(data["latency"])
    return 0 if verdict != "BEHIND" else 3


if __name__ == "__main__":
    sys.exit(main())
