#!/usr/bin/env python3
"""Select the affected Vitest test files for a leaf UI slice.

Exits 0 with one `src/...` test path per line when all changed `ui/` paths are
leaf UI files (or UI tests / locale files). Exits 1 when a shared UI file or
non-leaf path changed (or `RSI_GATE_VITEST` is set to `full`/`0`/`off`) so the
caller falls back to the full Vitest suite. Exits 2 when no `ui/` files changed.
"""
import argparse
import os
import re
import subprocess
import sys

SHARED_DIRS = (
    "ui/src/components/ui/",
    "ui/src/components/layout/",
    "ui/src/design/",
    "ui/src/lib/",
    "ui/src/api/",
    "ui/src/store/",
    "ui/src/hooks/",
    "ui/src/test/",
)
SHARED_FILES = {
    "ui/src/index.css",
    "ui/src/App.tsx",
    "ui/src/main.tsx",
    "ui/src/i18n/index.ts",
    "ui/src/i18n/react.tsx",
}
TEST_RE = re.compile(r"\.(test|spec)\.(ts|tsx|js|jsx)$")
IMP_RE = re.compile(
    r"""(?:from\s+|import\s*\(\s*|vi\.mock\s*\(\s*|require\s*\(\s*)["']([^"']+)["']"""
)


def git_changed_paths(wt: str) -> list[str]:
    if (
        subprocess.run(
            ["git", "-C", wt, "rev-parse", "--verify", "--quiet", "origin/main"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    ):
        print("origin/main unavailable", file=sys.stderr)
        sys.exit(1)
    cmds = [
        ["git", "-C", wt, "diff", "--name-only", "origin/main...HEAD"],
        ["git", "-C", wt, "diff", "--name-only", "HEAD"],
        ["git", "-C", wt, "ls-files", "--others", "--exclude-standard"],
    ]
    paths: set[str] = set()
    for cmd in cmds:
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"git command failed: {' '.join(cmd)}", file=sys.stderr)
            sys.exit(1)
        for line in res.stdout.splitlines():
            p = line.strip()
            if p:
                paths.add(p)
    return sorted(paths)


def resolve_spec(from_rel: str, spec: str, file_set: set[str]) -> str | None:
    if spec.startswith("@/"):
        base = "src/" + spec[2:]
    elif spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(from_rel), spec)).replace("\\", "/")
    else:
        return None
    for cand in (
        base,
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + ".jsx",
        base + "/index.ts",
        base + "/index.tsx",
    ):
        if cand in file_set:
            return cand
    if base.endswith(".js"):
        for ext in (".ts", ".tsx"):
            cand = base[:-3] + ext
            if cand in file_set:
                return cand
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--changed-from-stdin", action="store_true")
    args = ap.parse_args()

    mode = os.environ.get("RSI_GATE_VITEST", "related").strip().lower()
    if mode in ("full", "0", "off"):
        print("RSI_GATE_VITEST=full", file=sys.stderr)
        return 1

    wt = os.path.abspath(args.worktree)
    if args.changed_from_stdin:
        changed = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
    else:
        changed = git_changed_paths(wt)

    ui_changed = [p for p in changed if p.startswith("ui/")]
    if not ui_changed:
        return 2

    locales_touched = False
    seeds: list[str] = []
    non_test_leaf_seeds: list[str] = []
    for p in ui_changed:
        if TEST_RE.search(p) and p.startswith("ui/src/"):
            seeds.append(p[3:])
        elif p.startswith("ui/src/i18n/locales/"):
            locales_touched = True
        elif (
            (p.startswith("ui/src/components/") or p.startswith("ui/src/pages/"))
            and p not in SHARED_FILES
            and not any(p.startswith(d) for d in SHARED_DIRS)
        ):
            rel = p[3:]
            seeds.append(rel)
            non_test_leaf_seeds.append(rel)
        else:
            print(f"non-leaf UI path: {p}", file=sys.stderr)
            return 1

    ui_dir = os.path.join(wt, "ui")
    ui_src = os.path.join(ui_dir, "src")
    all_files: list[str] = []
    for root, _, files in os.walk(ui_src):
        for fn in files:
            if fn.endswith((".ts", ".tsx", ".js", ".jsx")):
                rel = os.path.relpath(os.path.join(root, fn), ui_dir).replace("\\", "/")
                all_files.append(rel)
    file_set = set(all_files)

    rev: dict[str, set[str]] = {}
    test_contents: dict[str, str] = {}
    for f in all_files:
        full_path = os.path.join(ui_dir, f)
        try:
            with open(full_path, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
        except OSError:
            continue
        if TEST_RE.search(f):
            test_contents[f] = txt
        for m in IMP_RE.finditer(txt):
            target = resolve_spec(f, m.group(1), file_set)
            if target:
                rev.setdefault(target, set()).add(f)

    queue = list(seeds)
    seen = set(seeds)
    while queue:
        cur = queue.pop()
        for dep in rev.get(cur, ()):
            if dep not in seen:
                seen.add(dep)
                queue.append(dep)

    for lf in non_test_leaf_seeds:
        base_no_ext = os.path.splitext(os.path.basename(lf))[0]
        for tf, txt in test_contents.items():
            if lf in txt or f"/{base_no_ext}" in txt:
                seen.add(tf)

    tests = sorted(f for f in seen if TEST_RE.search(f) and f in file_set)
    if "src/design/tokens.test.ts" in file_set and "src/design/tokens.test.ts" not in tests:
        tests.append("src/design/tokens.test.ts")
    if locales_touched:
        for lt in ("src/i18n/locales.test.ts", "src/i18n/documentLang.dom.test.ts"):
            if lt in file_set and lt not in tests:
                tests.append(lt)

    tests = sorted(set(tests))
    if not tests:
        print("no related UI test files resolved", file=sys.stderr)
        return 1

    for t in tests:
        print(t)
    return 0


if __name__ == "__main__":
    sys.exit(main())
