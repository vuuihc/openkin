#!/usr/bin/env python3
"""Rank where rework comes from, so the next process improvement is picked from data.

Every failed review or gate writes a note into ``state/sendback/done/``; every landed
PR writes a line into ``state/merged.log``. Nothing read them together: on 2026-11-21
the CEO spent an hour grepping 18 notes and 49 findings by hand to learn that the
dominant shape was "the PR body claims more than the diff does". That reading decides
which guard gets built next, and it must not depend on who opens the notes that morning.

    rework-attrib.py [--days N] [--state DIR] [--status] [--json]

Writes ``<state>/rework-attrib.md`` (ranked tables) and ``rework-attrib.json``;
``--status`` prints the one line a patrol shows. Deterministic only — no model, no
network, no repository writes:

* the note header ``item:`` / ``attempt:`` / ``kind:`` / ``source:`` is written by
  ``merge.sh``'s ``write_sendback()``, so who caught a round is a field, not a guess
  (``source: gate+review``, ``ux-gate``, ``mech``, ``hold-size``, ``ci`` …);
* for notes older than that header, the ``# Sent back by …`` title line is scanned
  for a fixed vocabulary, and anything unrecognised counts as ``other`` — never dropped,
  so the totals always add up;
* the path family comes from the ``## Fix list`` table's path cells.

A round is one distinct ``(item, attempt)``: a note copied into ``done/`` twice (a CEO
reconcile keeps the original) counts once, and a ``*.stale-<sha>.md`` file is a
*withheld* sendback whose head moved during review — counted separately, never as a
round. The rate is rounds per landed PR, so a PR that needed three rounds costs three.

A shape at 3 or more in the window is flagged: AGENTS.md says a pattern seen three
times graduates into a test or a rule, and this line makes "seen three times" a
measurement instead of a memory.

Window: trailing ``--days`` days (default 7) in the loop's timezone (+08), by note
mtime and by the timestamp in each ``merged.log`` line. Seams: ``--state``, then
``$RSI_STATE``, then ``$STATE``, then ``rsi/state``; ``--now`` pins the clock for tests.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

SGT = timezone(timedelta(hours=8))
STALL_BOUND = 3   # AGENTS.md: a pattern seen three times graduates

MERGED_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+PR\s+#(\d+)\b")
HEADER_RE = re.compile(r"^(item|attempt|kind|source|spec|cmd):\s*(.*)$")

# Prefixes of the paths a fix-list row cites; longest first so ui/src beats ui.
FAMILIES = (
    ("ui/src/", "ui"),
    ("web/dist/", "dist"),
    ("internal/api/", "go-api"),
    ("internal/", "go"),
    ("cmd/", "go"),
    ("rsi/runtime/", "rsi"),
    ("rsi/", "rsi"),
    ("desktop/", "desktop"),
    ("scripts/", "scripts"),
    ("docs/", "docs"),
)

# Title-line vocabulary, only used for notes written before the header carried `source:`.
CATCHERS = (
    ("independent review", "review"),
    ("sent back by dream", "dream"),
    ("sent back by ceo", "ceo"),
    ("gate failed", "gate"),
    ("gate_result=fail", "gate"),
    ("ux", "ux-gate"),
    ("ci build red", "ci"),
    ("ci red", "ci"),
)

SEVERITY = ("blocker", "major")


def state_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    for key in ("RSI_STATE", "STATE"):
        if os.environ.get(key):
            return Path(os.environ[key])
    return Path("rsi/state")


def header(text: str) -> dict[str, str]:
    """The `key: value` block merge.sh writes above the note body."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        hit = HEADER_RE.match(line)
        if hit:
            out[hit.group(1)] = hit.group(2).strip()
            continue
        if out:
            break          # the header is contiguous and comes first
    return out


def catcher(text: str, head: dict[str, str]) -> str:
    src = head.get("source", "").strip().lower()
    if src and src != "unknown":
        return src
    for line in text.splitlines():
        low = line.strip().lower()
        if not low or HEADER_RE.match(line.strip()):
            continue
        for needle, name in CATCHERS:
            if needle in low:
                return name
        break              # only the first prose line is the title
    return "other"


def family(path: str) -> str:
    p = path.strip().lstrip("./")
    for prefix, name in FAMILIES:
        if p.startswith(prefix):
            return name
    return "other"


def normalise_path(cell: str) -> str:
    """`ui/src/a.tsx:12` -> `ui/src/a.tsx`; `#L12`, `, line 12` and ranges too."""
    p = cell.strip().strip("`").strip()
    p = re.split(r":\d+|#L\d+|, line |\s+line\s+|\(\d+", p, maxsplit=1)[0]
    return p.strip().strip("`").strip()


PATH_TOKEN = re.compile(r"(?:ui/src|web/dist|internal|cmd|rsi|desktop|scripts|docs)/[\w./@+-]+")


def family_from_prose(text: str) -> str:
    """No fix-list table (notes older than the table)? Use the paths the body names."""
    fams = Counter(family(t) for t in PATH_TOKEN.findall(text))
    fams.pop("other", None)
    return fams.most_common(1)[0][0] if fams else "unknown"


def fix_rows(text: str) -> list[tuple[str, str]]:
    """(path, severity) per fix-list table row; empty when the note has no table."""
    rows = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) < 3:
            continue
        path = normalise_path(cells[1] if len(cells) > 3 else cells[0])
        if not re.search(r"\.[a-z0-9]{1,5}$", path) and "/" not in path:
            continue                       # header cell or prose
        sev = next((c.lower() for c in cells if c.lower() in SEVERITY), "")
        if not sev:
            continue
        rows.append((path, sev))
    return rows


def collect(state: Path, days: int, now: datetime) -> dict:
    since = now - timedelta(days=days)
    since_ts = since.timestamp()
    notes, stale, unreadable = [], 0, 0
    d = state / "sendback" / "done"
    if d.is_dir():
        for p in sorted(d.glob("*.md")):
            try:
                mtime = p.stat().st_mtime
            except OSError:
                unreadable += 1
                continue
            if mtime < since_ts:
                continue
            if ".stale-" in p.name:
                stale += 1
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                unreadable += 1
                continue
            notes.append({"file": p.name, "text": text,
                          "at": datetime.fromtimestamp(mtime, SGT)})
    merges, merge_times = [], []
    mlog = state / "merged.log"
    if mlog.is_file():
        try:
            for line in mlog.read_text(encoding="utf-8", errors="replace").splitlines():
                hit = MERGED_RE.match(line)
                if not hit:
                    continue
                try:
                    at = datetime.strptime(hit.group(1), "%Y-%m-%d %H:%M").replace(tzinfo=SGT)
                except ValueError:
                    continue
                if at >= since:
                    merges.append(int(hit.group(2)))
                    merge_times.append(at)
        except OSError:
            pass
    return {"since": since, "now": now, "notes": notes, "merges": merges,
            "merges_at": merge_times, "stale": stale, "unreadable": unreadable}


def summarise(data: dict) -> dict:
    seen: dict[tuple[str, str], dict] = {}
    for note in data["notes"]:
        head = header(note["text"])
        item = head.get("item", "")
        attempt = head.get("attempt", "")
        key = (item, attempt) if item and attempt else (note["file"], "")
        if key in seen:                     # the same round copied into done/ twice
            continue
        rows = fix_rows(note["text"])
        fams = Counter(family(p) for p, _ in rows)
        fam = fams.most_common(1)[0][0] if fams else family_from_prose(note["text"])
        seen[key] = {
            "file": note["file"], "at": note["at"], "catcher": catcher(note["text"], head),
            "family": fam, "kind": head.get("kind", ""), "attempt": attempt,
            "blocker": sum(1 for _, s in rows if s == "blocker"),
            "major": sum(1 for _, s in rows if s == "major"),
            "example": next((p for p, _ in rows), ""),
        }
    rounds = list(seen.values())
    shapes: Counter = Counter()
    by_shape = {}
    by_catcher: Counter = Counter()
    by_family: Counter = Counter()
    severity = Counter()
    attempts = Counter()
    for r in rounds:
        shape = f"{r['catcher']}·{r['family']}"
        shapes[shape] += 1
        by_catcher[r["catcher"]] += 1
        by_family[r["family"]] += 1
        severity["blocker"] += r["blocker"]
        severity["major"] += r["major"]
        attempts[r["attempt"] or "?"] += 1
        slot = by_shape.setdefault(shape, {"first": r["at"], "last": r["at"],
                                           "blocker": 0, "major": 0, "example": r["example"]})
        slot["first"] = min(slot["first"], r["at"])
        slot["last"] = max(slot["last"], r["at"])
        slot["blocker"] += r["blocker"]
        slot["major"] += r["major"]
        if not slot["example"]:
            slot["example"] = r["example"]
    total = len(rounds)
    ranked = sorted(shapes.items(), key=lambda kv: (-kv[1], kv[0]))
    return {
        "rounds": total,
        "merges": len(data["merges"]),
        "stale": data["stale"],
        "unreadable": data["unreadable"],
        "shapes": [{"shape": k, "n": n, "share": (n / total) if total else 0.0,
                    "first": by_shape[k]["first"].isoformat(),
                    "last": by_shape[k]["last"].isoformat(),
                    "blocker": by_shape[k]["blocker"], "major": by_shape[k]["major"],
                    "example": by_shape[k]["example"]} for k, n in ranked],
        "by_catcher": dict(by_catcher.most_common()),
        "by_family": dict(by_family.most_common()),
        "severity": {k: severity[k] for k in SEVERITY},
        "attempts": dict(sorted(attempts.items())),
        "since": data["since"].isoformat(),
        "now": data["now"].isoformat(),
        "days": (data["now"] - data["since"]).days,
        "recent24": _recent(data, rounds),
        "rounds_list": [{**r, "at": r["at"].isoformat()} for r in rounds],
    }


def _recent(data: dict, rounds: list) -> dict:
    cut = data["now"] - timedelta(hours=24)
    n = sum(1 for r in rounds if r["at"] >= cut)
    m = sum(1 for at in data["merges_at"] if at >= cut)
    return {"rounds": n, "merges": m}


def stamp(iso: str) -> str:
    """`2026-11-21T09:15:00+08:00` -> `11-21 09:15`, the only shape the tables show."""
    return iso[5:16].replace("T", " ")


def rate(summary: dict) -> float:
    return (summary["rounds"] / summary["merges"]) if summary["merges"] else 0.0


def status_line(summary: dict) -> str:
    merges = summary["merges"]
    head = (f"rework {summary['days']}d: {summary['rounds']} rounds / {merges} merges "
            f"({rate(summary):.2f})" if merges else
            f"rework {summary['days']}d: {summary['rounds']} rounds (merged.log unreadable)")
    top = summary["shapes"][0] if summary["shapes"] else None
    if not top:
        return head + "; no shapes"
    tail = f"top {top['shape']} {top['n']} ({top['share'] * 100:.0f}%)"
    stalled = [s["shape"] for s in summary["shapes"] if s["n"] >= STALL_BOUND]
    if stalled:
        tail += f"; {len(stalled)} at {STALL_BOUND}+: " + ", ".join(stalled[:3])
    return f"{head}; {tail}"


def markdown(summary: dict) -> str:
    att = " · ".join(f"{k}: {v}" for k, v in summary["attempts"].items())
    lines = [
        f"# Rework attribution — {summary['days']}d",
        "",
        f"window: {stamp(summary['since'])} → {stamp(summary['now'])} (+08)",
        f"rounds: **{summary['rounds']}** · merges: **{summary['merges']}** · "
        f"rework rate: **{rate(summary):.2f}** · withheld (head moved): {summary['stale']}"
        + (f" · unreadable: {summary['unreadable']}" if summary["unreadable"] else ""),
        f"rounds per PR by attempt: {att or '—'}",
        f"last 24h: {summary['recent24']['rounds']} rounds / {summary['recent24']['merges']} merges"
        + (f" ({summary['recent24']['rounds'] / summary['recent24']['merges']:.2f})"
           if summary['recent24']['merges'] else ""),
        "",
        "Generated by `rsi/runtime/rework-attrib.py` from `state/sendback/done/*.md`",
        "(the `source:` header field = who caught it, `## Fix list` = paths and severities)",
        "and `state/merged.log`. Deterministic, no model.",
        "",
        "## Shapes (who caught it · path family)",
        "",
        "| shape | rounds | share | blocker | major | first | last | example path |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for s in summary["shapes"]:
        ex = (s["example"] or "").replace("|", "\\|")
        lines.append(f"| `{s['shape']}` | {s['n']} | {s['share'] * 100:.0f}% | {s['blocker']} | "
                     f"{s['major']} | {stamp(s['first'])} | {stamp(s['last'])} | {ex} |")
    if not summary["shapes"]:
        lines.append("| — | 0 | — | 0 | 0 | — | — | no rework rounds in the window |")
    lines += ["", f"Severity across all rounds: blocker **{summary['severity']['blocker']}**, "
                  f"major **{summary['severity']['major']}**.", "", "## By catcher", ""]
    for name, n in summary["by_catcher"].items():
        lines.append(f"- `{name}`: {n}")
    lines += ["", "## By path family", ""]
    for name, n in summary["by_family"].items():
        lines.append(f"- `{name}`: {n}")
    stalled = [s for s in summary["shapes"] if s["n"] >= STALL_BOUND]
    lines += ["", f"## At {STALL_BOUND}+ (AGENTS.md: this must become a test or a rule)", ""]
    if stalled:
        for s in stalled:
            lines.append(f"- `{s['shape']}` ×{s['n']} — last {stamp(s['last'])}")
    else:
        lines.append("- none in this window")
    lines += [
        "",
        "## How this is used",
        "",
        "A mechanism row (`loop-guards`, a prompt, a merge-lane rule) is picked from the top of this",
        "table — the fill director names the row's shape and count in the brief — instead of from",
        "whichever note someone happened to open. Test of whether it worked: after the guard lands,",
        "does that shape's count fall, and did the guard come from this table?",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="rank where rework comes from")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--state")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--now", help="ISO timestamp, for tests")
    a = ap.parse_args(argv)
    if a.days < 1:
        print("rework-attrib: --days must be >= 1", file=sys.stderr)
        return 2
    now = datetime.fromisoformat(a.now).replace(tzinfo=SGT) if a.now else datetime.now(SGT)
    state = state_dir(a.state)
    summary = summarise(collect(state, a.days, now))
    if a.status:
        print(status_line(summary))
        return 0
    if a.json:
        print(json.dumps(summary, indent=2))
        return 0
    (state / "rework-attrib.md").write_text(markdown(summary), encoding="utf-8")
    (state / "rework-attrib.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(status_line(summary))
    print(f"wrote {state / 'rework-attrib.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
