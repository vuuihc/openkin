#!/usr/bin/env python3
"""red_first.py — prove a claimed test is the test that fails without the change.

The rework ledger's top shape (`test-green·not-red`, 12 of 46 rounds in the 1d ending 11-23)
is one finding: a PR's Claims block named a test that never proved anything. `activity-pill`
shipped four new tests that were all green on `origin/main`; `local-main-only` named the one
test that stayed green while a different test went red. The Claims block was a writing rule
the reviewer applied, so each occurrence cost a full gate, a model review and a sendback.

This checker turns the rule into a lane gate. It reads the local PR body, finds its Claims
block, and for every claim that resolves to a command it:

  1. saves the claimed file's bytes,
  2. overwrites it with `git show origin/main:<path>`,
  3. runs the command once, bounded in time and output,
  4. restores the bytes and proves sha256 equality in a `finally`,
  5. requires a non-zero exit **and** every test name in field 2 on a line that itself marks a
     failure (`=== RUN <name>` plus another test's `--- FAIL` is the `local-main-only` shape,
     not proof).

A claim line is `<path:line> · <test name> · <check>`; the third field resolves in this order:

  a. a backticked command (a span with whitespace, a `./` path, or a lone runner such as
     `bash`/`python3`) — run verbatim with bash, cwd = worktree. A span introduced by the word
     `mutant` is a label, not a command, even when the label has spaces;
  b. `mutant "<label>"` / ``mutant `label` `` — the manifest entry in a tracked
     `*.mutants.json` whose `file` is the claim's path and whose `label` matches exactly
     (or is the unique entry containing a quoted phrase); that entry's `test` is the command;
  c. anything else (`none: …`, a fixture name, "green run above", prose) — NA for that claim,
     never a fail, because a claim the checker cannot resolve is not evidence either way.

A claim whose field 2 names no test (prose, a fixture file) is NA too: field 2 is the string
that must appear in the red, and inventing one would fail honest PRs. A claim that must be
proven by a red which cannot say its test's name carries `red-first: any`. A claim with no
resolvable check is `red-first: none: <reason>` with at least 20 characters; a short reason
fails closed. A claimed path is the implementation line the test exercises, not the test file:
reverting a test file removes its cases, and a runner that matches nothing exits 0, which is
reported as GREEN with the fact that the run never named the test.

Only claims whose path is in the branch's changed-file set are checked, and that set is
computed exactly as the merge gate computes it (`git diff --no-renames --raw origin/main...HEAD`,
mode-only changes filtered). A seam that computed a different set could pass a claim the merge
lane then rejects, which is the round this row removes. A claimed path the branch adds has no
`origin/main` version to revert to and is NA: nothing can be un-changed, so the claim's proof
belongs on an existing file it wires into. A claimed file missing from the worktree, an
`origin/main` that does not resolve, an unreadable body, and a restore that does not match are
FAILs, because the tree is then inconsistent and no verdict from it is trustworthy.

Verdicts (one status line on stdout; each executed command's wall time printed first):

  exit 0: `RED_FIRST_OK: <n> claim(s) checked; every command went red`
          `RED_FIRST_NA: <reason>` / `RED_FIRST_WAIVED: <reason>`
  exit 1: `RED_FIRST_GREEN: <path:line> · <test>` (the test passed on the reverted file)
          `RED_FIRST_OTHER: … · red without it did not name that test`
          `RED_FIRST_NO_VERDICT: … · command exceeded <N>s` (fail closed, never a made-up red)
          `RED_FIRST_FAIL: <reason>`
  exit 2: usage.

Standard library only: no network, no state dirs, no imports from the repo, so the lane can
run it before it pushes. Usage: `red_first.py <worktree> <body-file>`.
"""

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

CLAIMS_HEADING_RE = re.compile(r"^#{1,6}\s*claims\s*$", re.IGNORECASE)
HEADING_RE = re.compile(r"^#{1,6}\s")
FENCE_RE = re.compile(r"^(?:```|~~~)")
BULLET_RE = re.compile(r"^(?:[-*+]|\d+\.)\s+")
FIELD_SEP_RE = re.compile(r"\s*·\s*")
# A path with a line number: `rsi/runtime/ux/walk.mjs:43`. The lookbehind keeps a match from
# starting inside a URL or a longer token.
PATH_LINE_RE = re.compile(r"(?<![\w./-])((?:[\w.-]+/)*[\w.-]+\.\w+):(\d+)")
BACKTICK_RE = re.compile(r"`([^`]+)`")
MUTANT_LABEL_RE = re.compile(r"\bmutants?\s+[\"“`']([^\"”`']+)[\"”`']", re.IGNORECASE)
ANY_RE = re.compile(r"red-first:\s*any\b", re.IGNORECASE)
WAIVE_RE = re.compile(r"red-first:\s*none\b\s*:?\s*", re.IGNORECASE)
WAIVER_MIN_CHARS = 20
MAX_COMMANDS = 4
DEFAULT_SECS = 180
GIT_TIMEOUT_SECS = 30
# The command's output goes to a temp file, never a pipe, and only this many trailing bytes are
# read back: a flooding command must not grow this process's memory.
OUTPUT_TAIL_BYTES = 262144
RUNNERS = (
    "bash", "sh", "python", "python3", "go", "npm", "npx", "node", "make",
    "sleep", "timeout", "true", "printf", "echo", "rg", "grep", "git",
)
# A token that reads as an argument rather than prose: a flag/path/assignment or a number.
# `make the walk green` is prose (and is NA); `make test` is indistinguishable from prose too,
# so it is NA as well -- a miss here is honest, while executing prose is not.
ARG_LIKE_RE = re.compile(r"(?:^[-./])|=")
FAIL_MARKERS = re.compile(r"\b(?:FAIL|FAILED|ERROR|AssertionError|not ok)\b|[✗✕×●]", re.IGNORECASE)


class CheckError(Exception):
    """A failure the verdict reports as RED_FIRST_FAIL (never a NA)."""


class _Terminated(BaseException):
    """Raised from SIGTERM/SIGHUP so the per-group `finally` restores the reverted files."""


def _terminate(signum, _frame):
    raise _Terminated(signum)


def install_termination_handlers():
    # dispatch.sh reaps a timed-out lane with SIGTERM. Terminating by default skips `finally`,
    # which is what writes the branch bytes back; one raise keeps the restore on the normal path
    # (the same discipline as scripts/mutants.py).
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _terminate)


def read_text(path):
    """Read a UTF-8 file without ever raising on undecodable bytes."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def normalise(path):
    """A repo-relative path without a leading `./`; a non-string (a broken manifest) is empty."""
    if not isinstance(path, str):
        return ""
    path = path.strip()
    while path.startswith("./"):
        path = path[2:]
    return path


def collapse(text):
    return " ".join(text.split())


def git_run(worktree, args, binary=False):
    """One git read, bounded and never raising. Returns (returncode, bytes-or-None)."""
    try:
        proc = subprocess.run(
            ["git", "-C", worktree, "--no-pager"] + args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT_SECS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    return proc.returncode, proc.stdout


def git_stdout(worktree, args):
    code, out = git_run(worktree, args)
    if code != 0 or out is None:
        return None
    return out.decode("utf-8", "replace")


def origin_main_resolves(worktree):
    code, _ = git_run(worktree, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
    return code == 0


def changed_files(worktree):
    """This branch's changed paths, computed exactly as lane.sh/merge.sh compute them.

    `--no-renames` turns a rename into delete+add (a rename must not hide the new path);
    `origin/main...HEAD` is the PR's own diff; `core.fileMode=false` keeps a mode-only change
    from looking like content. A deletion is listed, and reverting a deleted claimed file
    fails closed later. Returns None when git cannot answer.
    """
    out = git_stdout(
        worktree,
        ["-c", "core.fileMode=false", "diff", "--no-renames", "--raw", "origin/main...HEAD"],
    )
    if out is None:
        return None
    paths = set()
    for line in out.splitlines():
        meta, tab, path = line.partition("\t")
        if not tab:
            continue
        parts = meta.split()
        if len(parts) < 5 or parts[2] == parts[3]:
            continue  # a mode-only change has the same blob on both sides
        paths.add(normalise(path))
    return paths


def claims_block(lines):
    """The lines under the last `Claims` heading, up to the next heading, or None."""
    at = None
    for i, line in enumerate(lines):
        if CLAIMS_HEADING_RE.match(line.strip()):
            at = i
    if at is None:
        return None
    block = []
    for line in lines[at + 1:]:
        if HEADING_RE.match(line.strip()):
            break
        block.append(line)
    return block


def test_names(field):
    """The test names a claim's second field names: backticked spans, else one bare token.

    A span that ends with a file extension is a fixture or test *file*, not a case name: the red
    output does not print a filename, so treating one as a name would fail an honest claim. The
    claim is then NA, which is the honest verdict the brief gives "a fixture file name".
    """

    def is_name(span):
        return bool(span) and not re.search(r"\.\w+$", span)

    names = [span.strip() for span in BACKTICK_RE.findall(field) if is_name(span.strip())]
    if names:
        return names
    token = field.strip().strip("`")
    if token and " " not in token and len(token) >= 6 and is_name(token):
        return [token]
    return []


def looks_like_command(field, match):
    """True for a backticked span that is a command, not a mutant label or a file name.

    The first token (after `VAR=value` assignments) must be a known runner, or the span must be a
    `./`/absolute path, and the remainder must look like arguments (a flag, path, assignment or
    number). Backticked prose such as a fixture name — or `make the walk green` — therefore stays
    NA instead of being executed. A span introduced by the word `mutant` is a label, resolved from
    the manifest instead, even when the label itself has spaces.
    """
    span = match.group(1).strip()
    before = field[:match.start()].rstrip().lower()
    if before.endswith("mutant") or before.endswith("mutants"):
        return False
    tokens = span.split()
    if not tokens:
        return False
    if tokens[0].startswith(("./", "/")):
        return True
    i = 0
    while i < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i]):
        i += 1
    if i >= len(tokens) or tokens[i] not in RUNNERS:
        return False
    rest = tokens[i + 1:]
    return any(ARG_LIKE_RE.search(tok) or re.search(r"\d", tok) or re.search(r"\.\w+$", tok) for tok in rest)


def tracked_manifests(worktree):
    out = git_stdout(worktree, ["ls-files", "--", "*.mutants.json"])
    return [line for line in (out or "").splitlines() if line.strip()]


def manifest_command(worktree, path, label):
    """The test command of the one manifest entry for `path` whose label matches, or None."""
    matches = []
    for manifest in tracked_manifests(worktree):
        try:
            data = json.loads(read_text(os.path.join(worktree, manifest)))
        except (OSError, ValueError):
            continue
        if not isinstance(data, list):
            continue
        for entry in data:
            if not isinstance(entry, dict):
                continue
            if normalise(entry.get("file")) != path:
                continue
            test = entry.get("test")
            if not isinstance(test, str) or not test.strip():
                continue
            matches.append((str(entry.get("label", "")), test.strip()))
    exact = {test for lab, test in matches if lab == label}
    if exact:
        return exact.pop() if len(exact) == 1 else None
    contained = {test for lab, test in matches if label in lab}
    if len(contained) == 1:
        return contained.pop()
    return None


def resolve_command(worktree, path, field):
    """(command, why) for a claim's third field; command is None when it does not resolve."""
    for match in BACKTICK_RE.finditer(field):
        if looks_like_command(field, match):
            return match.group(1).strip(), None
    labels = [lab.strip() for lab in MUTANT_LABEL_RE.findall(field) if lab.strip()]
    if labels:
        commands = set()
        for label in labels:
            command = manifest_command(worktree, path, label)
            if command is None:
                return None, "no unique manifest entry for mutant %r" % label
            commands.add(command)
        if len(commands) != 1:
            return None, "the claim's mutant labels resolve to %d different commands" % len(commands)
        return commands.pop(), None
    return None, None


def parse_claim(line):
    """One claim dict from a Claims-block line, or None for a non-claim line."""
    text = line.strip()
    if not text or FENCE_RE.match(text):
        return None
    text = BULLET_RE.sub("", text, count=1)
    fields = FIELD_SEP_RE.split(text)
    if len(fields) < 3:
        return None
    where, test_field, check_field = fields[0], fields[1], "·".join(fields[2:])
    match = PATH_LINE_RE.search(where.replace("`", ""))
    path = normalise(match.group(1)) if match else None
    names = test_names(test_field)
    waiver = None
    waive = WAIVE_RE.search(text)
    if waive:
        waiver = text[waive.end():].strip()
    return {
        "where": "%s:%s" % (path, match.group(2)) if match else collapse(where)[:80],
        "path": path,
        "names": names,
        "label": ", ".join(names) or collapse(test_field)[:80],
        "check": check_field,
        "any": bool(ANY_RE.search(text)),
        "waiver": waiver,
    }


def read_tail(sink):
    size = sink.tell()
    sink.seek(max(0, size - OUTPUT_TAIL_BYTES))
    return sink.read().decode("utf-8", "replace")


def kill_group(proc):
    """Kill the command's whole process group; it was started in its own session."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_bounded(worktree, command, seconds):
    """Run one claimed check under an explicit bound; kill its whole process group on expiry.

    Returns (returncode, output, timed_out, wall_seconds, error). `ulimit -f` keeps a flooding
    command from filling the disk; start_new_session makes bash a group leader so a timeout
    kills its descendants, not just the direct child. A reaped lane (SIGTERM/SIGHUP) takes the
    same path: the group is killed before the caller's restore runs, so a detached grandchild
    cannot write the restored file back to origin/main's bytes.
    """
    with tempfile.TemporaryFile() as sink:
        started = time.monotonic()
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
            return None, "", False, 0.0, "cannot run the claimed check in %s: %s" % (worktree, exc)
        try:
            returncode = proc.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            kill_group(proc)
            proc.wait()
            return None, read_tail(sink), True, time.monotonic() - started, None
        except BaseException:
            kill_group(proc)
            proc.wait()
            raise
        return returncode, read_tail(sink), False, time.monotonic() - started, None


def restore(saved):
    """Write the branch bytes back and prove sha256 equality; returns a problem or None."""
    problems = []
    for rel, target, before in saved:
        try:
            with open(target, "wb") as fh:
                fh.write(before)
            with open(target, "rb") as fh:
                now = fh.read()
        except OSError as exc:
            problems.append("cannot restore %s: %s" % (rel, exc))
            continue
        if hashlib.sha256(now).digest() != hashlib.sha256(before).digest():
            problems.append("restore of %s does not match the branch bytes" % rel)
    return "; ".join(problems) if problems else None


def git_show(worktree, path):
    code, out = git_run(worktree, ["show", "origin/main:" + path])
    return out if code == 0 else None


def on_origin_main(worktree, path):
    """True/False when git can answer, None when it cannot (a timeout is not an added file)."""
    code, _ = git_run(worktree, ["cat-file", "-e", "origin/main:" + path])
    if code is None:
        return None
    return code == 0


def run_group(worktree, command, claims, seconds):
    """Revert the group's claimed files, run the command once, restore. Never leaves them behind."""
    root = os.path.realpath(worktree)
    saved = []
    terminated = None
    try:
        for rel in sorted({claim["path"] for claim in claims}):
            target = os.path.realpath(os.path.join(worktree, rel))
            if target != root and not target.startswith(root + os.sep):
                raise CheckError("%s resolves outside the worktree" % rel)
            try:
                with open(target, "rb") as fh:
                    before = fh.read()
            except OSError as exc:
                raise CheckError("cannot read the claimed file %s: %s" % (rel, exc))
            original = git_show(worktree, rel)
            if original is None:
                raise CheckError("missing claimed file %s on origin/main" % rel)
            if original == before:
                raise CheckError("%s is identical on origin/main; the revert would change nothing" % rel)
            saved.append((rel, target, before))
            try:
                with open(target, "wb") as fh:
                    fh.write(original)
                with open(target, "rb") as fh:
                    written = fh.read()
            except OSError as exc:
                raise CheckError("cannot write %s back to its origin/main bytes: %s" % (rel, exc))
            if written != original:
                raise CheckError("could not write %s back to its origin/main bytes" % rel)
        returncode, output, timed_out, wall, error = run_bounded(worktree, command, seconds)
    except _Terminated as exc:
        # The command's group is already killed (run_bounded). Restore below, then re-raise only
        # after the restore is proven, so the verdict can state that both happened.
        terminated = exc
    finally:
        problem = restore(saved)
    if problem is not None:
        raise CheckError(problem)
    if terminated is not None:
        raise terminated
    if error is not None:
        raise CheckError(error)
    return returncode, output, timed_out, wall


def verdict_for(claim, returncode, output, timed_out):
    if timed_out:
        return "no_verdict"
    if returncode == 0:
        return "green"
    if claim["any"]:
        return "ok"
    if claim["names"] and all(named_a_failure(output, name) for name in claim["names"]):
        return "ok"
    return "other"


def named_a_failure(output, name):
    """True when `name` appears on a line that itself marks a failure.

    A plain mention is not proof: `go test -v` prints `=== RUN case_alpha` for a test that then
    passes, and a verbose runner names every test it ran. The claimed test's name must be on a
    red line (`--- FAIL: case_alpha`, `FAIL case_alpha: …`, `not ok 1 - case_alpha`, `✗`/`×`).
    A name that appears only in run announcements, a pass line, or prose is not that proof.
    """
    for line in output.splitlines():
        if name in line and FAIL_MARKERS.search(line):
            return True
    return False


def fail(message):
    print("RED_FIRST_FAIL: " + message)
    return 1


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: red_first.py <worktree> <body-file>\n")
        return 2
    worktree, body_path = argv[1], argv[2]
    install_termination_handlers()

    try:
        seconds = int(os.environ.get("RSI_RED_FIRST_SECS", DEFAULT_SECS))
    except ValueError:
        return fail("RSI_RED_FIRST_SECS is not a whole number of seconds")
    if seconds <= 0:
        return fail("RSI_RED_FIRST_SECS must be a positive number of seconds")

    try:
        lines = read_text(body_path).splitlines()
    except OSError as exc:
        return fail("cannot read the PR body: %s" % exc)
    block = claims_block(lines)
    if block is None:
        print("RED_FIRST_NA: the PR body has no Claims block")
        return 0
    claims = [claim for claim in (parse_claim(line) for line in block) if claim is not None]
    if not claims:
        print("RED_FIRST_NA: the Claims block has no claim lines")
        return 0

    # The branch point must resolve before anything is classified: without it no file can be
    # reverted, and turning that into NA would wave a branch through on a broken tree.
    if not origin_main_resolves(worktree):
        return fail("origin/main is not resolvable")
    changed = changed_files(worktree)
    if changed is None:
        return fail("cannot compute the branch's changed files from origin/main...HEAD")

    runnable, waived, any_changed = [], [], False
    na_reasons = []
    for claim in claims:
        if claim["path"] is None:
            na_reasons.append("no path:line")
            continue
        if claim["path"] not in changed:
            na_reasons.append("%s is not in this branch's changed files" % claim["path"])
            continue
        any_changed = True
        if claim["waiver"] is not None:
            if len(claim["waiver"]) < WAIVER_MIN_CHARS:
                return fail(
                    "%s · a red-first waiver needs a reason of at least %d characters, got %d"
                    % (claim["where"], WAIVER_MIN_CHARS, len(claim["waiver"]))
                )
            claim["reason"] = claim["waiver"]
            waived.append(claim)
            continue
        # A file the branch adds has no state "without the change": nothing can be reverted, so
        # the claim is NA rather than FAIL. Its proof belongs on an existing file it wires into,
        # or the claim carries `red-first: none: <reason>`.
        present = on_origin_main(worktree, claim["path"])
        if present is None:
            return fail("git could not say whether %s exists on origin/main" % claim["path"])
        if not present:
            na_reasons.append("%s · the branch adds this file" % claim["where"])
            continue
        if not claim["names"] and not claim["any"]:
            na_reasons.append("%s · field 2 names no test" % claim["where"])
            continue
        command, why = resolve_command(worktree, claim["path"], claim["check"])
        if command is None:
            na_reasons.append("%s · %s" % (claim["where"], why or "no resolvable check"))
            continue
        claim["command"] = command
        runnable.append(claim)

    if not runnable:
        if waived and len(waived) == len(claims):
            print("RED_FIRST_WAIVED: " + waived[0]["reason"])
            return 0
        if not any_changed:
            print("RED_FIRST_NA: no claim cites a file this branch changed")
            return 0
        detail = " (%s)" % na_reasons[0] if na_reasons else ""
        print("RED_FIRST_NA: no claim names a resolvable check" + detail)
        return 0

    groups = {}
    for claim in runnable:
        groups.setdefault(claim["command"], []).append(claim)
    if len(groups) > MAX_COMMANDS:
        print("RED_FIRST_NA: %d unique commands (at most %d per run)" % (len(groups), MAX_COMMANDS))
        return 0

    for command, group in groups.items():
        try:
            returncode, output, timed_out, wall = run_group(worktree, command, group, seconds)
        except CheckError as exc:
            return fail(str(exc))
        except _Terminated as exc:
            return fail(
                "terminated by signal %s; the command's process group was killed and every "
                "reverted file was restored (sha256 verified)" % exc.args[0]
            )
        print("RED_FIRST_TIME: %.2fs · %s" % (wall, command))
        for claim in group:
            # The failure-line check reads the output line by line: collapsing it would put a
            # passing mention and another test's FAIL on the same line and count the pass.
            claim["verdict"] = verdict_for(claim, returncode, output, timed_out)
            claim["output"] = collapse(output)
            claim["returncode"] = returncode

    def first(kind):
        return next((claim for claim in runnable if claim["verdict"] == kind), None)

    green = first("green")
    if green is not None:
        # An exit 0 that never names the claimed test is not "the test passed": a claimed test
        # file that the branch extends loses the case when reverted, and `go test -run` (or a
        # grep-based runner) then exits 0 having run nothing. Say so; it is still a failure.
        unnamed = green["names"] and not all(name in green["output"] for name in green["names"])
        suffix = (
            " · the command exited 0 without naming it; the claimed test may live in the claimed file"
            if unnamed
            else ""
        )
        print("RED_FIRST_GREEN: %s · %s%s" % (green["where"], green["label"], suffix))
        return 1
    hung = first("no_verdict")
    if hung is not None:
        print("RED_FIRST_NO_VERDICT: %s · command exceeded %ds" % (hung["where"], seconds))
        return 1
    other = first("other")
    if other is not None:
        print(
            "RED_FIRST_OTHER: %s · %s · red without it did not name that test"
            % (other["where"], other["label"])
        )
        return 1
    print("RED_FIRST_OK: %d claim(s) checked; every command went red" % len(runnable))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
