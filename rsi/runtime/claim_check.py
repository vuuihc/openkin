#!/usr/bin/env python3
"""claim_check.py — run the PR body's claim check for a prose delivery.

A delivery whose deliverable is a sentence rather than behaviour (an
`rsi/GOAL.md` line, a `DECISIONS.md` entry, an ADR, a `PLAN.md` count) was
enforced only by two string tests on the prompt: the gate never ran the
command and never compared the output. Measured 2026-11-20: 10 of the last 21
sendbacks were a doc sentence the tree contradicts.

The rule this enforces:

  A PR that changes a prose-assertion path must carry, in its body, one
  command that proves the sentence on this branch and the output it claims:

      Claim check: rg -n 'symbol' rsi/GOAL.md
      Claim output:
      rsi/GOAL.md:48:the sentence the PR asserts

  Every non-empty line under `Claim output:` must appear in the command's real
  stdout+stderr, compared as a substring after runs of whitespace collapse to
  one space. Surrounding noise in the real output is tolerated; an invented
  line is not. The LAST `Claim check:` at column 0 wins, so a brief quoted
  earlier in the body cannot satisfy the check. `Claim check: none: <reason>`
  with at least 20 characters waives it; a bare `none` does not.

A waiver is not a free pass. It says no command can prove the sentence, not
that the branch's own citations are exempt: before the waiver is accepted,
every `path:line` and `path:start-end` citation in the changed prose files is
resolved against the worktree (the file exists, it has that many lines, and a
range is ordered and fits). Measured 2026-11-21: #546 waived the check while
its ADR cited `rsi/GOAL.md:434`, a line the branch's own GOAL.md did not have.
A real `Claim check:` command is its own proof and is never second-guessed by
the scan. A changed prose file that exists but cannot be read fails closed --
a citation set that cannot be read is not proven.

Usage: claim_check.py <worktree> <body-file> <changed-files-file>
Exit:  0 = pass, not applicable, or waived; 1 = failed; 2 = usage.

One status line on stdout: `CLAIM_OK: <command>`, `CLAIM_NA: ...`,
`CLAIM_WAIVED: <reason>`, or `CLAIM_FAIL: <detail>`, where the failure line
carries the short human detail. Standard library only: no network, no
state dirs, no imports from the repo, so the merge lane can run it before it
pays for the reviewer.
"""

import os
import re
import signal
import subprocess
import sys
import tempfile

PROSE_EXACT = {
    "rsi/GOAL.md",
    "rsi/DECISIONS.md",
    "rsi/ASTRYX-PLAN.md",
    "AGENTS.md",
    "PRINCIPLE.md",
    "SYSTEM_DESIGN.md",
}
PROSE_PREFIXES = ("docs/adr/", "docs/plans/", "docs/product/")
CHECK_PREFIX = "Claim check:"
OUTPUT_PREFIX = "Claim output:"
WAIVER_MIN_CHARS = 20
# A citation is `path:line` or `path:start-end`. The extension list is deliberately narrow: only
# files whose line numbers are meaningful are checked, so a version string or a timestamp is not
# mistaken for a citation. The lookbehind keeps the match from starting inside a URL or a longer
# path, and the lookahead keeps `:12` from being taken out of `:1234`.
CITATION_EXTS = ("md", "tsx", "ts", "go", "sh", "py", "json", "mjs", "css", "yml", "yaml")
CITATION_RE = re.compile(
    r"(?<![\w./-])((?:[\w.-]+/)*[\w.-]+\.(?:%s)):(\d+)(?:-(\d+))?(?![\w-])"
    % "|".join(CITATION_EXTS)
)
CITATION_MAX_REPORTED = 5
TIMEOUT_SECS = 60
# The command's stdout+stderr goes to a temp file, never a pipe, and only this
# many trailing bytes are read back: a command that floods output cannot grow
# this process's memory or blow up the comparison. A claim that only matches
# output older than this tail therefore fails closed rather than passing.
OUTPUT_TAIL_BYTES = 262144


def read_text(path):
    """Read a UTF-8 file without ever raising on undecodable bytes."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def normalise_repo_path(path):
    """A changed-file path as git prints it, without a leading `./`."""
    path = path.strip()
    while path.startswith("./"):
        path = path[2:]
    return path


def is_prose_path(path):
    """True when a changed path carries prose assertions the tree must agree with."""
    path = normalise_repo_path(path)
    return path in PROSE_EXACT or path.startswith(PROSE_PREFIXES)


def citation_scan_applies(command):
    """True when the body waives the check; a real command is its own proof."""
    lowered = command.lower()
    return lowered == "none" or lowered.startswith("none:")


def contained(root, path):
    """True when `path` resolves inside `root` (both passed as real paths)."""
    return path == root or path.startswith(root + os.sep)


def plural_lines(count):
    return "%d line%s" % (count, "" if count == 1 else "s")


def citation_problem(worktree, prose):
    """The citations in the changed prose that the worktree cannot prove, or None.

    Only `prose` -- the changed-file list filtered through is_prose_path() -- is read, so the
    scan costs the PR's own prose and never walks the repo. A changed prose path missing from the
    tree is a deletion in the diff and is skipped; one that is there but cannot be read fails
    closed, because a citation set that cannot be read is not proven. A citation resolves when
    its file exists under the worktree, holds at least `line` lines, and for a range
    `start <= end <= lines`.
    """
    root = os.path.realpath(worktree)
    problems = []
    for rel in prose:
        source = os.path.join(worktree, rel)
        if not os.path.exists(source):
            continue
        if not contained(root, os.path.realpath(source)):
            return "cannot read the changed prose file %s: it resolves outside the worktree" % rel
        try:
            text = read_text(source)
        except OSError as exc:
            return "cannot read the changed prose file %s: %s" % (rel, exc)
        for line in text.splitlines():
            # Backticks are markdown formatting around a citation, never part of its path.
            for match in CITATION_RE.finditer(line.replace("`", "")):
                cited, start = match.group(0), int(match.group(2))
                end = int(match.group(3)) if match.group(3) else None
                target = os.path.join(worktree, normalise_repo_path(match.group(1)))
                if not contained(root, os.path.realpath(target)):
                    problems.append("%s (outside the worktree)" % cited)
                    continue
                try:
                    target_text = read_text(target)
                except FileNotFoundError:
                    problems.append("%s (no such file)" % cited)
                    continue
                except OSError as exc:
                    problems.append("%s (cannot read: %s)" % (cited, exc))
                    continue
                lines = len(target_text.splitlines())
                if end is None:
                    if start > lines:
                        problems.append(
                            "%s (the file has %s)" % (cited, plural_lines(lines))
                        )
                elif start > end:
                    problems.append("%s (the range starts after it ends)" % cited)
                elif end > lines:
                    problems.append(
                        "%s (the range needs %s; the file has %s)"
                        % (cited, plural_lines(end), plural_lines(lines))
                    )
    if not problems:
        return None
    detail = "; ".join(problems[:CITATION_MAX_REPORTED])
    if len(problems) > CITATION_MAX_REPORTED:
        detail += "; and %d more" % (len(problems) - CITATION_MAX_REPORTED)
    return "a citation in the changed prose does not resolve to this tree: " + detail


def collapse(text):
    """Collapse every run of whitespace (newlines included) to one space."""
    return " ".join(text.split())


def last_marker(lines, prefix):
    """Index of the last column-0 line starting with prefix, or None."""
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].startswith(prefix):
            return i
    return None


def claimed_lines(lines, output_at):
    """The lines whose appearance the body claims, starting at the marker line.

    The marker's own remainder is one claimed line; following lines belong to
    the block until a blank line. A fence line (``` or ```text) is formatting,
    not a claim, so it is skipped and does not end the block.
    """
    claimed = []
    rest = lines[output_at][len(OUTPUT_PREFIX):].strip()
    if rest:
        claimed.append(rest)
    for line in lines[output_at + 1:]:
        stripped = line.strip()
        if not stripped:
            break
        if stripped.startswith(("```", "~~~")):
            continue
        claimed.append(stripped)
    return claimed


def tail(text, limit=15):
    """The last non-empty lines of the real output, for a one-glance failure."""
    rows = [line for line in text.splitlines() if line.strip()]
    return " | ".join(rows[-limit:]) if rows else "(no output)"


def read_tail(sink):
    """The last OUTPUT_TAIL_BYTES written to the sink, decoded leniently."""
    size = sink.tell()
    sink.seek(max(0, size - OUTPUT_TAIL_BYTES))
    return sink.read().decode("utf-8", "replace")


def run_command(worktree, command):
    """Run one shell command, bounded in time, memory and output.

    stdout+stderr go to a temp file rather than a pipe, so a command that
    floods output never accumulates in this process; `ulimit -f` keeps the sink
    itself from filling the disk. start_new_session makes bash a process-group
    leader, so a timeout kills the command's descendants too instead of leaving
    a compile or a watcher behind. Returns (returncode, actual, error) where
    error is None unless the command could not complete.
    """
    with tempfile.TemporaryFile() as sink:
        try:
            proc = subprocess.Popen(
                ["bash", "-lc", "ulimit -f 65536 2>/dev/null; " + command],
                cwd=worktree,
                stdin=subprocess.DEVNULL,
                stdout=sink,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            return None, "", "cannot run the claim check in %s: %s" % (worktree, exc)
        try:
            returncode = proc.wait(timeout=TIMEOUT_SECS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()
            return (
                None,
                "",
                "the claim check did not finish within %d s: %s | last output: %s"
                % (TIMEOUT_SECS, command, tail(read_tail(sink))),
            )
        return returncode, read_tail(sink), None


def fail(message):
    print("CLAIM_FAIL: " + message)
    return 1


def main(argv):
    if len(argv) != 4:
        sys.stderr.write(
            "usage: claim_check.py <worktree> <body-file> <changed-files-file>\n"
        )
        return 2
    worktree, body_path, changed_path = argv[1], argv[2], argv[3]

    try:
        changed = read_text(changed_path).splitlines()
    except OSError as exc:
        return fail("cannot read the changed-files list: %s" % exc)
    prose = sorted({normalise_repo_path(p) for p in changed if is_prose_path(p)})
    if not prose:
        print("CLAIM_NA: no prose-assertion path changed (code-only PR)")
        return 0

    try:
        lines = read_text(body_path).splitlines()
    except OSError as exc:
        return fail("cannot read the PR body: %s" % exc)

    check_at = last_marker(lines, CHECK_PREFIX)
    if check_at is None:
        return fail(
            "the PR changes %s but its body has no 'Claim check:' line at column 0; "
            "name one command that proves the sentence and its output under "
            "'Claim output:', or waive it with 'Claim check: none: <reason>'" % prose[0]
        )

    command = lines[check_at][len(CHECK_PREFIX):].strip()
    if len(command) >= 2 and command.startswith("`") and command.endswith("`"):
        command = command[1:-1].strip()   # a command written as inline code
    if not command:
        return fail("the last 'Claim check:' line has no command")

    # The waiver path's substitute for a command: the changed prose's own citations must resolve
    # on this branch. A real command is never second-guessed by the scan.
    if citation_scan_applies(command):
        problem = citation_problem(worktree, prose)
        if problem is not None:
            return fail(problem)

    lowered = command.lower()
    if lowered == "none" or lowered.startswith("none:"):
        reason = command[len("none"):]
        reason = reason[1:].strip() if reason.startswith(":") else ""
        if len(reason) >= WAIVER_MIN_CHARS:
            print("CLAIM_WAIVED: " + reason)
            return 0
        return fail(
            "a waiver needs a reason: 'Claim check: none: <reason>' with at least "
            "%d characters, got %d" % (WAIVER_MIN_CHARS, len(reason))
        )

    output_at = None
    for i in range(check_at + 1, len(lines)):
        if lines[i].startswith(OUTPUT_PREFIX):
            output_at = i
            break
    if output_at is None:
        return fail(
            "the body has no 'Claim output:' line at column 0 after the claim check; "
            "paste the command's real output there"
        )
    claimed = claimed_lines(lines, output_at)
    if not claimed:
        return fail("the last 'Claim output:' block is empty")

    returncode, actual, error = run_command(worktree, command)
    if error is not None:
        return fail(error)
    if returncode != 0:
        return fail(
            "the claim check exited %d (want 0): %s | last output: %s"
            % (returncode, command, tail(actual))
        )

    haystack = collapse(actual)
    missing = [line for line in claimed if collapse(line) not in haystack]
    if missing:
        return fail(
            "claimed output is not in the command's real output: %s"
            % " | ".join(missing)
        )

    print("CLAIM_OK: " + command)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
