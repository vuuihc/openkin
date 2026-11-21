#!/usr/bin/env python3
"""Fail when a surface this repository deliberately deleted comes back.

`scripts/removed-surfaces.txt` is the record: one repo-relative path per line,
`#` comments allowed. The 2026-11-10 audit deleted `/inbox`, `/approvals` and
the helpers behind them; a later merge restored the files and every check
stayed green because nothing watched the deletion. This checker fails when any
listed path exists again, as a file or a directory.

    python3 scripts/check-removed-surfaces.py
    python3 scripts/check-removed-surfaces.py --source <tree> --manifest <list>

Missing, empty or malformed manifests fail closed: a record that cannot be
trusted must not report success.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / "scripts" / "removed-surfaces.txt"


class ManifestError(Exception):
    """The manifest cannot be trusted, so the gate must not pass."""


def parse_manifest(text: str, origin: Path) -> list[str]:
    """Return the listed paths, or raise when a line is not a safe relative path."""
    paths: list[str] = []
    seen: set[str] = set()
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = f"{origin}:{number}"
        candidate = Path(line)
        if candidate.is_absolute():
            raise ManifestError(f"{where}: absolute path not allowed: {line}")
        if ".." in candidate.parts:
            raise ManifestError(f"{where}: parent segment not allowed: {line}")
        if line != candidate.as_posix():
            raise ManifestError(
                f"{where}: path is not normalized (trailing slash, `.` or empty "
                f"segment): {line}"
            )
        if candidate.as_posix() in seen:
            raise ManifestError(f"{where}: duplicate path: {line}")
        seen.add(candidate.as_posix())
        paths.append(candidate.as_posix())
    if not paths:
        raise ManifestError(f"{origin}: no paths listed; an empty record guards nothing")
    return paths


def load_manifest(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ManifestError(f"manifest not found: {path}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise ManifestError(f"cannot read manifest {path}: {exc}") from exc
    return parse_manifest(text, path)


def resurrected(source: Path, paths: list[str]) -> list[str]:
    """Return the listed paths that exist under `source` again."""
    present: list[str] = []
    for relative in paths:
        target = source / relative
        # A symlink counts even when its target is gone: the surface is back in
        # the tree, and a merge is the usual way it got there.
        if target.exists() or target.is_symlink():
            present.append(relative)
    return present


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT,
        help="tree the manifest paths are relative to (default: repository root)",
    )
    parser.add_argument(
        "--manifest", type=Path, default=DEFAULT_MANIFEST, help="path list to enforce"
    )
    args = parser.parse_args(argv)

    try:
        if not args.source.is_dir():
            raise ManifestError(f"source tree not found: {args.source}")
        paths = load_manifest(args.manifest)
    except ManifestError as exc:
        print(f"REMOVED_SURFACES_ERROR: {exc}", file=sys.stderr)
        return 2

    present = resurrected(args.source, paths)
    if present:
        print("REMOVED_SURFACES_FAIL: deleted surface(s) are back in the tree")
        for relative in present:
            print(f"  - {relative}")
        print(
            "Delete the file(s) again, or remove the path from "
            "scripts/removed-surfaces.txt in a reviewed change that deliberately "
            "reverses the deletion."
        )
        return 1

    print(f"REMOVED_SURFACES_OK ({len(paths)} paths absent)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
