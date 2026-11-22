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

Usage: claim_check.py <worktree> <body-file> <changed-files-file>
Exit:  0 = pass, not applicable, or waived; 1 = failed; 2 = usage.

One status line on stdout: `CLAIM_OK: <command>`, `CLAIM_NA: ...`,
`CLAIM_WAIVED: <reason>`, or `CLAIM_FAIL: <detail>`, where the failure line
carries the short human detail. Standard library only: no network, no
state dirs, no imports from the repo, so the merge lane can run it before it
pays for the reviewer.
"""

import os
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
        # Keep the command's exit code and the tail of what it really printed. Without them a
        # mismatch is indistinguishable from a slow or truncated run, and the reader has to
        # re-run the check by hand to tell them apart. The tail is already bounded by tail().
        return fail(
            "claimed output is not in the command's real output: %s | exit %d | last output: %s"
            % (" | ".join(missing), returncode, tail(actual))
        )

    print("CLAIM_OK: " + command)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
