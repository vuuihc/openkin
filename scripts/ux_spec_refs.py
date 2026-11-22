#!/usr/bin/env python3
"""Fail when a journey step still names a console surface that was retired.

The walk (`rsi/runtime/ux/walk.mjs`) resolves its selectors at browser time, so
a journey that names a retired area, an unregistered route or a `data-kin-*`
hook nothing renders survives every static check and reddens a ~20-minute
browser walk in the merge lane. #584's sendback was exactly that: J9 clicked
`[data-area="projects"]` after the same PR retired the area, and only the walk
noticed. This checker reads the live facts from the tree and reports the
journey, the step and the retired name in seconds.

    python3 -B scripts/ux_spec_refs.py
    python3 -B scripts/ux_spec_refs.py --spec <journeys.json> --root <tree>

The live facts are read from the tree, never from a copy:

  - area ids: the `id: "..."` rows of the AREAS table in
    `ui/src/lib/areas.ts` (the table `AreaNav.tsx` renders `data-area` from);
  - routes: every literal `<Route path="...">` in `ui/src/App.tsx`, comments
    stripped the way `ui/src/lib/routes.contract.test.ts:routePathsFrom` does;
  - `data-kin-*`: every literal attribute occurrence under `ui/src/`.

The journey spec is resolved through `rsi/runtime/ux/spec.py`, the reader the
loop's shell harnesses use, including its one-file-per-journey bodies;
`walk.mjs` carries its own equivalent loader, and both treat a missing or
empty body as fatal.

Exit 0 when clean, 1 when a step names a retired ref (one `FAIL` line per
finding on stderr), and 2 when a source cannot be read or yields zero areas,
zero routes or zero `data-kin` names: a checker that passes on a tree it could
not read is the hole it exists to close (STATUS Watch 76). A selector built at
runtime cannot be held against a literal scan, so it fails closed too.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_READER = ROOT / "rsi" / "runtime" / "ux" / "spec.py"
DEFAULT_SPEC = Path("rsi/runtime/ux/journeys.json")
UI_SRC = Path("ui/src")
AREAS_FILE = UI_SRC / "lib" / "areas.ts"
ROUTES_FILE = UI_SRC / "App.tsx"
# A hook is rendered by a component, not by a stylesheet rule or a test that
# fabricates the attribute; counting those mentions would let a retired hook
# pass exactly the walk this guard exists to spare.
RENDER_SUFFIXES = (".ts", ".tsx")

AREAS_TABLE = re.compile(r"export const AREAS = \[(.*?)\]\s*as const", re.S)
AREA_ROW = re.compile(r'\bid:\s*"([^"]+)"')
AREA_SELECTOR = re.compile(r'\[data-area="([^"]+)"\]')
KIN_ATTR = re.compile(r"data-kin-([a-z0-9-]+)")
ROUTE = re.compile(r'<Route\s+path="([^"]+)"')
PLACEHOLDER = re.compile(r"\{[^{}]+\}")
URL_CUT = re.compile(r"[(\[.?]")


class SourceError(Exception):
    """A source the gate needs cannot be read, so the gate must not pass."""


class SpecExited(Exception):
    """The shared reader already named the unreadable journey on stderr."""

    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise SourceError(f"not found: {path}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise SourceError(f"cannot read {path}: {exc}") from exc


def read_areas(root: Path) -> set[str]:
    """The area ids the console's one table declares.

    Comments are stripped first: an `id: "projects"` left in a comment is a
    mention, not a row, and counting it would readmit the retired area.
    """
    text = strip_js_comments(read_text(root / AREAS_FILE))
    match = AREAS_TABLE.search(text)
    if match is None:
        raise SourceError(f"{AREAS_FILE}: no AREAS table; cannot read the live areas")
    areas = set(AREA_ROW.findall(match.group(1)))
    if not areas:
        raise SourceError(f"{AREAS_FILE}: the AREAS table has no rows")
    return areas


def strip_js_comments(source: str) -> str:
    """Remove JSX `{/* ... */}` blocks and `/* */` / `//` comments."""
    source = re.sub(r"\{\/\*[\s\S]*?\*\/\}", "", source)
    source = re.sub(r"/\*[\s\S]*?\*/", "", source)
    return re.sub(r"//[^\n]*", "", source)


def read_routes(root: Path) -> list[str]:
    """The named routes the router registers, comments excluded."""
    routes = ROUTE.findall(strip_js_comments(read_text(root / ROUTES_FILE)))
    if not routes:
        raise SourceError(
            f"{ROUTES_FILE}: no literal <Route path=...>; cannot read the live routes"
        )
    # A catch-all is not a registration: it is the fallback a retired path
    # silently lands on, which is exactly the drift this guard catches. A tree
    # whose only route is the catch-all then fails closed below.
    named = [route for route in routes if route != "*"]
    if not named:
        raise SourceError(f"{ROUTES_FILE}: no named route, only the catch-all")
    return named


def read_kin_names(root: Path) -> set[str]:
    """Every literal `data-kin-*` hook a console component renders.

    Only component sources count, comments stripped: a CSS rule that selects
    `[data-kin-swiping]` or a test that fabricates `data-kin-bottom-chrome` is
    a mention, not a render, and would keep a retired hook green forever.
    """
    source = root / UI_SRC
    if not source.is_dir():
        raise SourceError(f"{source}: not a directory; cannot read data-kin hooks")
    names: set[str] = set()
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.suffix not in RENDER_SUFFIXES:
            continue
        if ".test." in path.name or ".spec." in path.name:
            continue
        names.update(KIN_ATTR.findall(strip_js_comments(read_text(path))))
    if not names:
        raise SourceError(f"{source}: no literal data-kin-* attribute anywhere")
    return names


def read_journeys(spec_path: Path) -> dict[str, dict]:
    """The spec with every journey body inlined, via the loop's spec reader."""
    if not spec_path.is_file():
        raise SourceError(f"journey spec not found: {spec_path}")
    spec = importlib.util.spec_from_file_location("ux_journey_reader", SPEC_READER)
    if spec is None or spec.loader is None:
        raise SourceError(f"cannot load the journey reader: {SPEC_READER}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except (OSError, SyntaxError) as exc:
        raise SourceError(
            f"cannot load the journey reader {SPEC_READER}: {exc}"
        ) from exc
    try:
        resolved = module.resolve(str(spec_path))
    except SystemExit as exc:
        # spec.py wrote the journey id and the file to stderr already; carry
        # its exit code instead of turning an unreadable body into a pass.
        code = exc.code if isinstance(exc.code, int) and exc.code else 2
        raise SpecExited(code) from exc
    journeys = resolved.get("journeys")
    if not isinstance(journeys, dict) or not journeys:
        raise SourceError(f"{spec_path}: the spec names no journeys")
    return journeys


def segments(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def goto_matches(path: str, routes: list[str]) -> bool:
    """Whether `path` names a registered route.

    A `:param` or `*` route segment and a `{placeholder}` goto segment each
    match exactly one segment, so `/tasks/{conversation}` matches
    `/tasks/:id` and `/projects` matches nothing once that route retires.
    """
    wanted = segments(path)
    for route in routes:
        pattern = segments(route)
        if len(pattern) != len(wanted):
            continue
        if all(
            want == part
            or part == "*"
            or part.startswith(":")
            or PLACEHOLDER.fullmatch(want)
            for part, want in zip(pattern, wanted)
        ):
            return True
    return False


def url_prefix(pattern: str) -> str | None:
    """The anchored literal part of a `url` regex, or None for the root."""
    text = pattern.strip()
    if text.startswith("^"):
        text = text[1:]
    if text.endswith("$"):
        text = text[:-1]
    # `\?`, `\(` … are literal characters, not regex syntax: unescape them
    # before deciding where the literal prefix ends.
    text = re.sub(r"\\([(\[.?])", r"\1", text)
    cut = URL_CUT.search(text)
    if cut is not None:
        text = text[: cut.start()]
    return text or None


def url_matches(pattern: str, routes: list[str]) -> bool:
    """Whether the regex's literal prefix starts with a live first segment."""
    prefix = url_prefix(pattern)
    if prefix is None:
        return True  # `^$` or `^/`: the root, which every tree has
    first = prefix.lstrip("/").split("/")[0]
    if not first or PLACEHOLDER.fullmatch(first):
        return True  # a placeholder-only prefix cannot be judged statically
    return any(segments(route)[:1] == [first] for route in routes)


def literal_names(
    jid: str, number: int, argument: str, attribute: str, pattern: re.Pattern[str]
) -> list[str]:
    """The values of `attribute` in one argument, or a fail-closed error.

    An occurrence the pattern cannot read (single quotes, spaces, a
    `data-kin-${...}` built at runtime) would silently pass a literal scan,
    which is the hole this guard closes, so it is reported instead.
    """
    names = pattern.findall(argument)
    if argument.count(attribute) != len(names):
        raise SourceError(
            f"{jid} step {number}: cannot check a non-literal {attribute} "
            f"selector: {argument}"
        )
    return names


def selector_findings(
    jid: str, number: int, argument: str, areas: set[str], kin: set[str]
) -> list[str]:
    findings: list[str] = []
    for area in literal_names(jid, number, argument, "data-area", AREA_SELECTOR):
        if area not in areas:
            findings.append(
                f"FAIL {jid} step {number}: [data-area] selector names a "
                f"retired area - {area}"
            )
    for name in literal_names(jid, number, argument, "data-kin-", KIN_ATTR):
        if name not in kin:
            findings.append(
                f"FAIL {jid} step {number}: [data-kin] selector nothing "
                f"renders - {name}"
            )
    return findings


def check_journeys(
    journeys: dict[str, dict], areas: set[str], routes: list[str], kin: set[str]
) -> list[str]:
    findings: list[str] = []
    for jid, journey in journeys.items():
        if not isinstance(journey, dict):
            raise SourceError(f"journey {jid}: body is not an object")
        steps = journey.get("steps")
        if not isinstance(steps, list) or not steps:
            raise SourceError(f"journey {jid}: no steps; cannot check it")
        for number, step in enumerate(steps, 1):
            if not isinstance(step, list) or not step:
                raise SourceError(f"journey {jid} step {number}: not a step")
            for argument in step:
                # `swipe` carries numbers; only strings can name a selector.
                if isinstance(argument, str):
                    findings.extend(
                        selector_findings(jid, number, argument, areas, kin)
                    )
            action = step[0]
            if not isinstance(action, str):
                raise SourceError(
                    f"journey {jid} step {number}: action is not a string"
                )
            if action == "goto":
                if len(step) < 2 or not isinstance(step[1], str):
                    raise SourceError(
                        f"journey {jid} step {number}: goto names no path"
                    )
                path = step[1].split("?")[0].split("#")[0]
                if not goto_matches(path, routes):
                    findings.append(
                        f"FAIL {jid} step {number}: goto names an unregistered "
                        f"route - {path}"
                    )
            elif action == "url":
                if len(step) < 2 or not isinstance(step[1], str):
                    raise SourceError(
                        f"journey {jid} step {number}: url names no pattern"
                    )
                if not url_matches(step[1], routes):
                    findings.append(
                        f"FAIL {jid} step {number}: url expectation names an "
                        f"unregistered route prefix - {step[1]}"
                    )
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="tree the console facts are read from (default: repository root)",
    )
    parser.add_argument(
        "--spec",
        type=Path,
        default=None,
        help=f"journey spec (default: <root>/{DEFAULT_SPEC})",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    spec_path = args.spec.resolve() if args.spec else root / DEFAULT_SPEC

    try:
        if not root.is_dir():
            raise SourceError(f"tree not found: {root}")
        areas = read_areas(root)
        routes = read_routes(root)
        kin = read_kin_names(root)
        journeys = read_journeys(spec_path)
        findings = check_journeys(journeys, areas, routes, kin)
    except SourceError as exc:
        print(f"UX_SPEC_REFS_ERROR: {exc}", file=sys.stderr)
        return 2
    except SpecExited as exc:
        return exc.code

    for line in findings:
        print(line, file=sys.stderr)
    if findings:
        print(
            "A journey step names a console surface that no longer exists. "
            "Update the step in rsi/runtime/ux/journeys/ (or restore the "
            "surface) before the walk spends a browser round on it.",
            file=sys.stderr,
        )
        return 1

    print(
        f"UX_SPEC_REFS_OK ({len(journeys)} journeys, {len(areas)} areas, "
        f"{len(routes)} routes, {len(kin)} data-kin names)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
