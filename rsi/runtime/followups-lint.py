#!/usr/bin/env python3
"""Mark which open follow-ups already look landed, so a planner stops starting dead lanes.

The loop's process defects are written into ``state/followups.md``, one ``- [ ]`` line each,
usually naming the PR (``#480``) or commit (``a81cbaa1``) that should fix it. Nothing ever
checks that list, so it passed 1,600 lines and on 2026-11-21 a planner reading it nearly
started three lanes for work already on ``main``. This tool is the read-only answer:

    followups-lint.py [--state DIR] [--status] [--json] [--repo DIR] [--base REF]

Reads ``<state>/followups.md`` and ``<state>/merged.log`` and reports, per unchecked line,
whether any of its references looks landed:

* a PR number counts as landed when ``#<n>`` appears in ``merged.log`` (the merge lane's
  ``<date> <time> PR #<n> … merged <sha> <url>`` line). A bare ``/pull/42`` URL is not the
  marker — only the ``#<n>`` token is;
* a hex id counts as landed only when ``git cat-file -e`` resolves it *and*
  ``git merge-base --is-ancestor <sha> <base>`` exits 0 (``--base``, default
  ``origin/main``). An id that does not resolve locally is **open**: a shallow or stale
  clone must never produce a false "done".

It is a report, never an editor — no file is written, so ``followups.md``'s hash is identical
after any run. Exit 0 for every successful read (stale findings are not an error), exit 2 for
a usage error. Seams: ``--state`` then ``$RSI_STATE`` then ``$STATE`` then ``rsi/state``
under the repo; ``--repo`` then ``$RSI_CTRL`` then the repository this script lives in.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CHECKBOX_RE = re.compile(r"^\s*-\s+\[ \]\s*(.*)$")
PR_RE = re.compile(r"#(\d+)")
# In merged.log only a whole `#N` token is the marker, never digits inside another word.
MERGED_PR_RE = re.compile(r"(?<!\w)#(\d+)\b")
SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)

STALE, OPEN = "stale", "open"


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


def open_lines(text: str) -> list[tuple[int, str]]:
    """(1-based line number, text after the checkbox) for every unchecked line only."""
    rows = []
    for n, line in enumerate(text.splitlines(), 1):
        hit = CHECKBOX_RE.match(line)
        if hit:
            rows.append((n, hit.group(1).strip()))
    return rows


def refs_of(text: str) -> list[str]:
    """PR and hex references in the order they appear, deduplicated, shas lowercased."""
    found: list[tuple[int, str]] = []
    for m in PR_RE.finditer(text):
        found.append((m.start(), "#" + m.group(1)))
    for m in SHA_RE.finditer(text):
        found.append((m.start(), m.group(0).lower()))
    out: list[str] = []
    for _, ref in sorted(found, key=lambda pair: pair[0]):
        if ref not in out:
            out.append(ref)
    return out


def merged_prs(text: str) -> set[str]:
    """Every ``#<n>`` token in merged.log; a URL path or slug is not a marker.

    Kept as digit strings so a pathological run of digits cannot overflow int parsing.
    """
    return {n for line in text.splitlines() for n in MERGED_PR_RE.findall(line)}


def git(repo: Path, *args: str):
    try:
        return subprocess.run(["git", "-C", str(repo), *args],
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None


def sha_landed(sha: str, repo: Path, base: str, cache: dict[str, bool]) -> bool:
    """Ancestor of base, and only when the id resolves here: unresolved means open."""
    if sha in cache:
        return cache[sha]
    exists = git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    ok = exists is not None and exists.returncode == 0
    if ok:
        anc = git(repo, "merge-base", "--is-ancestor", sha, base)
        ok = anc is not None and anc.returncode == 0
    cache[sha] = ok
    return ok


def classify(items: list[tuple[int, str]], prs: set[str], repo: Path, base: str) -> list[dict]:
    cache: dict[str, bool] = {}
    rows = []
    for line, text in items:
        refs = refs_of(text)
        landed = None
        for ref in refs:
            if ref.startswith("#"):
                if ref[1:] in prs:
                    landed = ref
                    break
            elif sha_landed(ref, repo, base, cache):
                landed = ref
                break
        rows.append({"line": line, "text": text, "refs": refs, "landed": landed})
    return rows


def status_line(rows: list[dict]) -> str:
    landed = [r["landed"] for r in rows if r["landed"]]
    line = f"followups: {len(rows)} open, {len(landed)} look landed"
    if landed:
        line += f" ({', '.join(landed[:5])})"
    return line


def read(path: Path, label: str) -> str | None:
    """Missing/unreadable is a note on stderr and a zero contribution, never a crash."""
    if not path.is_file():
        print(f"followups-lint: no {label} at {path} — treating it as empty", file=sys.stderr)
        return None
    try:
        # utf-8-sig: a BOM must not eat the first follow-up line.
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        print(f"followups-lint: cannot read {path}: {exc} — treating it as empty", file=sys.stderr)
        return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="mark open follow-ups that already look landed")
    ap.add_argument("--state", help="state dir (default $RSI_STATE, $STATE, repo/rsi/state)")
    ap.add_argument("--status", action="store_true", help="one deterministic summary line")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    ap.add_argument("--repo", help="git repo for SHA checks (default $RSI_CTRL, this repo)")
    ap.add_argument("--base", default="origin/main", help="branch SHAs must be ancestors of")
    a = ap.parse_args(argv)

    repo = repo_dir(a.repo)
    state = state_dir(a.state, repo)
    followups = read(state / "followups.md", "followups.md")
    merged = read(state / "merged.log", "merged.log")
    if followups is None:
        rows: list[dict] = []
    else:
        rows = classify(open_lines(followups), merged_prs(merged or ""), repo, a.base)

    stale = sum(1 for r in rows if r["landed"])
    if a.status:
        print(status_line(rows))
        return 0
    if a.json:
        print(json.dumps({
            "open": len(rows),
            "stale": stale,
            "items": [{"line": r["line"], "refs": r["refs"], "landed": r["landed"]}
                      for r in rows],
        }, indent=2))
        return 0
    for r in rows:
        print(f"{STALE if r['landed'] else OPEN} {r['line']} {r['text'][:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
