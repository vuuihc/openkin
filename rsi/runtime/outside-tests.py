#!/usr/bin/env python3
"""Classify a gate or CI log as an out-of-footprint or known-flaky test failure.

Exit 0 when every failing test is either a known-flaky name or lives in a
package the PR did not touch (origin/main...HEAD). Exit 1 otherwise, including
when no failing tests can be parsed, go.mod changed (unless every failure is
known-flaky), or a non-test CI job failed.

Used by merge.sh so those failures are mechanical: rerun once, not a quality
sendback.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ANSI = re.compile(r"(?:\x1b\[|\^\[\[)[0-9;]*[mK]")
# gh run view --log-failed: JOB<TAB>STEP<TAB>TIMESTAMP<SPACE-or-TAB>message
LOG_PREFIX = re.compile(
    r"^[^\t]+\t[^\t]+\t\d{4}-\d{2}-\d{2}T\S+[ \t]+"
)
FAIL_TEST = re.compile(r"--- FAIL: (\S+)")
FAIL_PKG_TAB = re.compile(r"^FAIL\t(\S+)\t")
FAIL_PKG_BRACKET = re.compile(r"^FAIL\s+(\S+)\s+\[")
# vitest / jest: "FAIL  src/foo/bar.test.ts" or "FAIL  ui/src/..."
FAIL_FILE = re.compile(
    r"(?:^|\s)(?:FAIL|✗|×)\s+((?:src|ui|internal|cmd|scripts|desktop|mobile)/[^\s:]+\.(?:go|tsx|ts|jsx|js))"
)
TEST_FILE_HINT = re.compile(
    r"^\s+((?:[./])?(?:internal|cmd|scripts|ui|src)/[\w./-]+_test\.go):"
)
# A locale value change moves user-visible copy that UI tests assert as
# literals. Path rule, not a content diff: classify() only sees changed paths.
LOCALE_FILE = re.compile(r"^ui/src/i18n/locales/[^/]+\.tsx?$")
UI_TEST_FILE = re.compile(r"^ui/src/(?:.+/)?[^/]+\.(?:test|spec)\.[jt]sx?$")
NON_TEST_HINTS = re.compile(
    r"(error TS\d+|ELIFECYCLE|prettier --check|Type error|"
    r"CHECK_UI_INVENTORY|ui-lint-guard|eslint|"
    r"go: build failed|build constraints exclude|# command-line-arguments|"
    r"undefined: |cannot find package)",
    re.I,
)
# 2026-11-25 (#712): an overloaded machine (load avg ~370) starves the vitest
# worker pool and fails test files wholesale, in-footprint ones included.
VITEST_POOL_STARVED = re.compile(
    r"\[vitest-pool(?:-runner)?\]: (?:Timeout waiting for worker to respond|Failed to start \w+ worker)"
)
# CI check names (first column of `gh pr checks`) that run the test suites
# this classifier understands. Anything else failing is not mechanical.
TEST_CHECK_NAMES = {"build", "test", "unit", "go", "ci"}


def normalize(line: str) -> str:
    line = ANSI.sub("", line.rstrip("\n"))
    return LOG_PREFIX.sub("", line)


def module_path(worktree: str) -> str:
    gomod = Path(worktree) / "go.mod"
    if gomod.is_file():
        for line in gomod.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("module "):
                return line.split()[1].strip()
    return "github.com/vuuihc/openkin"


def pkg_of(path: str, mod: str) -> str | None:
    path = path.lstrip("./")
    if path.endswith(".go"):
        return str(Path(path).parent).replace("\\", "/")
    m = re.match(re.escape(mod) + r"/(.+)$", path)
    if m:
        return m.group(1)
    if path.startswith(("internal/", "cmd/", "scripts/", "desktop/", "mobile/")) and "/" in path:
        # a file under a go or UI tree: use the directory
        if path.endswith((".ts", ".tsx", ".js", ".jsx")):
            return str(Path(path).parent).replace("\\", "/")
        return path
    if path.startswith("ui/"):
        return str(Path(path).parent).replace("\\", "/")
    if path.startswith("src/"):
        return "ui/" + str(Path(path).parent).replace("\\", "/")
    return None


def strip_mod(pkg: str, mod: str) -> str:
    if pkg.startswith(mod + "/"):
        return pkg[len(mod) + 1 :]
    return pkg


def load_known(path: str | None) -> set[str]:
    names: set[str] = set()
    if not path or not os.path.isfile(path):
        return names
    for raw in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        names.add(line.split()[0])
    return names


def changed_paths(worktree: str, explicit: list[str] | None) -> list[str]:
    if explicit is not None:
        return explicit
    out = subprocess.check_output(
        ["git", "-C", worktree, "diff", "--name-only", "origin/main...HEAD"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    return [p for p in out.splitlines() if p.strip()]


def touched_packages(paths: list[str], mod: str) -> set[str]:
    pkgs: set[str] = set()
    for p in paths:
        pkg = pkg_of(p, mod)
        if pkg:
            pkgs.add(pkg)
    return pkgs


def parse_failures(log_text: str, mod: str) -> tuple[list[tuple[str, str | None]], bool]:
    """Return ([(test_or_file, package_or_none), ...], saw_non_test_failure)."""
    failures: list[tuple[str, str | None]] = []
    pending: list[str] = []
    pending_pkg_hints: list[str] = []
    saw_non_test = False
    for raw in log_text.splitlines():
        line = normalize(raw)
        if NON_TEST_HINTS.search(line) and "--- FAIL:" not in line:
            # prettier/tsc/eslint in the same CI job as go test: not mechanical
            # unless we only later see test failures and this is a red herring.
            # Flag it; main() treats mixed non-test + tests as not mechanical.
            if re.search(
                r"(error TS\d+|ELIFECYCLE|prettier --check failed|"
                r"CHECK_UI_INVENTORY: FAIL|ui-lint-guard: FAIL|"
                r"eslint  .+ error)",
                line,
                re.I,
            ):
                saw_non_test = True
        m = FAIL_TEST.search(line)
        if m:
            pending.append(m.group(1))
            continue
        hint = TEST_FILE_HINT.match(line)
        if hint and pending:
            pending_pkg_hints.append(pkg_of(hint.group(1), mod) or hint.group(1))
            continue
        m = FAIL_PKG_TAB.match(line) or FAIL_PKG_BRACKET.match(line)
        if m:
            pkg = strip_mod(m.group(1), mod)
            if pending:
                for i, name in enumerate(pending):
                    hint_pkg = pending_pkg_hints[i] if i < len(pending_pkg_hints) else pkg
                    failures.append((name, hint_pkg or pkg))
                pending, pending_pkg_hints = [], []
            else:
                failures.append((pkg, pkg))
            continue
        m = FAIL_FILE.search(line)
        if m:
            path = m.group(1)
            if path.startswith("src/"):
                path = "ui/" + path
            failures.append((path, pkg_of(path, mod)))
    for i, name in enumerate(pending):
        hint_pkg = pending_pkg_hints[i] if i < len(pending_pkg_hints) else None
        failures.append((name, hint_pkg))
    return failures, saw_non_test


def parse_summary(text: str) -> list[tuple[str, str]]:
    """Parse `gh pr checks` rows: name, state."""
    stripped = text.lstrip()
    if stripped.startswith("["):
        # ci_state passes `gh pr checks --json name,bucket,link`, so merge.sh
        # hands classify() JSON rather than the tab-delimited table.
        try:
            data = json.loads(stripped)
        except Exception:
            return []
        if not isinstance(data, list):
            return []
        return [
            (str(item.get("name") or "").strip(), str(item.get("bucket") or "").strip().lower())
            for item in data
            if isinstance(item, dict)
            and str(item.get("name") or "").strip()
            and str(item.get("bucket") or "").strip()
        ]
    rows = []
    for raw in text.splitlines():
        parts = re.split(r"\t+", raw.strip())
        if len(parts) < 2:
            parts = re.split(r" {2,}", raw.strip())
        if len(parts) < 2:
            continue
        name, state = parts[0].strip(), parts[1].strip().lower()
        if name and state:
            rows.append((name, state))
    return rows


def classify(
    log_text: str,
    changed: list[str],
    known: set[str],
    mod: str,
    summary: str | None = None,
) -> tuple[bool, str]:
    if summary:
        rows = parse_summary(summary)
        failed = [(n, s) for n, s in rows if s in {"fail", "failure", "failed", "cancelled"} is False and s in {"fail", "failure", "failed"}]
        # cancelled is ignored (ci_state already handles it)
        failed = [(n, s) for n, s in rows if s in {"fail", "failure", "failed"}]
        if not failed:
            return False, "summary has no failed checks"
        for name, _ in failed:
            key = name.lower().split("/")[-1].split(" ")[0]
            if key not in TEST_CHECK_NAMES:
                return False, f"failed check {name!r} is not a test job"

    go_scope_all = any(p == "go.mod" or p == "go.sum" or p.endswith("/go.mod") or p.endswith("/go.sum") for p in changed)
    ui_touched = any(p.startswith("ui/") for p in changed)
    locale_changed = any(LOCALE_FILE.match(p) for p in changed)
    failures, saw_non_test = parse_failures(log_text, mod)
    if saw_non_test:
        return False, "log contains a non-test failure (typecheck/lint/inventory/build)"
    # 2026-11-25 (#712): a starved vitest worker pool is machine load, not the
    # diff — even when a failed file sits in the PR footprint. Placed after
    # the non-test check so tsc/lint/inventory failures still send the PR back.
    starved_msg = None
    for raw in log_text.splitlines():
        m = VITEST_POOL_STARVED.search(normalize(raw))
        if m:
            starved_msg = m.group(0)
            break
    if starved_msg:
        return True, f"vitest worker pool starved ({starved_msg}): machine load, not the diff"
    if not failures:
        return False, "no failing tests parsed from the log"
    touched = touched_packages(changed, mod)

    reasons = []
    for name, pkg in failures:
        if name in known:
            reasons.append(f"{name} known-flaky")
            continue
        if ui_touched and name == "ui/src/design/tokens.test.ts":
            return False, f"{name} scans all ui/ files (ui/ changed)"
        # 2026-11-21: #506 changed task.notFound in en.ts/zh.ts while
        # ui/src/pages/TaskSessionHost.handoff.dom.test.tsx still asserted
        # "Task not found". The test file was outside the PR's paths, so it was
        # classified mechanical and CI was rerun every cycle instead of the PR
        # going back to rework. UI tests legitimately assert copy that a locale
        # value just moved, so a locale change puts them in scope. A Go failure
        # or a non-UI test stays outside (pinned by the suite).
        if locale_changed and UI_TEST_FILE.match(name):
            return False, (
                f"{name} in {pkg or 'ui'} asserts user-visible copy "
                "while a locale value changed"
            )
        if pkg is None:
            return False, f"{name} has no package and is not known-flaky"
        # A go.mod change makes every Go package in-scope; a known-flaky name
        # already continued above.
        if go_scope_all and not pkg.startswith("ui/"):
            return False, f"{name} in {pkg} (go.mod/go.sum changed; all Go packages in scope)"
        # Exact package directory, or a touched path inside it. A sibling
        # (ui/src/main.tsx vs ui/src/pages) is not in scope.
        in_scope = pkg in touched or any(t == pkg or t.startswith(pkg + "/") for t in touched)
        if in_scope:
            return False, f"{name} in touched package {pkg}"
        reasons.append(f"{name} in {pkg} (outside PR footprint)")
    return True, "; ".join(reasons)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--worktree", "-C", default=".")
    ap.add_argument("--log", required=False, help="gate or CI log to classify")
    ap.add_argument("--summary", help="optional `gh pr checks` table")
    ap.add_argument("--known", help="known-flaky test name list")
    ap.add_argument("--changed-files", help="optional file of changed paths, one per line")
    ap.add_argument("--module", help="Go module path (default: worktree go.mod)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.log:
        ap.error("--log is required unless --self-test")
    wt = args.worktree
    mod = args.module or module_path(wt)
    if args.changed_files:
        changed = [
            p.strip()
            for p in Path(args.changed_files).read_text(encoding="utf-8", errors="replace").splitlines()
            if p.strip()
        ]
    else:
        changed = changed_paths(wt, None)
    known_path = args.known
    if not known_path:
        cand = Path(__file__).resolve().parent / "flaky-tests.txt"
        if cand.is_file():
            known_path = str(cand)
    known = load_known(known_path)
    log_text = Path(args.log).read_text(encoding="utf-8", errors="replace")
    summary = (
        Path(args.summary).read_text(encoding="utf-8", errors="replace")
        if args.summary
        else None
    )
    ok, reason = classify(log_text, changed, known, mod, summary)
    print(("MECHANICAL: " if ok else "QUALITY: ") + reason)
    return 0 if ok else 1


def self_test() -> int:
    mod = "github.com/vuuihc/openkin"
    ci_log = """
build	Run go test ./...	2026-11-15T11:49:10.1234567Z	=== RUN   TestAQuestionWhoseRowIsGoneIsRefused
build	Run go test ./...	2026-11-15T11:49:13.1234567Z	--- FAIL: TestAQuestionWhoseRowIsGoneIsRefused (3.00s)
build	Run go test ./...	2026-11-15T11:49:13.2234567Z	    approvals_test.go:549: the device was left waiting on a question that no longer exists
build	Run go test ./...	2026-11-15T11:49:13.3234567Z	FAIL
build	Run go test ./...	2026-11-15T11:49:13.4234567Z	FAIL	github.com/vuuihc/openkin/internal/node	3.001s
"""
    ui_only = ["ui/src/design/astryxTheme.ts", "ui/src/main.tsx"]
    known = {"TestAQuestionWhoseRowIsGoneIsRefused"}
    ok, reason = classify(ci_log, ui_only, set(), mod, None)
    assert ok, reason
    assert "outside PR footprint" in reason, reason

    ok, reason = classify(ci_log, ui_only, known, mod, None)
    assert ok, reason
    # still fine if listed as known-flaky even when the package is touched
    ok, reason = classify(ci_log, ["internal/node/approvals.go"], known, mod, None)
    assert ok and "known-flaky" in reason, reason

    ok, reason = classify(ci_log, ["internal/node/approvals.go"], set(), mod, None)
    assert not ok and "touched package" in reason, reason

    ok, reason = classify(ci_log, ["go.mod"], set(), mod, None)
    assert not ok and "go.mod" in reason, reason

    # known-flaky still mechanical when go.mod changed
    ok, reason = classify(ci_log, ["go.mod"], known, mod, None)
    assert ok and "known-flaky" in reason, reason

    tsc = ci_log + "\nui  Typecheck  2026-11-15T11:49:00.0Z  error TS2322: Type 'X' is not assignable\n"
    ok, reason = classify(tsc, ui_only, set(), mod, None)
    assert not ok and "non-test" in reason, reason

    summary_ok = "build\tfail\t4m44s\thttps://example/run/1\nsmoke\tskipping\t0\thttps://example/2\ndesktop\tpass\t30s\thttps://example/3\n"
    ok, reason = classify(ci_log, ui_only, set(), mod, summary_ok)
    assert ok, reason
    summary_bad = summary_ok + "desktop\tfail\t30s\thttps://example/4\n"
    ok, reason = classify(ci_log, ui_only, set(), mod, summary_bad)
    assert not ok and "desktop" in reason, reason

    # merge.sh passes ci_state's `gh pr checks --json name,bucket,link` output.
    json_summary_ok = (
        '[{"name":"build","bucket":"fail","link":"https://example/actions/runs/1/job/2"},'
        '{"name":"smoke","bucket":"skipping","link":""}]\n'
    )
    ok, reason = classify(ci_log, ui_only, set(), mod, json_summary_ok)
    assert ok, reason
    json_summary_bad = (
        '[{"name":"build","bucket":"fail","link":"https://example/actions/runs/1/job/2"},'
        '{"name":"desktop","bucket":"fail","link":"https://example/actions/runs/3/job/4"}]\n'
    )
    ok, reason = classify(ci_log, ui_only, set(), mod, json_summary_bad)
    assert not ok and "desktop" in reason, reason


    # Real `gh run view --log-failed` lines use a space, not a tab, after the
    # timestamp. That must still attach --- FAIL: to the FAIL\tpkg line.
    real = (
        "build\tGo test\t2026-11-15T12:15:54.7041662Z --- FAIL: TestAStartedTurnIsNotFailedByTheDeadline (0.19s)\n"
        "build\tGo test\t2026-11-15T12:15:54.7044579Z     turns_test.go:1068: the deadline failed a turn\n"
        "build\tGo test\t2026-11-15T12:15:54.7045100Z FAIL\n"
        "build\tGo test\t2026-11-15T12:15:54.7045442Z FAIL\tgithub.com/vuuihc/openkin/internal/node\t8.289s\n"
    )
    ok, reason = classify(real, ui_only, set(), mod, None)
    assert ok and "outside PR footprint" in reason, reason
    assert "internal/node" in reason, reason

    empty_ok, reason = classify("everything passed\n", ui_only, set(), mod, None)
    assert not empty_ok and "no failing tests" in reason, reason

    vitest = "FAIL  src/pages/Home.test.tsx > renders\n"
    ok, reason = classify(vitest, ui_only, set(), mod, None)
    assert ok and "outside" in reason, reason
    ok, reason = classify(vitest, ["ui/src/pages/Home.tsx"], set(), mod, None)
    assert not ok and "touched" in reason, reason

    tokens_vitest = "FAIL  src/design/tokens.test.ts > colour classes\n"
    ok, reason = classify(tokens_vitest, ui_only, set(), mod, None)
    assert not ok and "scans all ui/ files" in reason, reason
    ok, reason = classify(tokens_vitest, ["internal/node/approvals.go"], set(), mod, None)
    assert ok and "outside" in reason, reason

    # 2026-11-21 (#506): #506 changed task.notFound in en.ts/zh.ts while
    # ui/src/pages/TaskSessionHost.handoff.dom.test.tsx still asserted the old
    # copy. The test file was outside the PR's paths, so it was called
    # mechanical and CI was rerun forever instead of the PR being sent back.
    locale_change = ["ui/src/i18n/locales/en.ts", "ui/src/i18n/locales/zh.ts"]
    copy_vitest = (
        "FAIL  src/pages/TaskSessionHost.handoff.dom.test.tsx > shows the missing conversation\n"
    )
    ok, reason = classify(copy_vitest, locale_change, set(), mod, None)
    assert not ok, reason
    assert reason.startswith("ui/src/pages/TaskSessionHost.handoff.dom.test.tsx"), reason
    assert "ui/src/pages" in reason and "locale" in reason, reason

    # A locale value change must not pull Go failures into scope.
    ok, reason = classify(ci_log, locale_change, set(), mod, None)
    assert ok and "outside PR footprint" in reason, reason

    # Without a locale change the same UI test is still an outside rerun-once.
    ok, reason = classify(copy_vitest, ["ui/src/main.tsx"], set(), mod, None)
    assert ok and "outside PR footprint" in reason, reason

    # 2026-11-25 (#712): a starved vitest worker pool is machine load, so even
    # an in-footprint failure is a rerun-once — but without pool lines the
    # footprint still rules, and a non-test failure still sends the PR back.
    design_change = ["ui/src/design/x.ts"]
    starved_log = (
        "FAIL  src/design/tailwind.test.ts > cascade foundation\n"
        "\x1b[31m\x1b[1mError\x1b[22m: [vitest-pool]: Failed to start forks worker for test files /x.ts.\x1b[39m\n"
        "Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond\n"
    )
    ok, reason = classify(starved_log, design_change, set(), mod, None)
    assert ok and "starved" in reason, reason

    in_scope_no_starve = "FAIL  src/design/tailwind.test.ts > cascade foundation\n"
    ok, reason = classify(in_scope_no_starve, design_change, set(), mod, None)
    assert not ok and "touched package" in reason, reason

    starved_tsc = starved_log + "ui  Typecheck  2026-11-25T08:00:00.0Z  error TS2322: Type 'X' is not assignable\n"
    ok, reason = classify(starved_tsc, design_change, set(), mod, None)
    assert not ok and "non-test" in reason, reason

    print("self-test: ALL-PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
