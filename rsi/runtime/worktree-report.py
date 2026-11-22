#!/usr/bin/env python3
"""Report which git worktrees a retention policy could clear, without clearing any.

On 2026-11-22 the disk sat at 96 % while ``~/.kin/worktrees`` held 576 GB across 515
worktrees (488 of them ``rsi-*``); the naive ``du -sh`` over that tree took over ten
minutes, so nobody could answer the obvious question in bounded time. This is the
read-only answer:

    worktree-report.py [--repo DIR] [--state DIR] [--base REF] [--merged-log PATH]
                       [--json] [--min-age-days N] [--size-timeout S]
                       [--size-parallel N] [--now EPOCH]

It is a report, never a janitor. It runs only git readers (``worktree list``,
``status --porcelain``, ``rev-list``, ``log``) and ``du -skx``; it writes no file and
removes no branch and no worktree. There is no flag and no environment variable that
turns a removal on, and git is asked not to refresh indexes (``GIT_OPTIONAL_LOCKS=0``),
so a second run leaves every byte it read identical.

A fact it cannot read is ``unknown`` in the table and ``null`` in ``--json`` — never
``0``. The size pass is the slow one and is bounded by ``--size-timeout`` (default
20 s): ``du`` runs in parallel and whatever has not answered by the deadline is
``unknown``, with one summary line counting what was not measured. Each git call is
bounded too, so a wedged worktree cannot hang the report.

``reclaimable`` means all of: the branch is ``rsi/<slug>``; it is merged — either an
ancestor of ``--base`` (default ``origin/main``) or named by a ``merged`` PR line in the
merge record read from ``--merged-log`` (default ``<state>/merged.log``); the worktree is
clean; no active lane claims the slug; it is not locked; it is neither the worktree this
command runs in nor the worktree that holds ``<state>`` (the control tree's state is
gitignored, so it reads as clean); and its last commit is older than ``--min-age-days``
(default 1). Kin-managed ``kin/*`` worktrees and non-``rsi`` worktrees are reported and
never counted — they are not the loop's to judge.

The merge record is a second fact because this repository lands every PR with a squash
commit: a merged branch's own commits are never ancestors of ``main``. Each line the merge
lane writes is ``YYYY-MM-DD HH:MM PR #N <slug> <item> merged <sha> <url>``; only a line
with at least seven fields whose 3rd is ``PR``, 4th is ``#<digits>`` and 7th is exactly
``merged`` counts. A ``hold``/``closed``/``queued`` row, a bare slug, a comment or a
header is not a delivery record. A missing, unreadable or directory-shaped record is
unknown: it promotes nothing, while the ancestor fact still stands. The record never
overrides a disqualifier — a dirty or claimed worktree stays un-reclaimable whatever the
log says.

The claim check reads only ``<state>/lanes/<lane-number>.json`` (``--state``, then
``$RSI_STATE``, then ``$STATE``, then ``<repo>/rsi/state``); the per-lane artifacts
beside them (``<slug>.mutants.json`` and friends) are not lane state and are ignored.
A lane is active while its status is ``running`` with a live pid, or ``claimed``
within the same 25-minute TTL ``lanes.py`` uses. A missing lanes directory or an
unparseable lane file makes ``claimed`` unknown for every row, which excludes every
row: a report that cannot see the claims must not recommend clearing anything. So does
an empty lanes directory when neither ``--state`` nor ``$RSI_STATE`` was given: a lane
worktree carries an unused ``rsi/state/lanes`` of its own, and trusting it would offer
worktrees the real control state still holds.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

CLAIM_TTL = 25 * 60          # keep in step with lanes.py: a `claimed` lane expires after 25 min
GIT_TIMEOUT = 10             # seconds per git read; a wedged worktree reports unknown
SIZE_PARALLEL = 8            # `du` processes in flight during the size pass
BASE = "origin/main"


def repo_dir(arg: str | None) -> Path:
    """--repo, then $RSI_CTRL, then the repository this script sits in (rsi/runtime/../..)."""
    if arg:
        return Path(arg)
    if os.environ.get("RSI_CTRL"):
        return Path(os.environ["RSI_CTRL"])
    return Path(__file__).resolve().parent.parent.parent


def state_dir(arg: str | None, repo: Path) -> Path:
    if arg:
        return Path(arg)
    for key in ("RSI_STATE", "STATE"):
        if os.environ.get(key):
            return Path(os.environ[key])
    return repo / "rsi" / "state"


def git(path: Path | str, *args: str, timeout: float = GIT_TIMEOUT):
    """A bounded read-only git call; None means the fact could not be read."""
    env = dict(os.environ)
    # Status is a read. Without this, git may rewrite a stale index while reporting.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        return subprocess.run(["git", "-C", str(path), *args], capture_output=True,
                              text=True, env=env, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def list_worktrees(repo: Path):
    """(rows, error) from `git worktree list --porcelain`; a row per worktree."""
    proc = git(repo, "worktree", "list", "--porcelain", timeout=20)
    if proc is None or proc.returncode != 0:
        detail = "" if proc is None else proc.stderr.strip()
        return None, detail or "git worktree list failed"
    rows: list[dict] = []
    current: dict | None = None
    for line in proc.stdout.splitlines():
        if line.startswith("worktree "):
            if current:
                rows.append(current)
            current = {"path": line[len("worktree "):], "head": None,
                       "branch": None, "detached": False, "bare": False,
                       "locked": False}
        elif current is None:
            continue
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD "):].strip()
        elif line.startswith("branch "):
            current["branch"] = line[len("branch "):].strip()
        elif line == "detached":
            current["detached"] = True
        elif line == "bare":
            current["bare"] = True
        elif line == "locked" or line.startswith("locked "):
            current["locked"] = True
    if current:
        rows.append(current)
    for row in rows:
        ref = row["branch"]
        if ref:
            row["branch"] = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        elif row["bare"]:
            row["branch"] = "bare"
        else:
            row["branch"] = "detached"
    return rows, None


def merged_heads(repo: Path, base: str):
    """Every commit reachable from base, or None when the base cannot be resolved."""
    proc = git(repo, "rev-list", base, timeout=30)
    if proc is None or proc.returncode != 0:
        return None
    return set(proc.stdout.split())


PR_NUMBER = re.compile(r"#\d+\Z")


def merged_pr_slugs(path: Path):
    """Slugs named by a ``merged`` PR line in the merge record; None when it cannot be read.

    The merge lane writes ``YYYY-MM-DD HH:MM PR #N <slug> <item> merged <sha> <url>`` for
    each landed PR (merge.sh). A squash merge leaves the branch's commits outside ``main``,
    so this line is the only record that the branch landed. Only a row with at least seven
    fields, a ``PR`` 3rd field, a ``#<digits>`` 4th field and exactly ``merged`` 7th counts;
    ``hold``/``closed``/``queued`` rows, bare slugs, comments and headers are not facts.
    A missing, unreadable or directory-shaped log is unknown (None), never "no merges".
    """
    try:
        if not path.is_file():
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    slugs: set[str] = set()
    for line in text.splitlines():
        f = line.split()
        if len(f) < 7 or f[2] != "PR" or f[6] != "merged" or not PR_NUMBER.match(f[3]):
            continue
        slug = f[4][len("rsi/"):] if f[4].startswith("rsi/") else f[4]
        if slug:
            slugs.add(slug)
    return slugs


def commit_times(repo: Path, heads: list[str]) -> dict[str, int]:
    """HEAD sha -> committer timestamp in one call; a missing sha simply stays absent."""
    shas = sorted({h for h in heads if h})
    if not shas:
        return {}
    proc = git(repo, "log", "--no-walk", "--format=%H %ct", *shas, timeout=30)
    if proc is None or proc.returncode != 0:
        return {}
    out: dict[str, int] = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            out[parts[0]] = int(parts[1])
    return out


def dirty_map(paths: list[str], workers: int) -> dict[str, bool | None]:
    """path -> dirty, in parallel; unreadable is None (unknown), never False."""
    def one(path: str) -> bool | None:
        proc = git(path, "status", "--porcelain", "--untracked-files=normal")
        if proc is None or proc.returncode != 0:
            return None
        return bool(proc.stdout.strip())

    out: dict[str, bool | None] = {}
    if not paths:
        return out
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for path, value in zip(paths, pool.map(one, paths)):
            out[path] = value
    return out


def active_slugs(state: Path, now: float):
    """(set of active slugs, note). None means the claim check could not be trusted."""
    lanes = state / "lanes"
    if not lanes.is_dir():
        return None, f"no lanes directory at {lanes}"
    try:
        # lanes.py stores state as <lane-number>.json; the directory also holds per-lane
        # artifacts such as <slug>.mutants.json, which are not lane state.
        files = sorted(p for p in lanes.glob("*.json") if p.stem.isdigit())
    except OSError as exc:
        return None, f"cannot list {lanes}: {exc}"
    slugs: set[str] = set()
    broken: list[str] = []
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("lane state is not an object")
        except (OSError, ValueError):
            broken.append(path.name)
            continue
        status = data.get("status")
        active = False
        if status == "running":
            try:
                os.kill(int(data.get("pid", 0)), 0)
                active = True
            except (OSError, TypeError, ValueError):
                active = False
        elif status == "claimed":
            try:
                active = (now - float(data.get("claimed_at", 0))) < CLAIM_TTL
            except (TypeError, ValueError):
                active = False
        if active and data.get("slug"):
            slugs.add(str(data["slug"]))
    if broken:
        return None, "unparseable lane state: " + ", ".join(broken)
    return slugs, None


def size_map(paths: list[str], timeout: float, parallel: int):
    """(path -> bytes, timed_out). du -skx never follows symlinks; the deadline is hard."""
    measured: dict[str, int] = {}
    if not paths:
        return measured, False
    try:
        proc = subprocess.Popen(
            # -n 1: one du per path, so a worktree that finishes keeps its line even when
            # the deadline kills the batch; a batched du buffers and loses every line.
            ["xargs", "-0", "-n", "1", "-P", str(max(1, parallel)), "du", "-skx"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            # Own process group, so the deadline kills xargs and every du it started.
            start_new_session=True)
    except OSError:
        return measured, False
    payload = ("\0".join(paths) + "\0").encode()
    timed_out = False
    try:
        out, _ = proc.communicate(payload, timeout=max(0.0, timeout))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            # Retrying communicate() after a timeout keeps whatever was already read.
            out, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out = b""
    for line in out.decode("utf-8", "replace").splitlines():
        size, sep, path = line.partition("\t")
        if not sep:
            continue
        try:
            measured[path] = int(size) * 1024
        except ValueError:
            continue
    return measured, timed_out


def human_bytes(value: int | None) -> str:
    if value is None:
        return "unknown"
    size = float(value)
    for unit in ("B", "K", "M", "G", "T"):
        if size < 1024 or unit == "T":
            return f"{size:.1f}{unit}"
        size /= 1024
    return "unknown"


def is_rsi_worktree(branch: str, path: str) -> bool:
    """The count the disk survey used: an rsi/ branch, or an rsi-* directory (detached lanes)."""
    return branch.startswith("rsi/") or os.path.basename(path.rstrip("/")).startswith("rsi-")


def classify(row: dict, merged, dirty, claimed, age, current, control, min_age):
    """(reclaimable, reason) — every disqualifier is named, so a false row is readable."""
    branch = row["branch"]
    reasons: list[str] = []
    if row["bare"]:
        reasons.append("bare")
    elif branch == "detached":
        reasons.append("detached")
    elif branch.startswith("kin/"):
        reasons.append("kin-managed")
    elif not branch.startswith("rsi/"):
        reasons.append("not-rsi")
    if row["locked"]:
        reasons.append("locked")
    if control:
        reasons.append("control")
    if merged is None:
        reasons.append("merged unknown")
    elif not merged:
        reasons.append("unmerged")
    if dirty is None:
        reasons.append("dirty unknown")
    elif dirty:
        reasons.append("dirty")
    if claimed is None:
        reasons.append("claimed unknown")
    elif claimed:
        reasons.append("claimed")
    if current:
        reasons.append("current")
    if age is None:
        reasons.append("age unknown")
    elif age <= min_age:
        reasons.append(f"too-young ({age:.1f}d < {min_age:g}d)")
    return (not reasons), ("; ".join(reasons) if reasons else None)


def fmt_fact(value) -> str:
    return "unknown" if value is None else ("yes" if value else "no")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="read-only report of which worktrees a retention policy could clear")
    ap.add_argument("--repo", help="repo whose worktrees are read (default $RSI_CTRL, this repo)")
    ap.add_argument("--state", help="state dir (default $RSI_STATE, $STATE, repo/rsi/state)")
    ap.add_argument("--base", default=BASE, help=f"branch a merged worktree is an ancestor of (default {BASE})")
    ap.add_argument("--merged-log", help="merge record with one line per landed PR "
                    "(default <state>/merged.log)")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    ap.add_argument("--min-age-days", type=float, default=1.0,
                    help="a worktree must be older than this to count (default 1)")
    ap.add_argument("--size-timeout", type=float, default=20.0,
                    help="hard deadline for the parallel size pass, in seconds (default 20)")
    ap.add_argument("--size-parallel", type=int, default=SIZE_PARALLEL,
                    help=f"du processes in flight (default {SIZE_PARALLEL})")
    ap.add_argument("--now", type=float, default=None, help="pin the clock, in epoch seconds")
    a = ap.parse_args(argv)

    repo = repo_dir(a.repo)
    state = state_dir(a.state, repo)
    state_source = a.state or os.environ.get("RSI_STATE") or os.environ.get("STATE")
    now = time.time() if a.now is None else a.now

    rows, error = list_worktrees(repo)
    if rows is None:
        print(f"worktree-report: cannot read worktrees: {error}", file=sys.stderr)
        return 1

    merged = merged_heads(repo, a.base)
    if merged is None:
        print(f"worktree-report: cannot resolve {a.base}; merged is unknown for every row",
              file=sys.stderr)
    merged_log = Path(a.merged_log) if a.merged_log else state / "merged.log"
    pr_slugs = merged_pr_slugs(merged_log)
    ages = commit_times(repo, [r["head"] for r in rows])
    lanes, lane_note = active_slugs(state, now)
    if lanes is not None and not lanes and not state_source:
        # A lane worktree carries an empty rsi/state/lanes of its own; trusting that as
        # "no claims" would offer worktrees that the real control state still holds.
        lanes = None
        lane_note = f"no lane records in {state / 'lanes'}; pass --state or $RSI_STATE"
    if lane_note:
        print(f"worktree-report: claims are unknown ({lane_note}); nothing is reclaimable",
              file=sys.stderr)

    paths = [r["path"] for r in rows]
    dirty = dirty_map(paths, SIZE_PARALLEL)
    sizes, size_timed_out = size_map(paths, a.size_timeout, a.size_parallel)

    cwd = os.path.realpath(os.getcwd())
    state_real = os.path.realpath(state)
    report = []
    for row in rows:
        path = row["path"]
        real = os.path.realpath(path)
        current = cwd == real or cwd.startswith(real + os.sep)
        # The worktree that holds the lane state is the control tree: its rsi/state is
        # gitignored, so it looks clean, and clearing it would delete the loop's record.
        control = state_real == real or state_real.startswith(real + os.sep)
        slug = row["branch"][len("rsi/"):] if row["branch"].startswith("rsi/") else None
        if lanes is None:
            claimed = None
        else:
            claimed = bool(slug and slug in lanes)
        head = row["head"]
        # A squash merge leaves no ancestor, so the merge record is the second fact. It
        # only ever adds a merge; classify() still decides which facts can block a row.
        if merged is not None and head is not None and head in merged:
            is_merged, merged_by = True, "ancestor"
        elif slug and pr_slugs is not None and slug in pr_slugs:
            is_merged, merged_by = True, "pr-log"
        elif merged is None or head is None:
            is_merged, merged_by = None, None
        else:
            is_merged, merged_by = False, None
        age = None
        if head in ages:
            age = max(0.0, (now - ages[head]) / 86400.0)
        reclaimable, reason = classify(row, is_merged, dirty.get(path), claimed, age,
                                       current, control, a.min_age_days)
        report.append({
            "path": path,
            "branch": row["branch"],
            "head": head,
            "merged": is_merged,
            "merged_by": merged_by,
            "dirty": dirty.get(path),
            "claimed": claimed,
            "locked": row["locked"],
            "last_commit_age_days": None if age is None else round(age, 2),
            "bytes": sizes.get(path),
            "reclaimable": reclaimable,
            "reason": reason,
        })
    report.sort(key=lambda r: r["path"])

    free = None
    try:
        free = shutil.disk_usage(str(repo)).free
    except OSError:
        pass
    measured = sum(1 for r in report if r["bytes"] is not None)
    totals = {
        "worktrees": len(report),
        "rsi_worktrees": sum(1 for r in report if is_rsi_worktree(r["branch"], r["path"])),
        "free_bytes": free,
        "reclaimable_count": sum(1 for r in report if r["reclaimable"]),
        "sized": measured,
        "size_unknown": len(report) - measured,
        "size_timed_out": size_timed_out,
        "active_lanes": None if lanes is None else len(lanes),
    }

    if a.json:
        print(json.dumps({
            "generated_by": "rsi/runtime/worktree-report.py",
            "repo": str(repo),
            "state": str(state),
            "base": a.base,
            "min_age_days": a.min_age_days,
            "size_timeout_s": a.size_timeout,
            "claims": "unknown" if lanes is None else "ok",
            "claims_note": lane_note,
            "totals": totals,
            "worktrees": report,
        }, indent=2))
        return 0

    print("# generated by rsi/runtime/worktree-report.py from `git worktree list --porcelain`")
    print("# and `du -skx`; read-only: it removes no branch and no worktree, and writes nothing.")
    print(f"worktree-report: {totals['worktrees']} worktrees "
          f"({totals['rsi_worktrees']} rsi), {totals['reclaimable_count']} reclaimable, "
          f"free {human_bytes(free)}")
    if lanes is None:
        print(f"claims: unknown ({lane_note}); nothing is counted reclaimable")
    else:
        print(f"claims: {len(lanes)} active lane(s) read from {state / 'lanes'}")
    print(f"{'RECLAIM':<7} {'AGE':>9} {'SIZE':>9} {'MERGED':<7} {'DIRTY':<7} "
          f"{'CLAIMED':<8} {'WHY':<28} PATH [branch]")
    for r in report:
        age = "unknown" if r["last_commit_age_days"] is None else f"{r['last_commit_age_days']:.1f}d"
        why = r["reason"] or "-"
        print(f"{'yes' if r['reclaimable'] else 'no':<7} {age:>9} "
              f"{human_bytes(r['bytes']):>9} "
              f"{fmt_fact(r['merged']):<7} {fmt_fact(r['dirty']):<7} "
              f"{fmt_fact(r['claimed']):<8} {why:<28} "
              f"{r['path']} [{r['branch']}]")
    print(f"reclaimable: {totals['reclaimable_count']}")
    if size_timed_out:
        print(f"size: {measured} measured, {totals['size_unknown']} not measured (unknown); "
              f"deadline {a.size_timeout:g} s reached")
    else:
        print(f"size: {measured} measured, {totals['size_unknown']} not measured (unknown); "
              f"deadline {a.size_timeout:g} s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
