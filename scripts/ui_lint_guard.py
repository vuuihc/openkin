#!/usr/bin/env python3
"""Lint the console sources a change adds, without gating legacy files.

    python3 scripts/ui_lint_guard.py [--base REF] [--list]

Selects added/renamed `ui/src/**/*.{ts,tsx}` paths (plus uncommitted sources)
against the base merge-base; tests, generated API types and the facade are
exempt. Base order: `--base`, `$UI_LINT_BASE`, `origin/main`, `main`; CI leaves
it unset on feature pushes so the guard stays cumulative, and a base that
cannot resolve exits 2 rather than reporting green.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_SRC = "ui/src/"
FACADE = "ui/src/components/ui/"
GENERATED = "ui/src/api/generated/"
IGNORED_SUFFIXES = (".test.ts", ".test.tsx")


class GuardError(RuntimeError):
    """The guard could not decide; never treat that as a pass."""


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=False)


def _text(root: Path, *args: str) -> str:
    proc = _git(root, *args)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise GuardError(f"git {' '.join(args)} failed: {detail}")
    return proc.stdout.decode("utf-8", "replace").strip()


def _names(root: Path, *args: str) -> list[str]:
    """Null-delimited paths: spaces and newlines in a filename stay intact."""
    proc = _git(root, *args)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise GuardError(f"git {' '.join(args)} failed: {detail}")
    return [os.fsdecode(part) for part in proc.stdout.split(b"\0") if part]


def resolve_base(root: Path, explicit: str | None = None) -> tuple[str, str]:
    """Return `(commit, label)` for the comparison base, or raise GuardError."""
    env = os.environ.get("UI_LINT_BASE", "").strip()
    if explicit:
        candidates = [(explicit, f"--base {explicit}")]
    elif env:
        candidates = [(env, f"UI_LINT_BASE {env[:12]}")]
    else:
        candidates = [("origin/main", "origin/main"), ("main", "main")]

    for ref, label in candidates:
        if _git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode != 0:
            if explicit or env:
                raise GuardError(f"{label} is not a commit in this repository")
            continue
        commit = _text(root, "rev-parse", "--verify", f"{ref}^{{commit}}")
        merged = _git(root, "merge-base", "HEAD", commit)
        if merged.returncode != 0:
            detail = merged.stderr.decode("utf-8", "replace").strip()
            raise GuardError(
                f"{label} has no merge-base with HEAD"
                + (f": {detail}" if detail else " (unrelated histories)")
            )
        return merged.stdout.decode().strip(), f"{label} merge-base"
    raise GuardError(
        "no base commit: origin/main and main are both missing — "
        "run `git fetch origin main` or set UI_LINT_BASE"
    )


def _eligible(name: str) -> bool:
    if not name.startswith(UI_SRC) or name.startswith((FACADE, GENERATED)):
        return False
    if name.endswith(IGNORED_SUFFIXES):
        return False
    return name.endswith((".ts", ".tsx"))


def selected_files(root: Path, base_commit: str) -> list[str]:
    """Added and renamed guarded sources, deleted paths excluded."""
    tokens = _names(
        root, "diff", "--name-status", "-z", "-M", "--diff-filter=AR", base_commit, "--", "ui/src"
    )
    names: list[str] = []
    index = 0
    while index < len(tokens):
        status = tokens[index]
        index += 1
        # A rename/copy is `status, old, new`: the new path is the one to lint.
        if status[:1] in ("R", "C"):
            names.append(tokens[index + 1])
            index += 2
        else:
            names.append(tokens[index])
            index += 1
    names += _names(root, "ls-files", "--others", "--exclude-standard", "-z", "--", "ui/src")
    return sorted({name for name in names if _eligible(name) and (root / name).is_file()})


def run_lint(root: Path, base_commit: str, *, list_only: bool = False) -> int:
    eslint = root / "ui" / "node_modules" / ".bin" / "eslint"
    if not eslint.is_file():
        raise GuardError(f"{eslint} is missing — run `npm ci` in ui/")
    files = selected_files(root, base_commit)
    if list_only:
        for name in files:
            print(name)
        return 0
    if not files:
        print(f"ui lint guard: no added ui/src files against {base_commit[:12]}")
        return 0
    relative = [name.removeprefix("ui/") for name in files]
    print(f"ui lint guard: {len(files)} added file(s) against {base_commit[:12]}")
    for name in files:
        print(f"  {name}")
    print(
        "reproduce: (cd ui && npx eslint --config eslint.guard.config.js "
        + shlex.join(relative)
        + ")"
    )
    return subprocess.run(
        [
            str(eslint),
            "--config",
            "eslint.guard.config.js",
            "--max-warnings",
            "0",
            # An explicitly passed ignored file is a warning otherwise.
            "--no-warn-ignored",
            *relative,
        ],
        cwd=root / "ui",
        check=False,
    ).returncode


def main(argv: list[str] | None = None, root: Path | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", help="commit/ref the added files are relative to")
    parser.add_argument("--list", action="store_true", help="print the scoped files and exit")
    args = parser.parse_args(argv)
    root = root or ROOT
    try:
        base, label = resolve_base(root, args.base)
        print(f"ui lint guard — base: {label} ({base[:12]})")
        return run_lint(root, base, list_only=args.list)
    except GuardError as exc:
        print(f"GUARD_ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
