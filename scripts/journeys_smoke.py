#!/usr/bin/env python3
"""Summarize one `rsi/runtime/ux/walk.mjs` run as a per-journey table.

Prints one row for **every journey x viewport pair `rsi/runtime/ux/journeys.json`
declares**, so a pair that produced no screens is a red row instead of a blank.
Reads `walk.json` and the spec only; stdlib only; no network.

Usage:
    python3 scripts/journeys_smoke.py --walk-json out/walk.json [--journeys J1,J2] [--proto DIR] [--json] [--spec PATH]

`--proto DIR` compares the walked journeys with mockup sheets named
`m<nn>-J<n>-*.png` (informational; a missing directory is a note, not a
failure). `--json` prints the machine summary instead of the table.

Exit: 0 when every declared pair has at least one screen and `hardFail` is
empty; 1 otherwise; 2 when walk.json or the spec is missing/unreadable
(prints `unavailable: <reason>`).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SPEC = os.path.join(ROOT, "rsi", "runtime", "ux", "journeys.json")
COLUMNS = (
    "journey", "viewport", "screens", "fails",
    "overflowX", "smallTapTargets", "rawSelects", "minBodyText",
)


class SpecError(Exception):
    """The declared matrix cannot be read."""


def load_json(path: str) -> object:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def declared_pairs(spec: dict, journeys_arg: str | None = None) -> list[tuple[str, str]]:
    """Every (journey, viewport) pair the spec declares, in spec order."""
    viewports = spec.get("viewports")
    journeys = spec.get("journeys")
    if not isinstance(viewports, dict) or not isinstance(journeys, dict):
        raise SpecError("spec needs a `viewports` and a `journeys` object")
    selected: set[str] | None = None
    if journeys_arg is not None:
        picked = unique([j.strip() for j in journeys_arg.split(",") if j.strip()])
        if not picked:
            raise SpecError("--journeys needs at least one journey id")
        unknown = [j for j in picked if j not in journeys]
        if unknown:
            raise SpecError(
                "unknown journey id: " + ", ".join(unknown) + " (known: " + ", ".join(journeys.keys()) + ")"
            )
        selected = set(picked)
    pairs: list[tuple[str, str]] = []
    for journey, body in journeys.items():
        if selected is not None and journey not in selected:
            continue
        names = (body or {}).get("viewports") or []
        if not names:
            raise SpecError(f"{journey} declares no viewports")
        for viewport in names:
            if viewport not in viewports:
                raise SpecError(f"{journey} declares unknown viewport {viewport!r}")
            pairs.append((journey, viewport))
    if not pairs:
        raise SpecError("spec declares no journey/viewport pairs")
    return pairs


def pair_fail_lines(hard_fail: list[str], journey: str, viewport: str) -> list[str]:
    """hardFail entries that belong to one pair.

    walk.mjs writes two shapes: `J2/mac: <step>` for step and page failures and
    `J2-mac-01-step: <reason>` for screenshot failures. Screen names continue
    with a number or `skipped`, so `J2-mac-` cannot swallow `J2-mac-wide-...`.
    """
    screen = re.compile(rf"^{re.escape(journey)}-{re.escape(viewport)}-(?:\d|skipped)")
    direct = f"{journey}/{viewport}:"
    return [line for line in hard_fail if line.startswith(direct) or screen.match(line)]


def build_rows(spec: dict, walk: dict, journeys_arg: str | None = None) -> list[dict]:
    screens = walk.get("screens")
    screens = [s for s in screens if isinstance(s, dict)] if isinstance(screens, list) else []
    hard = [str(f) for f in walk.get("hardFail") or []]
    rows = []
    for journey, viewport in declared_pairs(spec, journeys_arg):
        mine = [s for s in screens
                if s.get("journey") == journey and s.get("viewport") == viewport]
        lints = [s.get("lint") if isinstance(s.get("lint"), dict) else {} for s in mine]
        bodies = [lint["bodyText"] for lint in lints
                  if isinstance(lint.get("bodyText"), (int, float))]
        fails = pair_fail_lines(hard, journey, viewport)
        overflow = sum(1 for lint in lints if lint.get("overflowX"))
        rows.append({
            "journey": journey,
            "viewport": viewport,
            "screens": len(mine),
            "fails": len(fails),
            "overflow_x": overflow,
            "small_tap_targets": sum(int(lint.get("smallTapTargets") or 0) for lint in lints),
            "raw_selects": sum(int(lint.get("rawSelects") or 0) for lint in lints),
            "min_body_text": min(bodies) if bodies else None,
            # A pair with no screens was not covered; overflow is a hard
            # failure in walk.mjs, and hand-written fixtures may omit the line.
            "ok": bool(mine) and not fails and overflow == 0,
        })
    return rows


def print_table(rows: list[dict]) -> None:
    cells = [COLUMNS]
    for row in rows:
        cells.append(tuple(
            "-" if row["min_body_text"] is None and column == "minBodyText"
            else str(row[{"overflowX": "overflow_x", "smallTapTargets": "small_tap_targets",
                          "rawSelects": "raw_selects", "minBodyText": "min_body_text"}.get(column, column)])
            for column in COLUMNS
        ))
    widths = [max(len(line[i]) for line in cells) for i in range(len(COLUMNS))]
    for line in cells:
        print("  ".join(value.ljust(widths[i]) for i, value in enumerate(line)).rstrip())


def unique(items: list[str]) -> list[str]:
    """Order-preserving dedupe: a journey appears once, not once per viewport."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def proto_lines(proto_dir: str, declared: list[str], walked: list[str]) -> list[str]:
    """Compare walked journeys with the prototype sheets, informationally."""
    if not os.path.isdir(proto_dir):
        return [f"proto: {proto_dir} not found (no sheets compared)"]
    sheets = sorted(glob.glob(os.path.join(proto_dir, "m*.png")))
    covered: set[str] = set()
    for sheet in sheets:
        match = re.match(r"m\d+-J(\d+)-", os.path.basename(sheet))
        if match:
            covered.add("J" + match.group(1))
    lines = [f"proto: {len(sheets)} sheet(s) in {proto_dir}"]
    no_sheet = [j for j in declared if j not in covered]
    if no_sheet:
        lines.append("proto: no sheet covers " + ", ".join(no_sheet))
    uncovered_walk = [j for j in walked if j not in covered]
    if uncovered_walk:
        lines.append("proto: walked but no sheet: " + ", ".join(uncovered_walk))
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Summarize a journey walk as one table.")
    parser.add_argument("--walk-json", help="path to walk.mjs's walk.json")
    parser.add_argument("--journeys", metavar="LIST", help="comma-separated journey ids to check")
    parser.add_argument("--spec", default=DEFAULT_SPEC, help="journeys.json to read the matrix from")
    parser.add_argument("--proto", metavar="DIR", help="prototype sheet directory (informational)")
    parser.add_argument("--json", action="store_true", help="print the machine summary instead of the table")
    args = parser.parse_args(argv)

    if not args.walk_json:
        print("unavailable: --walk-json PATH is required", file=sys.stderr)
        return 2
    try:
        # Resolve the index through spec.py: after the body move an entry is a
        # path string, and `.get` on it would crash this summarizer.
        spec = json.loads(subprocess.check_output(
            [sys.executable, os.path.join(ROOT, "rsi", "runtime", "ux", "spec.py"),
             "--resolve", args.spec],
            stderr=subprocess.PIPE,
            encoding="utf-8",
        ))
        if not isinstance(spec, dict):
            raise SpecError("spec is not a JSON object")
        pairs = declared_pairs(spec, args.journeys)
    except subprocess.CalledProcessError as exc:
        print(f"unavailable: cannot read spec {args.spec}: {(exc.stderr or '').strip() or exc}",
              file=sys.stderr)
        return 2
    except (OSError, ValueError, SpecError) as exc:
        print(f"unavailable: cannot read spec {args.spec}: {exc}", file=sys.stderr)
        return 2
    try:
        walk = load_json(args.walk_json)
    except (OSError, ValueError) as exc:
        print(f"unavailable: cannot read walk.json {args.walk_json}: {exc}", file=sys.stderr)
        return 2
    if not isinstance(walk, dict):
        print(f"unavailable: {args.walk_json} is not a walk.mjs summary", file=sys.stderr)
        return 2

    rows = build_rows(spec, walk, args.journeys)
    hard = [str(f) for f in walk.get("hardFail") or []]
    ok = not hard and all(row["ok"] for row in rows)
    declared = unique([j for j, _ in pairs])
    screened = {s.get("journey") for s in walk.get("screens") or [] if isinstance(s, dict)}
    walked = [j for j in declared if j in screened]

    if args.json:
        doc: dict = {"ok": ok, "rows": rows, "fails": hard}
        if args.proto:
            doc["proto"] = proto_lines(args.proto, declared, walked)
        print(json.dumps(doc, indent=2))
    else:
        print_table(rows)
        for row in rows:
            if row["screens"] == 0:
                print(f"missing: {row['journey']}/{row['viewport']} produced no screens")
        if hard:
            print("failures:")
            for line in hard:
                print(f"  {line}")
        else:
            print("failures: none")
        if args.proto:
            for line in proto_lines(args.proto, declared, walked):
                print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
