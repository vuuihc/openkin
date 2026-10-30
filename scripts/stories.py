#!/usr/bin/env python3
"""Check the user-story registry against its contract files and its tests.

A story is a written contract under `docs/product/stories/` plus at least one
automated test that names its id. The registry is the index; the contract file
is the text; this script keeps the two and the tests honest.

Usage:
  python3 scripts/stories.py                  # check, print a summary
  python3 scripts/stories.py --write-coverage # check and rewrite COVERAGE.md
  python3 scripts/stories.py new AREA "title" [--journeys J1,J2] [--surfaces mac,phone]
                                              # scaffold a story before writing code

Exit status is nonzero when anything disagrees, so `scripts/check.sh` can use
it as a commit gate.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "docs" / "product" / "stories"
REGISTRY = DIR / "registry.json"
COVERAGE = DIR / "COVERAGE.md"

ID_RE = re.compile(r"^KIN-[A-Z]+-\d{3}$")
MENTION_RE = re.compile(r"KIN-[A-Z]+-\d{3}")
STATE_RE = re.compile(r"^状态：\s*(\w+)\s*$", re.M)
PRIORITY_RE = re.compile(r"^优先级：\s*(P[01])\s*$", re.M)
JOURNEY_RE = re.compile(r"^旅程：\s*(.+)$", re.M)
JOURNEY_SPLIT = re.compile(r"[、,，+\s]+")
ROUNDS_RE = re.compile(r"^分轮：\s*(\d+)\s*$", re.M)
SURFACES_RE = re.compile(r"^面：\s*(.+)$", re.M)
SURFACE_LABEL = {"mac": "Mac", "phone": "手机"}
DIFFERENCES_HEADING = "## 各面差异"

# The contract's skeleton. A story missing any of these is still being written,
# and the checker says so instead of letting a half-written story look approved.
REQUIRED_SECTIONS = (
    "## 谁、什么时候、为什么",
    "## 现在",
    "## 范围",
    "## 每一步的预期",
    "## 各面差异",
    "## 设计",
    "## Do not",
    "## 验收",
    "## 分轮",
    "## 证据",
    "## 变更记录",
)
# Every job-map step answers the same six questions; a blank one is a step
# nobody has thought through.
STEP_FIELDS = ("起点", "动作", "立刻看到", "慢 / 空 / 失败 / 断线", "键盘与焦点", "离开再回来")
# A cell that is only `<something>` is the template talking, not the author.
PLACEHOLDER_RE = re.compile(r"<[^<>]*>")

STATES = {"draft", "approved", "covered", "failing", "blocked"}
NEEDS_TEST = {"approved", "covered", "failing"}
TEST_GLOBS = ("*.test.ts", "*.test.tsx", "*_test.go")
SCAN_ROOTS = ("ui/src", "internal", "cmd", "desktop/src")
SKIP_DIRS = {"node_modules", "dist", ".git", "coverage", "artifacts"}


def load_registry() -> dict:
    if not REGISTRY.exists():
        raise SystemExit(f"missing registry: {REGISTRY}")
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid registry JSON: {exc}")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def iter_test_files():
    for root_name in SCAN_ROOTS:
        root = ROOT / root_name
        if not root.exists():
            continue
        for pattern in TEST_GLOBS:
            for path in root.rglob(pattern):
                if any(part in SKIP_DIRS for part in path.parts):
                    continue
                yield path


def has_heading(text: str, heading: str) -> bool:
    """True when `heading` is a whole line, so `## 范围` is not satisfied by `## 范围被删`."""
    return re.search(rf"^{re.escape(heading)}\s*$", text, re.M) is not None


def section(text: str, heading: str) -> str:
    """Body of a `##` section, without the next heading."""
    found = re.search(rf"^{re.escape(heading)}\s*$", text, re.M)
    if not found:
        return ""
    return text[found.end() :].split("\n## ", 1)[0]


def next_id(stories: list[dict], area: str) -> str:
    numbers = []
    pattern = re.compile(rf"^KIN-{re.escape(area)}-(\d{{3}})$")
    for story in stories:
        found = pattern.match(str(story.get("id", "")))
        if found:
            numbers.append(int(found.group(1)))
    return f"KIN-{area}-{max(numbers) + 1 if numbers else 1:03d}"


def cmd_new(argv: list[str]) -> int:
    """Scaffold a story: id, contract file, registry row, coverage table."""
    if len(argv) < 2:
        print('usage: stories.py new AREA "title" [--journeys J1,J2] [--surfaces mac,phone]', file=sys.stderr)
        print("       [--priority P0|P1] [--rounds N]", file=sys.stderr)
        return 2

    area, title = argv[0].upper(), argv[1]
    if area.startswith("KIN-"):
        area = area[4:]
    if not re.fullmatch(r"[A-Z]+", area):
        print(f"area must be letters like CONTINUE, got {argv[0]!r}", file=sys.stderr)
        return 2

    flags: dict[str, str] = {}
    rest = argv[2:]
    for index in range(0, len(rest) - 1, 2):
        if rest[index].startswith("--"):
            flags[rest[index][2:]] = rest[index + 1]

    data = load_registry()
    journeys = [name for name in JOURNEY_SPLIT.split(flags.get("journeys", "")) if name]
    unknown = [name for name in journeys if name not in (data.get("journeys") or {})]
    if unknown:
        print(f"unknown journeys: {unknown}", file=sys.stderr)
        return 2
    surfaces = [name for name in JOURNEY_SPLIT.split(flags.get("surfaces", "")) if name]
    unknown = [name for name in surfaces if name not in SURFACE_LABEL]
    if unknown:
        print(f"unknown surfaces: {unknown}", file=sys.stderr)
        return 2
    priority = flags.get("priority", "P0")
    if priority not in {"P0", "P1"}:
        print(f"priority must be P0 or P1, got {priority!r}", file=sys.stderr)
        return 2
    try:
        rounds = int(flags.get("rounds", "1"))
    except ValueError:
        print("rounds must be a number", file=sys.stderr)
        return 2
    if rounds < 1:
        print("rounds must be at least 1", file=sys.stderr)
        return 2

    stories = data.get("stories") or []
    story_id = next_id(stories, area)
    path = DIR / f"{story_id}.md"
    if path.exists():
        print(f"{path} already exists", file=sys.stderr)
        return 1

    text = read(DIR / "_TEMPLATE.md")
    labels = "、".join(SURFACE_LABEL[name] for name in surfaces)
    text = (
        text.replace("# KIN-<AREA>-NNN · <一件事，用户能感知的结果>", f"# {story_id} · {title}")
        .replace("优先级：P0", f"优先级：{priority}", 1)
        .replace("旅程：J1、J2", "旅程：" + "、".join(journeys), 1)
        .replace("面：Mac、手机", "面：" + labels, 1)
        .replace("分轮：3", f"分轮：{rounds}", 1)
    )
    path.write_text(text, encoding="utf-8")

    review_source = DIR / "_REVIEW.html"
    review_path = DIR / f"{story_id}.review.html"
    if review_source.exists() and not review_path.exists():
        review_text = read(review_source).replace("KIN-XXX-000", story_id)
        review_text = review_text.replace("· 设计草图", f"· {title} · 设计草图", 1)
        review_path.write_text(review_text, encoding="utf-8")

    stories.append(
        {
            "id": story_id,
            "state": "draft",
            "priority": priority,
            "journeys": journeys,
            "surfaces": surfaces,
            "plannedRounds": rounds,
            "title": title,
            "file": str(path.relative_to(ROOT)),
            "surface": "",
            "ownerPaths": [],
            "tests": [],
            "blockedReason": None,
        }
    )
    data["stories"] = stories
    REGISTRY.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    COVERAGE.write_text(coverage_text(data), encoding="utf-8")

    print(f"created {path.relative_to(ROOT)}")
    if review_path.exists():
        print(f"created {review_path.relative_to(ROOT)}")
    print(f"created registry entry {story_id} (draft)")
    print("next: fill it in per docs/product/stories/AUTHORING.md, then run stories.py")
    return 0


def check() -> list[str]:
    data = load_registry()
    problems: list[str] = []
    stories = data.get("stories")
    if not isinstance(stories, list):
        return ["registry.stories must be a list"]

    journeys = data.get("journeys") or {}
    seen: dict[str, dict] = {}

    for index, story in enumerate(stories):
        where = f"stories[{index}]"
        if not isinstance(story, dict):
            problems.append(f"{where}: not an object")
            continue

        story_id = story.get("id", "")
        if not isinstance(story_id, str) or not ID_RE.match(story_id):
            problems.append(f"{where}: id {story_id!r} is not KIN-<AREA>-NNN")
            continue
        where = story_id
        if story_id in seen:
            problems.append(f"{where}: duplicate id")
            continue
        seen[story_id] = story

        state = story.get("state")
        if state not in STATES:
            problems.append(f"{where}: state {state!r} not in {sorted(STATES)}")
        priority = story.get("priority")
        if priority not in {"P0", "P1"}:
            problems.append(f"{where}: priority {priority!r} must be P0 or P1")
        story_journeys = story.get("journeys")
        if not isinstance(story_journeys, list) or not story_journeys:
            problems.append(f"{where}: journeys must be a non-empty list")
            story_journeys = []
        else:
            for name in story_journeys:
                if name not in journeys:
                    problems.append(f"{where}: journey {name!r} not declared in registry.journeys")

        surfaces = story.get("surfaces")
        if not isinstance(surfaces, list) or not surfaces:
            problems.append(f"{where}: surfaces must be a non-empty list")
            surfaces = []
        else:
            for name in surfaces:
                if name not in SURFACE_LABEL:
                    problems.append(f"{where}: surface {name!r} not in {sorted(SURFACE_LABEL)}")

        if state == "blocked" and not (story.get("blockedReason") or "").strip():
            problems.append(f"{where}: blocked stories need blockedReason")

        rounds = story.get("plannedRounds")
        if not isinstance(rounds, int) or rounds < 1:
            problems.append(f"{where}: plannedRounds must be a positive integer")

        contract_path = ROOT / str(story.get("file", ""))
        if not story.get("file") or not contract_path.exists():
            problems.append(f"{where}: contract file missing: {story.get('file')!r}")
        else:
            text = read(contract_path)
            found_state = STATE_RE.search(text)
            found_priority = PRIORITY_RE.search(text)
            found_journey = JOURNEY_RE.search(text)
            if not found_state:
                problems.append(f"{where}: contract has no `状态：` line")
            elif found_state.group(1) != state:
                problems.append(
                    f"{where}: registry state {state!r} != contract state {found_state.group(1)!r}"
                )
            if not found_priority:
                problems.append(f"{where}: contract has no `优先级：` line")
            elif found_priority.group(1) != priority:
                problems.append(
                    f"{where}: registry priority {priority!r} != contract {found_priority.group(1)!r}"
                )
            if not found_journey:
                problems.append(f"{where}: contract has no `旅程：` line")
            else:
                declared = [j for j in JOURNEY_SPLIT.split(found_journey.group(1).strip()) if j]
                if sorted(declared) != sorted(story_journeys):
                    problems.append(
                        f"{where}: registry journeys {story_journeys!r} != contract {declared!r}"
                    )
            found_surfaces = SURFACES_RE.search(text)
            if not found_surfaces:
                problems.append(f"{where}: contract has no `面：` line")
            elif all(name in SURFACE_LABEL for name in surfaces):
                labels = [
                    label for label in SURFACE_LABEL.values() if label in found_surfaces.group(1)
                ]
                expected = [SURFACE_LABEL[name] for name in surfaces]
                if sorted(labels) != sorted(expected):
                    problems.append(
                        f"{where}: registry surfaces {expected!r} != contract {labels!r}"
                    )
                if not has_heading(text, DIFFERENCES_HEADING):
                    problems.append(f"{where}: contract has no `{DIFFERENCES_HEADING}` section")
                else:
                    body = section(text, DIFFERENCES_HEADING)
                    for label in expected:
                        if f"| {label} |" not in body:
                            problems.append(
                                f"{where}: {DIFFERENCES_HEADING} has no `| {label} |` row"
                            )
            found_rounds = ROUNDS_RE.search(text)
            if not found_rounds:
                problems.append(f"{where}: contract has no `分轮：` line")
            elif int(found_rounds.group(1)) != rounds:
                problems.append(
                    f"{where}: registry plannedRounds {rounds!r} != contract {found_rounds.group(1)}"
                )

            for heading in REQUIRED_SECTIONS:
                if not has_heading(text, heading):
                    problems.append(f"{where}: contract has no `{heading}` section")

            steps = [
                chunk for chunk in re.split(r"^### ", section(text, "## 每一步的预期"), flags=re.M)[1:]
            ]
            if not steps:
                problems.append(f"{where}: `## 每一步的预期` has no `### ` step")
            for chunk in steps:
                step_title = chunk.splitlines()[0].strip() if chunk.splitlines() else "?"
                if "<" in step_title:
                    problems.append(f"{where}: step title `{step_title}` is still a placeholder")
                for field in STEP_FIELDS:
                    if f"| {field} |" not in chunk:
                        problems.append(f"{where}: step `{step_title}` has no `{field}` row")
                        continue
                    row = re.search(
                        rf"^\|\s*{re.escape(field)}\s*\|(.*)\|\s*$", chunk, re.M
                    )
                    if row and PLACEHOLDER_RE.fullmatch(row.group(1).strip()):
                        problems.append(
                            f"{where}: step `{step_title}` still has a placeholder in `{field}`"
                        )

            if "<面的名字>" in text:
                problems.append(f"{where}: `归属面` is still a placeholder")

            if not re.search(r"^- \S", section(text, "## Do not"), re.M):
                problems.append(f"{where}: `## Do not` has no bullet")

            acceptance = section(text, "## 验收")
            if "Given" not in acceptance or "Then" not in acceptance:
                problems.append(f"{where}: `## 验收` has no Given / Then row")

            # From approval on, the readable design page is part of the contract:
            # a person signs the sketch, not a table of cells.
            if state != "draft":
                design = section(text, "## 设计")
                review = DIR / f"{story_id}.review.html"
                if f"{story_id}.review.html" not in design:
                    problems.append(f"{where}: `## 设计` does not name {story_id}.review.html")
                if not review.exists():
                    problems.append(f"{where}: design page missing: {review.name}")
                elif story_id not in read(review):
                    problems.append(f"{where}: {review.name} does not mention {story_id}")
                elif "（填）" in read(review):
                    problems.append(f"{where}: {review.name} still has template placeholders")
                elif "<h2>MECE" not in read(review):
                    problems.append(f"{where}: {review.name} has no MECE section")

        owner_paths = story.get("ownerPaths") or []
        if not isinstance(owner_paths, list):
            problems.append(f"{where}: ownerPaths must be a list")
        else:
            for owner in owner_paths:
                if not (ROOT / owner).exists():
                    problems.append(f"{where}: ownerPath missing: {owner}")

        tests = story.get("tests") or []
        if not isinstance(tests, list):
            problems.append(f"{where}: tests must be a list")
            tests = []
        for test_path in tests:
            path = ROOT / test_path
            if not path.exists():
                problems.append(f"{where}: test missing: {test_path}")
                continue
            if story_id not in read(path):
                problems.append(f"{where}: {test_path} does not mention {story_id}")

        if state in NEEDS_TEST and not tests:
            problems.append(f"{where}: state {state} needs at least one test that names {story_id}")

    # A test that names an unregistered id is a typo or a story nobody wrote.
    for path in iter_test_files():
        try:
            text = read(path)
        except OSError:
            continue
        for mentioned in set(MENTION_RE.findall(text)):
            if mentioned not in seen:
                problems.append(f"{path.relative_to(ROOT)}: mentions unregistered story {mentioned}")

    return problems


def coverage_text(data: dict) -> str:
    stories = sorted(
        data.get("stories", []),
        key=lambda s: (s.get("priority", "P9"), s.get("id", "")),
    )
    counts: dict[str, int] = {}
    for story in stories:
        counts[story.get("state", "?")] = counts.get(story.get("state", "?"), 0) + 1

    lines = [
        "# 故事覆盖",
        "",
        "由 `scripts/stories.py` 生成，不要手改。改 `registry.json` 后运行",
        "`python3 scripts/stories.py --write-coverage`。",
        "",
        "| 编号 | 状态 | 优先级 | 旅程 | 面 | 轮数 | 标题 | 测试 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for story in stories:
        tests = story.get("tests") or []
        lines.append(
            "| `{id}` | {state} | {priority} | {journey} | {surfaces} | {rounds} | {title} | {tests} |".format(
                id=story.get("id", ""),
                state=story.get("state", ""),
                priority=story.get("priority", ""),
                journey="、".join(story.get("journeys") or []),
                surfaces="/".join(
                    SURFACE_LABEL.get(name, name) for name in story.get("surfaces") or []
                ),
                rounds=story.get("plannedRounds", ""),
                title=story.get("title", "").replace("|", "\\|"),
                tests=len(tests),
            )
        )

    lines += ["", "## 汇总", ""]
    if not counts:
        lines.append("还没有故事。")
    else:
        lines.append(
            " · ".join(f"{state} {counts[state]}" for state in sorted(counts))
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if argv and argv[0] == "new":
        return cmd_new(argv[1:])

    problems = check()
    data = load_registry()
    expected = coverage_text(data)
    write = "--write-coverage" in argv

    if write:
        COVERAGE.write_text(expected, encoding="utf-8")
    elif not COVERAGE.exists():
        problems.append("COVERAGE.md missing; run with --write-coverage")
    elif COVERAGE.read_text(encoding="utf-8") != expected:
        problems.append("COVERAGE.md is stale; run with --write-coverage")

    stories = data.get("stories", [])
    counts: dict[str, int] = {}
    for story in stories:
        counts[story.get("state", "?")] = counts.get(story.get("state", "?"), 0) + 1
    summary = ", ".join(f"{state} {counts[state]}" for state in sorted(counts)) or "none"
    print(f"stories: {len(stories)} ({summary})")

    if problems:
        print("", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
