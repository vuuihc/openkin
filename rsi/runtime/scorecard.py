#!/usr/bin/env python3
"""Weekly fold and weekly report for the RSI scorecard.

`common.sh`'s `scorecard_row()` writes one table row per loop event and inserts
it immediately above the literal line `## Weekly fold`:

    | YYYY-MM-DD HH:MM | item | `worker` | `reviewer` | result | PR | FPY | note |

Nothing wrote that section. This tool does, from the same rows, with the
standard library only:

    scorecard.py report --week [--days N] [--state DIR]
    scorecard.py fold [--days N] [--dry-run] [--state DIR]

The state directory is `--state`, else `$RSI_STATE` (then `$STATE`), else
`rsi/state`; the scorecard is `<state>/scorecard.md`. The live file is local
loop state and is never committed — tests build fixtures in `mktemp -d`.

A "week" is a trailing window of `--days` days (default 7) ending now, in the
loop's local timezone (Asia/Singapore via `common.sh`). Rows are counted by
their first cell, `YYYY-MM-DD HH:MM`; older rows are ignored but left alone.

Outcome buckets come from the FPY cell (`pass`/`1st` -> merged, `patched`,
`rework`/`failed`, `blocked`, `pending`), falling back to the result text for
rows older than the FPY convention (`MERGED ...`, `no commits`, `blocked ...`).
A delivered item is a merged or patched row; its PR cell is printed as-is.

The fold block is bounded by HTML comment markers, so a second run replaces the
block instead of stacking, and every other byte of the file is preserved.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

BEGIN = "<!-- scorecard:fold:begin -->"
END = "<!-- scorecard:fold:end -->"
HEADING = "## Weekly fold"
TS_FMT = "%Y-%m-%d %H:%M"
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
SEP_RE = re.compile(r"^:?-{3,}:?$")
COST_RE = re.compile(r"\$(\d+(?:\.\d+)?)")

CELLS = 8
BUCKETS = ("merged", "patched", "rework", "blocked", "pending")

FPY_OUTCOME = {
    "pass": "merged",
    "1st": "merged",
    "merged": "merged",
    "patched": "patched",
    "rework": "rework",
    "reverted": "rework",
    "revert": "rework",
    "failed": "rework",
    "blocked": "blocked",
    "pending": "pending",
}


@dataclass
class Row:
    ts: datetime
    item: str
    result: str
    pr: str
    fpy: str
    cost: Decimal | None

    @property
    def outcome(self) -> str:
        key = self.fpy.strip().strip("`").lower()
        if key in FPY_OUTCOME:
            return FPY_OUTCOME[key]
        res = self.result.lower()
        if res.startswith("merged"):
            return "merged"
        if "no commits" in res:
            return "rework"
        if res.startswith("blocked") or "hold" in res:
            return "blocked"
        return "pending"


def warn(msg: str) -> None:
    print("warning: %s" % msg, file=sys.stderr)


def state_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    env = os.environ.get("RSI_STATE") or os.environ.get("STATE")
    if env:
        return Path(env)
    return Path("rsi/state")


def read_lines(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read().splitlines(True)


def write_lines(path: Path, lines: list[str]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        fh.write("".join(lines))
    os.replace(tmp, path)


def parse_rows(path: Path, now: datetime, days: float | None) -> list[Row]:
    """Parse the table rows inside the trailing window, warning on broken ones."""
    start = now - timedelta(days=days) if days is not None else None
    rows: list[Row] = []
    for lineno, raw in enumerate(read_lines(path), 1):
        line = raw.rstrip("\n").strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells and TS_RE.match(cells[0]):
            if len(cells) < CELLS:
                warn("%s:%d: skipping malformed scorecard row (%d cells, need %d)"
                     % (path, lineno, len(cells), CELLS))
                continue
            try:
                ts = datetime.strptime(cells[0], TS_FMT)
            except ValueError:
                warn("%s:%d: skipping scorecard row with unparseable time %r"
                     % (path, lineno, cells[0]))
                continue
            if start is not None and ts < start:
                continue
            cost = None
            m = COST_RE.search(cells[4])
            if m:
                try:
                    cost = Decimal(m.group(1))
                except InvalidOperation:
                    cost = None
            rows.append(Row(ts=ts, item=cells[1], result=cells[4],
                            pr=cells[5], fpy=cells[6], cost=cost))
            continue
        if all(SEP_RE.match(c) for c in cells if c) or cells[0].lower().startswith("time"):
            continue
        if len(cells) < CELLS:
            warn("%s:%d: skipping malformed scorecard row (%d cells, need %d)"
                 % (path, lineno, len(cells), CELLS))
    return rows


def totals_line(rows: list[Row]) -> str:
    counts = Counter(r.outcome for r in rows)
    head = "rows: %d" % len(rows)
    parts = ["%s: %d" % (b, counts[b]) for b in BUCKETS]
    return "- " + head + " · " + " · ".join(parts)


def cost_line(rows: list[Row]) -> str:
    total = sum((r.cost for r in rows if r.cost is not None), Decimal(0))
    if total == 0:
        return "- measured cost: none"
    return "- measured cost: $%s" % format(total, "f")


def fold_block(rows: list[Row], days: float, end: datetime) -> list[str]:
    out = [BEGIN, "### Weekly fold · %g days ending %s" % (days, end.strftime("%F"))]
    out.append(totals_line(rows))
    out.append(cost_line(rows))
    delivered = [r for r in rows if r.outcome in ("merged", "patched")]
    if not delivered:
        out.append("- delivered: none")
    else:
        out.append("- delivered:")
        for r in delivered:
            pr = "" if r.pr in ("", "-") else " " + r.pr
            out.append("  - %s%s · %s" % (r.item, pr, r.outcome))
    out.append(END)
    return out


def report(rows: list[Row], days: float, end: datetime, windowed: bool = True) -> list[str]:
    span = "%g days ending %s" % (days, end.strftime("%F")) if windowed else "all rows"
    out = ["Weekly report · %s" % span]
    out.append(totals_line(rows))
    if any(r.cost is not None for r in rows):
        out.append(cost_line(rows))
    groups: dict[str, dict[str, list[str]]] = {}
    order: list[str] = []
    for r in rows:
        g = groups.get(r.item)
        if g is None:
            g = groups[r.item] = {"pr": [], "fpy": []}
            order.append(r.item)
        if r.pr not in ("", "-") and r.pr not in g["pr"]:
            g["pr"].append(r.pr)
        fpy = r.fpy or "-"
        if fpy not in g["fpy"]:
            g["fpy"].append(fpy)
    for item in order:
        g = groups[item]
        prs = " ".join(g["pr"]) or "-"
        fpys = "/".join(g["fpy"]) or "-"
        out.append("- %s: %s · fpy %s" % (item, prs, fpys))
    return out


def strip_fold(lines: list[str], path: Path) -> list[str]:
    """Drop a previous fold block and the blank lines that framed it."""
    begins = [i for i, l in enumerate(lines) if l.strip() == BEGIN]
    ends = [i for i, l in enumerate(lines) if l.strip() == END]
    if not begins and not ends:
        return lines
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        raise SystemExit("%s: unpaired %s / %s marker; fix the file by hand"
                         % (path, BEGIN, END))
    i, j = begins[0], ends[0]
    lo, hi = i, j + 1
    while lo > 0 and lines[lo - 1].strip() == "":
        lo -= 1
    while hi < len(lines) and lines[hi].strip() == "":
        hi += 1
    return lines[:lo] + lines[hi:]


def insert_fold(lines: list[str], block: list[str], path: Path) -> list[str]:
    for i, l in enumerate(lines):
        if l.startswith(HEADING):
            head = i
            break
    else:
        raise SystemExit("%s: no %r heading; the scorecard format is fixed by "
                         "common.sh scorecard_row()" % (path, HEADING))
    i = head
    while i > 0 and lines[i - 1].strip() == "":
        i -= 1
    # Exactly one blank line on each side of the block. A blank line is its own
    # "\n" element: "" would vanish when the lines are joined.
    lead = [] if i == 0 else ["\n"]
    lines[i:head] = lead + [b + "\n" for b in block] + ["\n"]
    return lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="scorecard.py",
                                 description="Weekly report and fold for the RSI scorecard.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    rp = sub.add_parser("report", help="print the window's rows grouped by item")
    rp.add_argument("--week", action="store_true",
                    help="trailing window (default 7 days) instead of every row")
    rp.add_argument("--days", type=float, default=7.0)
    rp.add_argument("--state")

    fp = sub.add_parser("fold", help="write the weekly fold block")
    fp.add_argument("--days", type=float, default=7.0)
    fp.add_argument("--dry-run", action="store_true",
                    help="print the block and leave the scorecard byte-identical")
    fp.add_argument("--state")

    args = ap.parse_args(argv)
    path = state_dir(args.state) / "scorecard.md"
    if not path.is_file():
        print("scorecard.py: no scorecard at %s" % path, file=sys.stderr)
        return 1

    now = datetime.now()
    days = max(args.days, 0.0)
    # Every row when report has no window; otherwise the trailing window.
    window = None if args.cmd == "report" and not args.week else days
    rows = parse_rows(path, now, window)

    if args.cmd == "report":
        for line in report(rows, days, now, windowed=window is not None):
            print(line)
        return 0

    block = fold_block(rows, days, now)
    if args.dry_run:
        for line in block:
            print(line)
        return 0
    lines = strip_fold(read_lines(path), path)
    write_lines(path, insert_fold(lines, block, path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
