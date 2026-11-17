#!/usr/bin/env python3
"""Track independent-review misses: RSI-merged PRs later reverted or reopened.

Writes $RSI_STATE/reviewer-misses.md (human) and reviewer-misses.json (machine).
--status prints a one-line summary; --update / default refreshes the files.
Network (gh) is best-effort and only feeds the reopened scan; git history is
enough to catch reverts. This is evidence for reviewer routing, not a gate.

Seams: RSI_STATE (or STATE) for the ledger directory, RSI_CTRL (or
MAIN_CHECKOUT) for the repo whose origin/main is scanned, RSI_GH_REPO to name
the GitHub repo for `gh` (otherwise it is read from `git remote get-url origin`;
with neither, the gh scan is skipped).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SGT = timezone(timedelta(hours=8))
MERGED_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+PR\s+#(?P<n>\d+)\s+(?P<slug>\S+)"
    r"(?:\s+(?P<item>\S+))?\s+merged\s+(?P<sha>[0-9a-f]{7,40})(?:\s+(?P<url>\S+))?",
    re.I,
)
SCORE_RE = re.compile(
    r"^\|\s*(?P<ts>\d{4}-\d{2}-\d{2}[^\|]*)\|\s*(?P<item>[^|]*)\|\s*`(?P<worker>[^`]*)`\s*\|\s*`(?P<reviewer>[^`]*)`",
)


def now() -> datetime:
    return datetime.now(SGT)


def state_dir() -> Path:
    env = os.environ.get("RSI_STATE") or os.environ.get("STATE")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "state"


def repo_dir() -> Path:
    env = os.environ.get("RSI_CTRL") or os.environ.get("MAIN_CHECKOUT")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent.parent


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> str:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
        return p.stdout or ""
    except Exception:
        return ""


def repo_slug(repo: Path) -> str:
    """The GitHub owner/name for `gh`, or "" when it cannot be determined."""
    env = os.environ.get("RSI_GH_REPO", "").strip()
    if env:
        return env
    url = run(["git", "remote", "get-url", "origin"], cwd=repo).strip()
    if not url:
        return ""
    if "://" in url:
        url = url.split("://", 1)[1]
        url = url.split("/", 1)[1] if "/" in url else ""
    elif ":" in url:
        url = url.split(":", 1)[1]
    url = re.sub(r"\.git$", "", url)
    parts = [p for p in url.split("/") if p]
    return "/".join(parts[-2:]) if len(parts) >= 2 else ""


def pull_url(slug: str, number: int | None) -> str:
    if not slug or not number:
        return ""
    return f"https://github.com/{slug}/pull/{number}"


def parse_merged(state: Path) -> list[dict]:
    p = state / "merged.log"
    if not p.is_file():
        return []
    out = []
    for line in p.read_text(errors="replace").splitlines():
        m = MERGED_RE.match(line.strip())
        if not m:
            continue
        d = m.groupdict()
        out.append(
            dict(
                ts=d["ts"].strip(),
                number=int(d["n"]),
                slug=d["slug"],
                item=(d.get("item") or "").strip(),
                sha=d["sha"],
                url=d.get("url") or "",
            )
        )
    return out


def reviewer_for(state: Path, number: int) -> str:
    p = state / "scorecard.md"
    if not p.is_file():
        return ""
    # Boundary after the digits: `pull/12` must not match `pull/123`, or a later
    # row for #123 would be attributed to #12's revert.
    url = re.compile(rf"pull/{number}(?!\d)")
    last = ""
    for line in p.read_text(errors="replace").splitlines():
        if f"[#{number}]" in line or url.search(line):
            m = SCORE_RE.match(line)
            if m:
                last = m.group("reviewer").strip()
    return last


def git_reverts(repo: Path) -> list[dict]:
    # A revert commit's subject starts with `Revert ` when git wrote it; a
    # hand-written one is only visible if it names the PR, which this keeps.
    out = run(
        [
            "git",
            "log",
            "origin/main",
            "--format=%H%x09%ad%x09%s",
            "--date=format-local:%Y-%m-%d %H:%M",
            "--grep=^Revert ",
            "--extended-regexp",
            "-n",
            "50",
        ],
        cwd=repo,
    )
    rows = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        sha, ts, subj = parts
        if not re.match(r"Revert ", subj):
            continue
        # Extract the reverted PR's number from the original subject.
        m = re.search(r"\(#(\d+)\)", subj)
        num = int(m.group(1)) if m else None
        rows.append(dict(kind="revert", sha=sha, ts=ts, subject=subj, number=num))
    return rows


def gh_reopened(slug: str) -> list[dict]:
    if not slug:
        return []
    raw = run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            slug,
            "--state",
            "all",
            "--search",
            "is:pr is:reopened",
            "--limit",
            "50",
            "--json",
            "number,title,url,state,updatedAt,closedAt,mergedAt",
        ]
    )
    try:
        items = json.loads(raw) if raw.strip() else []
    except Exception:
        return []
    rows = []
    for it in items:
        rows.append(
            dict(
                kind="reopened",
                number=it.get("number"),
                title=it.get("title") or "",
                url=it.get("url") or "",
                state=it.get("state") or "",
                ts=(it.get("updatedAt") or "")[:16].replace("T", " "),
            )
        )
    return rows


def cell(text: str | None) -> str:
    """A markdown table cell: a commit subject or PR title may contain a pipe."""
    return (text or "").replace("|", "\\|")


def write_report(state: Path, misses: list[dict], merged_n: int) -> Path:
    state.mkdir(parents=True, exist_ok=True)
    md = state / "reviewer-misses.md"
    js = state / "reviewer-misses.json"
    stamp = now().strftime("%Y-%m-%d %H:%M %Z")
    lines = [
        "# Reviewer misses",
        "",
        f"Updated {stamp}. RSI-merged PRs later reverted on main, or GitHub-reopened after a merge.",
        "This is a quality ledger for reviewer routing; it is evidence, not a gate.",
        "",
        f"Tracked merged PRs in `merged.log`: {merged_n}. Misses: {len(misses)}.",
        "",
    ]
    if not misses:
        lines.append("None found.")
    else:
        lines += [
            "| when | kind | PR | reviewer (scorecard) | note |",
            "|---|---|---|---|---|",
        ]
        for m in misses:
            pr = f"#{m['number']}" if m.get("number") else "—"
            if m.get("url"):
                pr = f"[{pr}]({m['url']})"
            lines.append(
                f"| {m.get('ts') or '—'} | {m.get('kind')} | {pr} | `{m.get('reviewer') or 'unknown'}` | {cell(m.get('note'))} |"
            )
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    js.write_text(json.dumps(dict(updated=stamp, misses=misses, merged=merged_n), indent=2) + "\n", encoding="utf-8")
    return md


def collect() -> tuple[list[dict], int]:
    state = state_dir()
    repo = repo_dir()
    slug = repo_slug(repo)
    merged = parse_merged(state)
    by_num = {m["number"]: m for m in merged}
    misses: list[dict] = []
    seen: set[tuple] = set()
    for r in git_reverts(repo):
        rec = dict(r)
        n = rec.get("number")
        if n is not None:
            rec["reviewer"] = reviewer_for(state, n)
            src = by_num.get(n)
            if src:
                rec["note"] = f"reverts RSI-merged {src.get('slug')} ({src.get('ts')})"
                rec["url"] = src.get("url") or pull_url(slug, n)
            else:
                rec["note"] = rec.get("subject") or ""
                rec["url"] = pull_url(slug, n)
        else:
            # Still record: a revert of an RSI change may omit the PR number.
            rec["note"] = rec.get("subject") or ""
        key = ("revert", rec.get("sha") or rec.get("subject"))
        if key in seen:
            continue
        seen.add(key)
        misses.append(rec)
    for r in gh_reopened(slug):
        n = r.get("number")
        # Only count PRs the merge lane actually landed (otherwise this is noise),
        # and a row with no number cannot be matched to a merge.
        if n not in by_num:
            continue
        rec = dict(r)
        rec["reviewer"] = reviewer_for(state, n)
        rec["note"] = rec.get("title") or "reopened after merge"
        rec["url"] = rec.get("url") or pull_url(slug, n)
        key = ("reopened", n)
        if key in seen:
            continue
        seen.add(key)
        misses.append(rec)
    misses.sort(key=lambda x: x.get("ts") or "", reverse=True)
    return misses, len(merged)


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        m = MERGED_RE.match(
            "2026-11-15 10:36 PR #65 merge-pipeline R-merge-pipeline merged 31b82cb1"
        )
        assert m and int(m.group("n")) == 65 and m.group("sha").startswith("31b82")
        s = SCORE_RE.match("| 2026-11-15 11:02 | R-x | `worker` | `reviewer` | PASS | [#65] |")
        assert s and s.group("reviewer") == "reviewer"
        print("reviewer-misses self-test ok")
        return 0
    misses, n = collect()
    state = state_dir()
    # --status is a read: it may print a stale report's rows, but it never refreshes
    # the files. Default and --update refresh; default also prints the summary line.
    update = "--update" in argv or "--status" not in argv
    if update:
        write_report(state, misses, n)
    if "--status" in argv or "--update" not in argv:
        print(f"reviewer misses: {len(misses)} (of {n} RSI-merged PRs in merged.log)")
        if "--status" in argv:
            path = state / "reviewer-misses.md"
            if path.is_file() and misses:
                # print just the table body
                for line in path.read_text().splitlines():
                    if line.startswith("| 20") or line.startswith("| —"):
                        print(line)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
