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

`METRICS` and `measure()` are the API. The gate (`scripts/check-ui-inventory.py`)
and its tests read those, so the baseline, the CLI table and the ratchet can
never disagree about what a row means or how it is counted.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ui" / "src"

COMMENT = re.compile(r"^\s*(\*|//|/\*)")


@dataclass(frozen=True)
class Metric:
    """One tracked row: a stable key, a display label and its source pattern."""

    key: str
    label: str
    pattern: str
    skip_comments: bool = False


# The stable keys are the baseline contract. Rename a key only with a baseline
# update, and never drop one: the checker fails closed on a baseline row it
# cannot measure. `magic_z` is the ratchet's newest row — numeric stacking
# layers are the third thing a new file may not introduce (see the ESLint
# `no-new-ui-primitive` rule).
METRICS = (
    Metric("raw_button", "裸 <button", r"<button"),
    Metric("kin_btn_class", "kin-btn 类", r"kin-btn"),
    Metric("raw_input", "<input", r"<input"),
    Metric("kin_input_class", "kin-input 类", r"kin-input"),
    Metric("raw_textarea", "<textarea", r"<textarea"),
    Metric("native_select", "原生 <select", r"<select", skip_comments=True),
    Metric("raw_label", "<label", r"<label"),
    Metric("role_menu", 'role="menu"', r'role="menu"'),
    Metric("role_listbox", 'role="listbox"', r'role="listbox"'),
    Metric("role_dialog", 'role="dialog"', r'role="dialog"'),
    Metric("role_tab", 'role="tab"', r'role="tab"'),
    Metric("role_status", 'role="status"', r'role="status"'),
    Metric("role_alert", 'role="alert"', r'role="alert"'),
    Metric("use_anchored_panel", "useAnchoredPanel", r"useAnchoredPanel"),
    Metric("create_portal", "createPortal", r"createPortal"),
    Metric("push_toast", "pushToast", r"pushToast"),
    Metric("rounded_border_surface", "rounded-* + border 表面", r"rounded-(?:lg|xl|2xl) border"),
    Metric("magic_z", "z-[n] 数字层级", r"(?<![\w-])z-\[[0-9]+\]"),
)


def sources(src: Path = SRC) -> list[Path]:
    return sorted(p for p in src.rglob("*.tsx") if not p.name.endswith(".test.tsx"))


def scan(pattern: str, *, src: Path = SRC, skip_comments: bool = False) -> tuple[int, int]:
    """Return (occurrences, files) for a regex over the non-test sources."""
    rx = re.compile(pattern)
    total = 0
    files = 0
    for path in sources(src):
        hits = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            if skip_comments and COMMENT.match(line):
                continue
            hits += len(rx.findall(line))
        if hits:
            total += hits
            files += 1
    return total, files


def measure(src: Path = SRC) -> dict[str, dict[str, int]]:
    """Measure every tracked metric under `src`, keyed by `Metric.key`."""
    out: dict[str, dict[str, int]] = {}
    for metric in METRICS:
        occurrences, files = scan(metric.pattern, src=src, skip_comments=metric.skip_comments)
        out[metric.key] = {"occurrences": occurrences, "files": files}
    return out


def per_file(pattern: str) -> list[tuple[int, str]]:
    """Occurrences per file, biggest first, for planning a migration round."""
    rx = re.compile(pattern)
    out = []
    for path in sources():
        hits = sum(len(rx.findall(line)) for line in path.read_text(encoding="utf-8").splitlines())
        if hits:
            out.append((hits, str(path.relative_to(ROOT))))
    return sorted(out, reverse=True)


def main() -> int:
    print(f"非测试 tsx 文件: {len(sources())}")
    ui_dir = SRC / "components" / "ui"
    primitives = [p for p in ui_dir.glob("*.tsx") if not p.name.endswith(".test.tsx")]
    print(f"components/ui 共享控件: {len(primitives)}")
    print()
    print("| 指标 | 出现次数 | 文件数 |")
    print("|---|---:|---:|")
    measured = measure()
    for metric in METRICS:
        row = measured[metric.key]
        print(f"| {metric.label} | {row['occurrences']} | {row['files']} |")

    print()
    print("裸 <button> 最多的 12 个文件（迁移轮次按这个排）：")
    print()
    print("| 文件 | 次数 |")
    print("|---|---:|")
    for hits, path in per_file(r"<button")[:12]:
        print(f"| `{path}` | {hits} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
