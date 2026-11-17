#!/usr/bin/env python3
"""pace.py — one line of urgency for a CEO patrol.

Local only (no network, no daemon): reads the loop's own ledgers and answers
"are we on pace for the phase target, and is the pipeline flowing?".

  python3 rsi/runtime/pace.py [--min-per-day N] [--json] [--repo DIR] [--state DIR]

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


def latencies(state, since):
    out = []
    for ln in lines(state / "merge" / "cycles.log"):
        m = STAMP.match(ln)
        if not m or " MERGED " not in ln:
            continue
        when = datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M")
        if when < since:
            continue
        n = LATENCY.search(ln)
        if n:
            out.append(int(n.group(1)))
    return out


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
    return 0 if verdict != "BEHIND" else 3


if __name__ == "__main__":
    sys.exit(main())
