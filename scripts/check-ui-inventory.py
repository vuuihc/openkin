#!/usr/bin/env python3
"""Fail when the console's hand-written UI inventory grows.

`scripts/ui_inventory.py` measures the tree; this checker compares it with the
checked-in `scripts/ui-inventory-baseline.json`. Occurrences and files may only
go down; `--update` rewrites the baseline deliberately, in a reviewed change.

    python3 scripts/check-ui-inventory.py            # the gate
    python3 scripts/check-ui-inventory.py --update   # after a migration round

Missing, malformed or incomplete baselines fail closed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
DEFAULT_BASELINE = SCRIPTS / "ui-inventory-baseline.json"

sys.path.insert(0, str(SCRIPTS))
import ui_inventory  # noqa: E402

FIELDS = ("occurrences", "files")
NOTE = (
    "Console UI inventory ratchet. Counts come from scripts/ui_inventory.py and may only "
    "go down. Update deliberately with `python3 scripts/check-ui-inventory.py --update` "
    "after a migration round; an increase belongs in a reviewed PR with its reason."
)


class BaselineError(Exception):
    """The baseline cannot be trusted, so the gate must not pass."""


def load_baseline(path: Path = DEFAULT_BASELINE) -> dict[str, dict[str, int]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BaselineError(f"baseline not found: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise BaselineError(f"cannot read baseline {path}: {exc}") from exc

    if not isinstance(data, dict):
        raise BaselineError(f"{path}: top level must be an object")
    rows = data.get("metrics")
    if not isinstance(rows, dict) or not rows:
        raise BaselineError(f"{path}: `metrics` must be a non-empty object")

    tracked = {metric.key for metric in ui_inventory.METRICS}
    unknown = sorted(set(rows) - tracked)
    if unknown:
        raise BaselineError(f"{path}: unknown metric(s): {', '.join(unknown)}")
    missing = sorted(tracked - set(rows))
    if missing:
        raise BaselineError(f"{path}: missing metric(s): {', '.join(missing)}")

    out: dict[str, dict[str, int]] = {}
    for key, row in rows.items():
        if not isinstance(row, dict):
            raise BaselineError(f"{path}: `{key}` must be an object")
        values: dict[str, int] = {}
        for field in FIELDS:
            value = row.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise BaselineError(
                    f"{path}: `{key}.{field}` must be a non-negative integer, got {value!r}"
                )
            values[field] = value
        out[key] = values
    return out


def compare(
    current: dict[str, dict[str, int]], baseline: dict[str, dict[str, int]]
) -> list[str]:
    """Return one line per metric that grew; empty means the ratchet held."""
    problems: list[str] = []
    for metric in ui_inventory.METRICS:
        key = metric.key
        if key not in current:
            problems.append(f"{key} ({metric.label}): measurement is missing this metric")
            continue
        for field in FIELDS:
            now = current[key][field]
            allowed = baseline[key][field]
            if now > allowed:
                problems.append(
                    f"{key} ({metric.label}) {field}: {now} > baseline {allowed}"
                )
    return problems


def check(source: Path, baseline_path: Path) -> list[str]:
    if not ui_inventory.sources(source):
        raise BaselineError(f"no UI sources under {source}")
    return compare(ui_inventory.measure(source), load_baseline(baseline_path))


def write_baseline(source: Path, baseline_path: Path) -> dict[str, dict[str, int]]:
    if not ui_inventory.sources(source):
        raise BaselineError(f"no UI sources under {source}; refusing to write a zero baseline")
    current = ui_inventory.measure(source)
    # One metric per line: readable in review without a brace tower per row.
    rows = ",\n".join(
        f"    {json.dumps(metric.key)}: "
        f"{json.dumps({'label': metric.label, **current[metric.key]}, ensure_ascii=False)}"
        for metric in ui_inventory.METRICS
    )
    baseline_path.write_text(
        f'{{\n  "note": {json.dumps(NOTE, ensure_ascii=False)},\n'
        f'  "metrics": {{\n{rows}\n  }}\n}}\n',
        encoding="utf-8",
    )
    return current


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ui_inventory.SRC)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument(
        "--update",
        action="store_true",
        help="rewrite the baseline from the current tree (deliberate, reviewed change)",
    )
    args = parser.parse_args(argv)

    try:
        if args.update:
            current = write_baseline(args.source, args.baseline)
            print(f"UI_INVENTORY_UPDATED {args.baseline} ({len(current)} metrics)")
            return 0
        problems = check(args.source, args.baseline)
    except BaselineError as exc:
        print(f"UI_INVENTORY_ERROR: {exc}", file=sys.stderr)
        return 2

    if problems:
        print("UI_INVENTORY_FAIL: the console grew beyond its tracked baseline")
        for problem in problems:
            print(f"  - {problem}")
        print(
            "Migrate the new surface to an existing primitive, or make the increase "
            "deliberate with `python3 scripts/check-ui-inventory.py --update` in a "
            "reviewed change."
        )
        return 1

    print(f"UI_INVENTORY_OK ({len(ui_inventory.METRICS)} metrics within baseline)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
