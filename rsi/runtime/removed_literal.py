#!/usr/bin/env python3
"""removed_literal.py — a literal the branch removed must not leave an untouched test asserting it.

A branch deletes a flag, a command fragment or a config value from loop code and leaves an
untouched test file — or an untouched ``*.mutants.json`` anchor — still asserting it. Nothing
notices until the full gate or a reviewer runs, so the PR is sent back after a whole round. This
checker is the rule behind ``lane.sh --removed-literal-check <worktree>``; it answers one question:
which literals did this branch remove from tracked loop production code, and which untouched test
or mutant manifest still asserts one?

Derivation (stage 1, static):

  * Removed (``-``, not ``---``) lines from ``git diff -U0 origin/main...HEAD`` over tracked loop
    code: ``rsi/runtime/**`` and ``scripts/**``, excluding ``rsi/runtime/tests/**``,
    ``rsi/runtime/ux/journeys/**`` and ``rsi/runtime/prompts/**``.
  * Needles: double/single-quoted spans, backticked spans, ``--flag`` tokens and UPPER_SNAKE
    constants of at least 8 characters. A needle that still appears anywhere in current loop
    production code is dropped: a move is not a removal.
  * Locale removals (``ui/src/i18n/locales/**``) are not loop code and are left to the locale
    rename seam.

Candidates:

  * Tracked files under ``rsi/runtime/tests/**`` or ``scripts/**`` whose basename contains ``test``,
    and every tracked ``*.mutants.json``. A file the branch itself changed is not a finding: the
    worker had it in hand.
  * A stale mutant anchor is mechanically fatal (``scripts/mutants.py`` reports ``pattern occurs 0
    times``), so it is decided statically and never by running that entry's test.

Running (stage 2, bounded):

  * At most 4 hit test files, 240 s total (``RSI_REMOVED_LITERAL_SECS``, clamped to 300) and 60 s
    per file. ``.sh`` runs under ``bash``, ``.py`` under ``python3``, ``.ts``/``.tsx`` under
    ``ui/node_modules/.bin/vitest`` only when that binary exists. A test that cannot be run makes
    the verdict NA with the static hit named — never a green.

Verdicts (exit codes):

  * ``REMOVED_LITERAL_RED: …``  — a needle is still asserted, or a manifest anchor is stale. 1.
  * ``REMOVED_LITERAL_OK: …``   — nothing removed, or every hit test passed. 0.
  * ``REMOVED_LITERAL_NA: …``   — the seam could not measure (no loop change, no origin/main, a
    git/walk error, an un-runnable hit test, the total budget). 0.
  * usage error 2. An unparseable ``*.mutants.json`` is RED, not NA.

Standard library only, no network, no writes outside the worktree.
"""

import json
import os
import re
import signal
import subprocess
import sys

MIN_NEEDLE = 8
MAX_HIT_FILES = 4
PER_FILE_SECS = 60
DEFAULT_TOTAL_SECS = 240
MAX_TOTAL_SECS = 300
GIT_SECS = 30
MAX_SOURCE_BYTES = 2 * 1024 * 1024

LOOP_EXCLUDES = (
    "rsi/runtime/tests/",
    "rsi/runtime/ux/journeys/",
    "rsi/runtime/prompts/",
)
TEST_PREFIXES = ("rsi/runtime/tests/", "scripts/")

_AT_LEAST = "{%d,}" % MIN_NEEDLE
QUOTED = re.compile(
    r'"([^"\n]' + _AT_LEAST + r')"|\'([^\'\n]' + _AT_LEAST + r')\'|`([^`\n]' + _AT_LEAST + r')`'
)
FLAG = re.compile(r"(?<![\w-])(--[A-Za-z0-9][A-Za-z0-9_-]{6,})")
CONST = re.compile(r"\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b")


class GitError(Exception):
    """A git command that could not be read: the seam must report NA, not a verdict."""


def is_loop_production(path):
    if path.startswith("rsi/runtime/"):
        return not any(path.startswith(x) for x in LOOP_EXCLUDES)
    return path.startswith("scripts/")


def is_test_candidate(path):
    if not any(path.startswith(x) for x in TEST_PREFIXES):
        return False
    return "test" in os.path.basename(path).lower()


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def git(wt, *args):
    """Run git in the worktree under a timeout; raise GitError on any failure."""
    cmd = ["git", "-C", wt] + list(args)
    try:
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_SECS
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitError("git %s: %s" % (" ".join(args), exc))
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise GitError("git %s: %s" % (" ".join(args), detail[-1] if detail else "exited %d" % proc.returncode))
    return proc.stdout.decode("utf-8", "replace")


def changed_paths(wt):
    out = git(wt, "-c", "core.fileMode=false", "diff", "--no-renames", "--name-status",
              "origin/main...HEAD")
    changed = set()
    for line in out.splitlines():
        fields = line.split("\t", 1)
        if len(fields) == 2 and fields[1]:
            changed.add(fields[1])
    return changed


def removed_lines(wt, path):
    """The removed (``-``) lines of one file's diff from the branch point."""
    out = git(wt, "-c", "core.fileMode=false", "diff", "--no-renames", "-U0",
              "origin/main...HEAD", "--", path)
    lines = []
    for line in out.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            lines.append(line[1:])
    return lines


def needles_from(lines):
    """Every 8+-character literal in the removed lines, mapped to one file that removed it."""
    found = {}
    for line in lines:
        for match in QUOTED.finditer(line):
            value = next((g for g in match.groups() if g is not None), "")
            if len(value) >= MIN_NEEDLE:
                found.setdefault(value, None)
        for match in FLAG.finditer(line):
            found.setdefault(match.group(1), None)
        for match in CONST.finditer(line):
            if len(match.group(1)) >= MIN_NEEDLE:
                found.setdefault(match.group(1), None)
    return found


def production_text(wt):
    """All current tracked loop production code, as one string, for the move check."""
    text = []
    for path in git(wt, "ls-files", "-z").split("\0"):
        if not path or not is_loop_production(path):
            continue
        full = os.path.join(wt, path)
        try:
            if os.path.getsize(full) > MAX_SOURCE_BYTES:
                continue
        except OSError:
            continue
        text.append(read_text(full))
    return "\n".join(text)


def parse_manifest(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ValueError(str(exc))
    if not isinstance(data, list):
        raise ValueError("top level is not a JSON array")
    return data


def stale_anchor(wt, manifests, changed, removed_by_file):
    """The first untouched manifest entry whose ``old`` still contains a deleted line."""
    for manifest in sorted(manifests):
        # An unparseable manifest is RED whether or not the branch touched it: a manifest the
        # branch wrote broken is not a reason to wave the hand-off through.
        full = os.path.join(wt, manifest)
        try:
            entries = parse_manifest(full)
        except ValueError as exc:
            return ("parse", manifest, str(exc))
        if manifest in changed:
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            target = entry.get("file")
            old = entry.get("old")
            if not isinstance(target, str) or not isinstance(old, str):
                continue
            # An anchor is stale only when its `old` is gone from the target. A branch that deleted
            # some other copy of a common line (`return 0`, `continue`) or moved a line within the
            # same file leaves this entry valid, and ``scripts/mutants.py`` would still find it.
            target_path = os.path.join(wt, target)
            if os.path.isfile(target_path) and old in read_text(target_path):
                continue
            for line in removed_by_file.get(target, ()):
                if len(line.strip()) >= MIN_NEEDLE and line.strip() in old:
                    return ("stale", manifest, entry.get("label") or "(unlabelled)", line.strip(), target)
    return None


def run_bounded(cmd, cwd, timeout):
    """Run a child in its own process group; kill the tree on expiry and return rc 124."""
    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        return None, "cannot start %s: %s" % (cmd[0], exc)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return 124, ""


def runner_for(wt, path):
    ext = os.path.splitext(path)[1]
    if ext == ".sh":
        return ["bash", path], None
    if ext == ".py":
        return ["python3", path], None
    if ext in (".ts", ".tsx"):
        vitest = os.path.join(wt, "ui", "node_modules", ".bin", "vitest")
        if os.path.isfile(vitest) and os.access(vitest, os.X_OK):
            return [vitest, "run", path], None
        return None, "no ui/node_modules/.bin/vitest to run it"
    return None, "no bounded runner for %s files" % (ext or "extensionless")


def first_line(text):
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def na(reason):
    print("REMOVED_LITERAL_NA: " + reason)
    return 0


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: removed_literal.py <worktree>\n")
        return 2
    wt = argv[1]
    if not os.path.isdir(wt):
        return na("%s · worktree not found" % wt)

    try:
        git(wt, "rev-parse", "--verify", "-q", "origin/main")
    except GitError:
        return na("origin/main is not resolvable in %s" % wt)

    try:
        changed = changed_paths(wt)
    except GitError as exc:
        return na("cannot read the diff from origin/main: %s" % exc)

    loop_changed = sorted(p for p in changed if is_loop_production(p))
    if not loop_changed:
        return na("no loop-code change (changed: %s)" % (", ".join(sorted(changed)) or "nothing"))

    removed_by_file = {}
    needles = {}
    try:
        for path in loop_changed:
            lines = removed_lines(wt, path)
            if lines:
                removed_by_file[path] = lines
                for needle in needles_from(lines):
                    needles.setdefault(needle, path)
        production = production_text(wt)
    except GitError as exc:
        return na("cannot derive the removed literals: %s" % exc)

    # A move is not a removal. The old check runs against current production code only.
    surviving = [n for n in needles if n not in production]

    try:
        tracked = [p for p in git(wt, "ls-files", "-z").split("\0") if p]
    except GitError as exc:
        return na("cannot list tracked files: %s" % exc)

    manifests = [p for p in tracked if p.endswith(".mutants.json")]
    test_files = [p for p in tracked if p not in changed and is_test_candidate(p)]

    stale = stale_anchor(wt, manifests, changed, removed_by_file)
    if stale is not None:
        if stale[0] == "parse":
            print("REMOVED_LITERAL_RED: unparseable mutant manifest · %s · %s" % (stale[1], stale[2]))
            return 1
        _, manifest, label, line, target = stale
        print('REMOVED_LITERAL_RED: stale mutant anchor · %s · entry "%s": "%s" no longer exists in %s'
              % (manifest, label, line, target))
        return 1

    # Find untouched test files that still quote a surviving needle.
    hits = {}
    for path in test_files:
        text = read_text(os.path.join(wt, path))
        if not text:
            continue
        for needle in surviving:
            index = text.find(needle)
            if index < 0:
                continue
            lineno = text.count("\n", 0, index) + 1
            hits[path] = (needle, lineno)
            break

    if not surviving:
        print("REMOVED_LITERAL_OK: no removed literal survives in loop production code")
        return 0
    if not hits:
        print("REMOVED_LITERAL_OK: %d removed literal(s); no untouched test or mutant manifest asserts them"
              % len(surviving))
        return 0

    try:
        total = int(os.environ.get("RSI_REMOVED_LITERAL_SECS", DEFAULT_TOTAL_SECS))
    except ValueError:
        total = DEFAULT_TOTAL_SECS
    total = max(1, min(total, MAX_TOTAL_SECS))

    ordered = sorted(hits)
    measured = ordered[:MAX_HIT_FILES]
    unmeasured = []
    for extra in ordered[MAX_HIT_FILES:]:
        unmeasured.append((extra, "over the %d-file cap" % MAX_HIT_FILES))

    failures = []
    passed = []
    for path in measured:
        needle, lineno = hits[path]
        if total <= 0:
            unmeasured.append((path, "the %ds total budget is spent" % _budget()))
            continue
        cmd, why = runner_for(wt, path)
        if cmd is None:
            unmeasured.append((path, why))
            continue
        budget = min(PER_FILE_SECS, total)
        rc, out = run_bounded(cmd, wt, budget)
        total -= budget
        if rc is None:
            unmeasured.append((path, out))
        elif rc == 124:
            unmeasured.append((path, "did not finish within %ds" % budget))
        elif rc != 0:
            failures.append((needle, needle_sources(needle, needles), path, lineno, first_line(out) or "exit %d" % rc))
        else:
            passed.append(path)

    if failures:
        needle, source, path, lineno, detail = failures[0]
        print("REMOVED_LITERAL_RED: %s · removed from %s · %s:%d still asserts it and fails: %s"
              % (needle, source, path, lineno, detail))
        return 1

    if unmeasured:
        path, why = unmeasured[0]
        needle, lineno = hits.get(path, ("?", 0))
        print("REMOVED_LITERAL_NA: cannot measure %s:%d (%s): %s"
              % (path, lineno, needle, why))
        return 0

    print("REMOVED_LITERAL_OK: %d removed literal(s); %d untouched test file(s) passed (%s)"
          % (len(surviving), len(passed), ", ".join(passed)))
    return 0


def needle_sources(needle, needles):
    return needles.get(needle, "?")


def _budget():
    try:
        return int(os.environ.get("RSI_REMOVED_LITERAL_SECS", DEFAULT_TOTAL_SECS))
    except ValueError:
        return DEFAULT_TOTAL_SECS


if __name__ == "__main__":
    sys.exit(main(sys.argv))
