#!/usr/bin/env python3
"""Count how much of the console's UI is still hand-written.

The design-system plan (docs/plans/2026-11-08-design-system-middle-layer.md)
measures itself with this script, so the numbers in the plan and the numbers
here cannot drift apart. Run it before and after each migration round:

    python3 scripts/ui_inventory.py

It reads ui/src/**/*.tsx, ignores *.test.tsx, and reports occurrences and
files for each primitive. Counts are textual, not semantic: a `<select>` in a
comment is excluded, but a `<button>` inside a string literal would not be.
That is precise enough for a trend, and it is the same measure every time.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ui" / "src"

COMMENT = re.compile(r"^\s*(\*|//|/\*)")


def sources() -> list[Path]:
    return sorted(p for p in SRC.rglob("*.tsx") if not p.name.endswith(".test.tsx"))


def scan(pattern: str, *, skip_comments: bool = False) -> tuple[int, int]:
    """Return (occurrences, files) for a regex over the non-test sources."""
    rx = re.compile(pattern)
    total = 0
    files = 0
    for path in sources():
        hits = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            if skip_comments and COMMENT.match(line):
                continue
            hits += len(rx.findall(line))
        if hits:
            total += hits
            files += 1
    return total, files


def main() -> int:
    rows = [
        ("裸 <button", *scan(r"<button")),
        ("kin-btn 类", *scan(r"kin-btn")),
        ("<input", *scan(r"<input")),
        ("kin-input 类", *scan(r"kin-input")),
        ("<textarea", *scan(r"<textarea")),
        ("原生 <select", *scan(r"<select", skip_comments=True)),
        ("<label", *scan(r"<label")),
        ('role="menu"', *scan(r'role="menu"')),
        ('role="listbox"', *scan(r'role="listbox"')),
        ('role="dialog"', *scan(r'role="dialog"')),
        ('role="tab"', *scan(r'role="tab"')),
        ('role="status"', *scan(r'role="status"')),
        ('role="alert"', *scan(r'role="alert"')),
        ("useAnchoredPanel", *scan(r"useAnchoredPanel")),
        ("createPortal", *scan(r"createPortal")),
        ("pushToast", *scan(r"pushToast")),
        ("rounded-* + border 表面", *scan(r"rounded-(?:lg|xl|2xl) border")),
    ]

    ui_dir = SRC / "components" / "ui"
    primitives = [p for p in ui_dir.glob("*.tsx") if not p.name.endswith(".test.tsx")]

    print(f"非测试 tsx 文件: {len(sources())}")
    print(f"components/ui 共享控件: {len(primitives)}")
    print()
    print("| 指标 | 出现次数 | 文件数 |")
    print("|---|---:|---:|")
    for name, total, files in rows:
        print(f"| {name} | {total} | {files} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
