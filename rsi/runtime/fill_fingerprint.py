#!/usr/bin/env python3
"""Cheap input fingerprint for the fill director.

The paid director may be skipped only when every input that can create work is
byte-for-byte unchanged after a successful director run. All probe failures are
fail-open: the caller must run the director rather than risk missing work.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

VERSION = 3
DOGFOOD_THROTTLE_SECS = 6 * 60 * 60
DEFAULT_MAX_AGE = 45 * 60


class ProbeError(RuntimeError):
    pass


def run_cmd(cmd, timeout=12, env=None):
    """Run one probe, bounded, and kill its whole process tree on timeout.

    subprocess.run(timeout=...) kills the direct child only. A probe that waits on a
    nested process -- slices.py ready runs `lanes.py idle`, which can block on the lane
    flock -- would leave that descendant running past the timeout, so each probe gets its
    own session/process group and the group is SIGKILLed and reaped.
    """
    argv = [str(x) for x in cmd]
    try:
        p = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,
        )
    except OSError as e:
        raise ProbeError(f"{' '.join(argv)}: {e}")
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
        raise ProbeError(f"{' '.join(argv)}: timed out after {timeout}s")
    if p.returncode != 0:
        detail = (err or out).strip().splitlines()
        raise ProbeError(f"{' '.join(argv)}: exit {p.returncode}: {detail[-1] if detail else 'no output'}")
    return out


CLOUD_AGE_RE = re.compile(r"\bage=\d+m\b")


def canonical_cloud_list(text):
    """Drop elapsed age from `lanes.py cloud-list` rows.

    The formatter renders `age=<minutes>m`, so one unchanged outstanding claim has a
    different line every minute; hashing that text would invalidate a fingerprint taken
    during the director and pay for a repeat run. Every ownership field (item, slug,
    brief, paths) stays; an expired claim is reaped by cloud_claims() and disappears from
    the list, so expiry still changes the fingerprint.
    """
    return CLOUD_AGE_RE.sub("age=*", text)


ACTIVE_LANE_CLOCK_RE = re.compile(r"\b(age|silent)=\S+")


def canonical_active_lanes(text):
    """Keep every ACTIVE `lanes.py status` row across ALL_LANES, minus its clocks.

    `lanes.py claimed` prints unstarted claim numbers only and `idle` scans slots 1..MAX_LANES,
    so a running lane above a lowered limit -- which still reserves its paths -- appears in
    neither. When it finishes or crashes, newly dispatchable work would keep the same
    fingerprint. `status` covers ALL_LANES and carries each active lane's item, slug and paths;
    age and silent advance on their own, so only those two fields are blanked.
    """
    out = []
    for line in text.splitlines():
        if not line.startswith("lane ") or ": ACTIVE" not in line:
            continue
        out.append(ACTIVE_LANE_CLOCK_RE.sub(r"\1=*", line))
    return "\n".join(out)


def sha_text(text):
    return hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()


def sha_file(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as e:
        raise ProbeError(f"read {path}: {e}")


def tree_hash(root):
    root = Path(root)
    if not root.is_dir():
        return {"missing": True}
    items = []
    try:
        files = sorted(p for p in root.rglob("*") if p.is_file())
    except OSError as e:
        raise ProbeError(f"list {root}: {e}")
    for p in files:
        items.append([str(p.relative_to(root)), sha_file(p)])
    return {"missing": False, "files": items}


def files_hash(directory, pattern="*"):
    directory = Path(directory)
    items = []
    if not directory.is_dir():
        return items
    for p in sorted(directory.glob(pattern)):
        if p.is_file():
            items.append([p.name, sha_file(p)])
    return items


def markdown_section(path, heading):
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except OSError as e:
        raise ProbeError(f"read {path}: {e}")
    out, inside = [], False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = line.strip() == heading
            continue
        if inside:
            out.append(line)
    return "\n".join(out).strip()


def probe(repo, state, gh_repo, now=None):
    repo = Path(repo)
    state = Path(state)
    now = time.time() if now is None else float(now)
    env = os.environ.copy()
    env["RSI_STATE"] = str(state)
    gh = os.environ.get("RSI_FILL_FP_GH") or env.get("RSI_GH") or "gh"

    git_env = env.copy()
    git_env["GIT_TERMINAL_PROMPT"] = "0"
    origin_main = run_cmd(["git", "-C", repo, "rev-parse", "origin/main"], env=git_env).strip()
    head = run_cmd(["git", "-C", repo, "rev-parse", "HEAD"], env=git_env).strip()
    dirty = run_cmd(["git", "-C", repo, "status", "--porcelain", "--untracked-files=no"], env=git_env)
    dirty_diff = ""
    if dirty.strip():
        # HEAD, not the index: `git diff` alone shows unstaged changes only, so two
        # successive edits staged to the same file keep the same porcelain status and an
        # empty unstaged diff. --binary folds literal bytes in instead of a name-only line.
        dirty_diff = sha_text(run_cmd(
            ["git", "-C", repo, "diff", "HEAD", "--no-ext-diff", "--binary", "--"],
            timeout=20, env=git_env,
        ))

    runtime = repo / "rsi" / "runtime"
    slices_py = runtime / "slices.py"
    lanes_py = runtime / "lanes.py"
    slices_ready = run_cmd([sys.executable, slices_py, "ready", "--local"], timeout=45, env=env)
    cloud_pending = run_cmd([sys.executable, slices_py, "cloud-pending", "--json"], timeout=45, env=env)
    cloud_list = canonical_cloud_list(
        run_cmd([sys.executable, lanes_py, "cloud-list"], timeout=15, env=env))
    # Local dispatch capacity: a lane that finishes, crashes or releases its claim makes
    # work dispatchable again without touching the queue or GitHub. --ignore-pressure keeps
    # the free-lane set a function of lane state, not of the load average that moves every
    # few seconds; the director still applies the real idle gate before it dispatches.
    lanes_claimed = run_cmd([sys.executable, lanes_py, "claimed"], timeout=15, env=env)
    lanes_idle = run_cmd([sys.executable, lanes_py, "idle", "--ignore-pressure"], timeout=15, env=env)
    # Active lanes reserve paths at every slot, including rows above MAX_LANES after the limit
    # was lowered; `claimed` and `idle` miss those, so their identity and paths are hashed too.
    lanes_active = canonical_active_lanes(
        run_cmd([sys.executable, lanes_py, "status"], timeout=15, env=env))

    prs = run_cmd([
        gh, "pr", "list", "--repo", gh_repo, "--state", "open", "--limit", "100",
        "--json", "number,title,headRefName,headRefOid,mergeable,isDraft,labels,updatedAt",
    ], timeout=20, env=env)
    issues = run_cmd([
        gh, "issue", "list", "--repo", gh_repo, "--state", "open", "--limit", "100",
        "--json", "number,title,labels,updatedAt",
    ], timeout=20, env=env)

    dogfood = state / "dogfood"
    latest = 0.0
    latest_name = ""
    if dogfood.is_dir():
        for p in dogfood.glob("*.md"):
            try:
                mtime = p.stat().st_mtime
            except OSError as e:
                raise ProbeError(f"stat {p}: {e}")
            if mtime > latest:
                latest, latest_name = mtime, p.name

    payload = {
        "version": VERSION,
        "git": {"origin_main": origin_main, "head": head, "dirty": dirty, "dirty_diff": dirty_diff},
        "ready": slices_ready,
        "cloud_pending": cloud_pending,
        "cloud_list": cloud_list,
        "lanes": {"claimed": lanes_claimed, "idle": lanes_idle, "active": lanes_active},
        "github": {"prs": prs, "issues": issues},
        "queue": markdown_section(state / "STATUS.md", "## Queue"),
        "sendback": files_hash(state / "sendback", "*.md"),
        "merge_marks": files_hash(state / "merge", "*.blocked") + files_hash(state / "merge", "*.ceo-ok"),
        "gap_open": markdown_section(repo / "docs" / "plans" / "gap-log.md", "## Open"),
        "stories": tree_hash(repo / "docs" / "product" / "stories"),
        "ledger_inputs": {
            "followups": sha_file(state / "followups.md") if (state / "followups.md").exists() else "missing",
            "rework_attrib": sha_file(state / "rework-attrib.md") if (state / "rework-attrib.md").exists() else "missing",
            "needs_ceo": sha_file(state / "needs-ceo.md") if (state / "needs-ceo.md").exists() else "missing",
        },
        "repo_inputs": {
            "decisions": sha_file(repo / "rsi" / "DECISIONS.md"),
            "goal": sha_file(repo / "rsi" / "GOAL.md"),
        },
        "dogfood": {
            "latest_name": latest_name,
            "latest_mtime": int(latest),
            "throttled": bool(latest and now - latest < DOGFOOD_THROTTLE_SECS),
        },
        "control_flags": {
            name: (state / name).read_text(errors="replace") if (state / name).exists() else None
            for name in ("NO_MERGE", "NO_REMOTE_OVERFLOW", "BOX_OFF")
        },
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha_text(canonical), payload


def atomic_write(path, text):
    path = Path(path)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise ProbeError(f"write {path}: {e}")


def read_success(path):
    try:
        stamp, fp = Path(path).read_text().strip().split(None, 1)
        return float(stamp), fp.strip()
    except (OSError, ValueError):
        return None, None


def cmd_probe(args):
    fp, payload = probe(args.repo, args.state, args.gh_repo, args.now)
    if args.explain:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))
    else:
        print(fp)
    return 0


def cmd_check(args):
    fp, _ = probe(args.repo, args.state, args.gh_repo, args.now)
    state = Path(args.state)
    success = state / "fill-fingerprint"
    inflight = state / "fill-fingerprint.inflight"
    now = time.time() if args.now is None else float(args.now)
    stamp, old_fp = read_success(success)
    if not args.force and old_fp == fp and stamp is not None and now - stamp < args.max_age:
        print(f"skip: fill inputs unchanged since successful director ({int(now - stamp)}s ago)")
        return 10
    reason = "forced" if args.force else "no successful fingerprint" if old_fp is None else "inputs changed" if old_fp != fp else "periodic refresh"
    atomic_write(inflight, fp + "\n")
    print(f"run: {reason}")
    return 0


def cmd_record(args):
    fp, _ = probe(args.repo, args.state, args.gh_repo, args.now)
    state = Path(args.state)
    success = state / "fill-fingerprint"
    inflight = state / "fill-fingerprint.inflight"
    try:
        expected = inflight.read_text().strip()
    except OSError:
        expected = ""
    if not expected:
        print("not recorded: no inflight fingerprint")
        return 1
    try:
        inflight.unlink(missing_ok=True)
    except OSError:
        pass
    if expected != fp:
        print("not recorded: fill inputs changed during the director")
        return 1
    now = time.time() if args.now is None else float(args.now)
    atomic_write(success, f"{int(now)} {fp}\n")
    print("recorded: fill input fingerprint")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--gh-repo", default="vuuihc/openkin")
    ap.add_argument("--now", type=float)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe"); p.add_argument("--explain", action="store_true"); p.set_defaults(f=cmd_probe)
    c = sub.add_parser("check"); c.add_argument("--max-age", type=float, default=DEFAULT_MAX_AGE); c.add_argument("--force", action="store_true"); c.set_defaults(f=cmd_check)
    r = sub.add_parser("record"); r.set_defaults(f=cmd_record)
    args = ap.parse_args()
    try:
        return args.f(args)
    except ProbeError as e:
        print(f"probe failed: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
