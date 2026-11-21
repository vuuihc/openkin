#!/usr/bin/env python3
"""KIN-QUALITY-001 reading contract, checked without a browser.

The story's pixel rows are proven by the shipped `walk.mjs` `reading` op over
`rsi/runtime/ux/KIN-QUALITY-001-reading.json` through
`scripts/journeys-smoke.sh --spec`. This file runs the same `readingVerdict`
on synthetic metrics so the merge gate can red a rule change without a
daemon; `-B` keeps __pycache__ out of the tree.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WALK = ROOT / "rsi/runtime/ux/walk.mjs"
SPEC = ROOT / "rsi/runtime/ux/KIN-QUALITY-001-reading.json"
STORY = "KIN-QUALITY-001"

BASE = {
    "fixture": {"marker": True, "rows": 5},
    "viewport": {"width": 820, "height": 1180},
    "scrollPane": {"present": True, "top": 44, "height": 1000},
    "chrome": {"height": 44},
    "actions": [{"name": "Files · 2", "width": 44, "height": 44, "clipped": False}],
    "cells": [{"row": 0, "col": 0, "visible": True, "relation": "self"}],
    "lastRow": {"present": True, "visible": True, "fullyVisible": True},
    "newActivity": {"present": False, "covers": 0, "overlaps": 0},
}


def variant(**changes):
    metrics = copy.deepcopy(BASE)
    for path, value in changes.items():
        node = metrics
        keys = path.split(".")
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = value
    return metrics


def run_verdict(metrics: dict) -> tuple[int, dict]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(metrics, handle)
        path = handle.name
    try:
        done = subprocess.run(["node", str(WALK), "--reading-verdict", path],
                              capture_output=True, text=True, timeout=30)
    finally:
        Path(path).unlink(missing_ok=True)
    try:
        return done.returncode, json.loads(done.stdout)
    except json.JSONDecodeError:
        return done.returncode, {"raw": done.stdout, "stderr": done.stderr}


def expect(name: str, metrics: dict, code: int) -> list[str]:
    actual, verdict = run_verdict(metrics)
    if actual != code:
        return [f"{STORY}: {name}: exit {actual}, wanted {code}; verdict={json.dumps(verdict)[:400]}"]
    if code == 0 and not verdict.get("ok"):
        return [f"{STORY}: {name}: green exit but verdict not ok: {verdict}"]
    if code == 1 and verdict.get("ok"):
        return [f"{STORY}: {name}: red exit but verdict says ok"]
    return []


def spec_problems() -> list[str]:
    try:
        spec = json.loads(SPEC.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"{STORY}: cannot read {SPEC.relative_to(ROOT)}: {error}"]
    problems: list[str] = []
    viewports = spec.get("viewports") or {}
    expected = {"phone": ("390x844", True), "tablet": ("820x1180", True), "mac": ("1100x760", False)}
    for name, (size, touch) in expected.items():
        found = viewports.get(name)
        if isinstance(found, str):
            found = {"size": found}
        if not isinstance(found, dict):
            problems.append(f"{STORY}: fixture has no `{name}` viewport")
        elif found.get("size") != size or bool(found.get("hasTouch")) is not touch:
            problems.append(f"{STORY}: {name} is {found.get('size')!r} touch={found.get('hasTouch')!r}, wanted {size!r}/{touch}")
    journey = (spec.get("journeys") or {}).get("JQ1") or {}
    walked = sorted(n for n in viewports if n in (journey.get("viewports") or []))
    if walked != sorted(expected):
        problems.append(f"{STORY}: JQ1 walks {walked!r}, wanted {sorted(expected)!r}")
    flat = [step for step in (journey.get("steps") or []) if isinstance(step, list)]
    texts = [part for step in flat for part in step if isinstance(part, str)]
    if not any("[seed] reading" in text for text in texts):
        problems.append(f"{STORY}: JQ1 does not send `[seed] reading`")
    if not any("[seed] slow" in text for text in texts):
        problems.append(f"{STORY}: JQ1 does not send a `[seed] slow` follow-up")
    if ["reading", "table-bottom"] not in flat:
        problems.append(f"{STORY}: JQ1 has no `reading table-bottom`")
    if ["reading", "incoming", "require-new-activity"] not in flat:
        problems.append(f"{STORY}: JQ1 has no `reading incoming require-new-activity`")
    return problems


def phone_branch_problems() -> list[str]:
    """Without the phone header fallback, 390 can never be measured."""
    source = WALK.read_text(encoding="utf-8")
    needles = [
        ("const mobileBar = !bar ?", "the phone falls back to its header when the desktop bar is absent"),
        ("const actionRoot = bar || mobileBar;", "the measured action root includes that header"),
        ("[...document.querySelectorAll('header')].find(shown)", "the fallback finds the visible header"),
    ]
    return [f"{STORY}: walk.mjs lost the phone measurement branch: {why}"
            for needle, why in needles if needle not in source]


def check_sh_wiring_problems() -> list[str]:
    """A job nobody starts is no proof: the gate must run this file."""
    check = (ROOT / "scripts/check.sh").read_text(encoding="utf-8")
    problems = []
    if "job_quality_reading_contract()" not in check:
        problems.append(f"{STORY}: scripts/check.sh has no job_quality_reading_contract")
    if "python3 -B scripts/quality_001_reading_test.py" not in check:
        problems.append(f"{STORY}: job_quality_reading_contract does not run this file")
    if "start quality-reading-contract job_quality_reading_contract" not in check:
        problems.append(f"{STORY}: job_quality_reading_contract is defined but never started")
    return problems


def main() -> int:
    cases = [
        ("chrome 44 is green", variant(), 0),
        ("chrome 45 is red", variant(**{"chrome.height": 45}), 1),
        ("43x44 action is red", variant(actions=[{"name": "Files", "width": 43, "height": 44, "clipped": False}]), 1),
        ("a clipped action is red", variant(actions=[{"name": "Files", "width": 60, "height": 44, "clipped": True}]), 1),
        ("a cell centre that hits another element is red", variant(cells=[{"row": 0, "col": 0, "visible": True, "relation": "other"}]), 1),
        ("a partially visible last row is red", variant(**{"lastRow.fullyVisible": False}), 1),
        ("a new-activity control covering a cell is red", variant(newActivity={"present": True, "covers": 1, "overlaps": 0}), 1),
        ("a required new-activity control that is absent is red", variant(requireNewActivity=True), 1),
        ("an absent new-activity control with nothing covered is green", variant(newActivity={"present": False, "covers": 0, "overlaps": 0}), 0),
    ]
    problems: list[str] = []
    for name, metrics, code in cases:
        problems.extend(expect(name, metrics, code))
    problems.extend(spec_problems())
    problems.extend(phone_branch_problems())
    problems.extend(check_sh_wiring_problems())
    if problems:
        print("\n".join(problems))
        return 1
    print(f"{STORY}: reading verdict contract OK ({len(cases)} cases + fixture contract)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
