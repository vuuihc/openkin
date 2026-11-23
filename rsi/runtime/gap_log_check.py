#!/usr/bin/env python3
"""gap_log_check.py — a fix PR closes the gap-log entry its diff touches.

`docs/plans/gap-log.md` states its own move rule at :25-27 ("When a fix lands, the sweep moves
the entry to `## 已修` in the same PR ... a fixed entry never stays under `## Open`"), and nothing
enforced it. Measured 2026-11-22/23: three fix PRs landed with their own entry still under
`## Open` and each cost a second docs-only PR (#611, #615, #632) — a full gate, review and merge
cycle per stale entry, and the hourly sweep re-served work that was already done.

The rule this enforces:

  A PR whose diff touches a repo-relative path cited by an `## Open` entry must either

      Gap-log: <text from the entry>      (>= 10 chars; the entry must be moved to `## 已修`
                                           in this same PR and the file must be in the diff)

  or say why the citation is unrelated:

      Gap-log: none: <reason>             (>= 20 chars; a bare `none` does not waive)

  Declarations are column-0 lines in the PR body; every line is read. A diff that touches no
  cited path, an empty `## Open`, and a missing gap-log file are not applicable.

The file is parsed by heading-anchored splits: only a line whose trimmed value is exactly
`## Open` or exactly `## 已修` is a heading. The file's own header prose mentions both headings
inline (`docs/plans/gap-log.md:22-30`), and a plain `split('## Open')` slices the wrong region —
the exact bug that bit #611's brief. Entries are the non-empty, non-heading lines between the
headings. A cited path is a token with at least one `/` and a file extension; a `:line` or
`:start-end` suffix is not part of the path, and a token containing `://` is a URL, never a path.

Usage: gap_log_check.py <worktree> <body-file> <changed-files-file>
Exit:  0 = pass, not applicable, or waived; 1 = failed; 2 = usage.

One status line on stdout: `GAP_LOG_OK: ...`, `GAP_LOG_NA: ...`, `GAP_LOG_WAIVED: <reason>`, or
`GAP_LOG_FAIL: <detail>`, where the failure line carries the short human detail. Standard library
only: no network, no state dirs, no imports from the repo, so the merge lane can run it before it
pays for the reviewer. Like claim_check.py, a gap-log file that exists but cannot be read fails
closed: a rule that cannot read its ledger is not proven.
"""

import os
import re
import sys

GAP_LOG = "docs/plans/gap-log.md"
OPEN_HEADING = "## Open"
FIXED_HEADING = "## 已修"
DECL_PREFIX = "Gap-log:"
WAIVER_MIN_CHARS = 20
DECL_MIN_CHARS = 10
TOKEN_RE = re.compile(r"\S+")
# A cited path: at least one `/` and a final segment with a dot and an extension. The match stops
# before a `:line` suffix, so `ui/src/index.css:279` cites `ui/src/index.css`.
PATH_RE = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}")


def read_text(path):
    """Read a UTF-8 file without ever raising on undecodable bytes."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def normalise(path):
    """A repo-relative path without a leading `./`."""
    path = path.strip()
    while path.startswith("./"):
        path = path[2:]
    return path


def sections(lines):
    """(open_entries, fixed_entries) from heading-anchored splits; ValueError when unparseable.

    Only a line whose trimmed value is exactly the heading counts. The real file wraps its
    `## Open` mention in prose at :22-30; slicing on the raw string would take that prose (and
    the example paths after it) as entries.
    """
    open_at = fixed_at = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if open_at is None and stripped == OPEN_HEADING:
            open_at = i
        elif open_at is not None and fixed_at is None and stripped == FIXED_HEADING:
            fixed_at = i
    if open_at is None:
        raise ValueError("no %r heading" % OPEN_HEADING)
    if fixed_at is None:
        raise ValueError("no %r heading after %r" % (FIXED_HEADING, OPEN_HEADING))
    return entries(lines[open_at + 1:fixed_at]), entries(lines[fixed_at + 1:])


def entries(lines):
    """The non-empty lines that are not themselves headings."""
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def cited_paths(entry):
    """Repo-relative paths an entry cites, in first-seen order."""
    found = []
    for token in TOKEN_RE.findall(entry):
        if "://" in token:
            continue
        for match in PATH_RE.finditer(token):
            path = normalise(match.group(0))
            if path not in found:
                found.append(path)
    return found


def declarations(lines):
    """The column-0 `Gap-log:` lines' remainders, in body order."""
    return [line[len(DECL_PREFIX):].strip() for line in lines if line.startswith(DECL_PREFIX)]


def fail(message):
    print("GAP_LOG_FAIL: " + message)
    return 1


def failure_forms():
    return (
        "Move the entry to ## 已修 in this PR and declare 'Gap-log: <text from the entry>', or "
        "say why the citation is unrelated with 'Gap-log: none: <reason>' (at least %d characters)"
        % WAIVER_MIN_CHARS
    )


def bare_none_failure(linked):
    if linked:
        entry, path = linked[0]
        return (
            "the PR touches a path an ## Open gap-log entry cites, but 'Gap-log: none' has no "
            "reason: the entry %r cites %s. %s" % (entry, path, failure_forms())
        )
    return (
        "the body has a bare 'Gap-log: none' with no reason; a waiver needs "
        "'Gap-log: none: <reason>' with at least %d characters" % WAIVER_MIN_CHARS
    )


def uncovered_failure(uncovered):
    listed = "; ".join("%s (cites %s)" % (entry, path) for entry, path in uncovered)
    return (
        "the PR touches paths these ## Open gap-log entries cite and neither closes nor waives "
        "them: %s. %s" % (listed, failure_forms())
    )


def main(argv):
    if len(argv) != 4:
        sys.stderr.write(
            "usage: gap_log_check.py <worktree> <body-file> <changed-files-file>\n"
        )
        return 2
    worktree, body_path, changed_path = argv[1], argv[2], argv[3]

    source = os.path.join(worktree, GAP_LOG)
    if not os.path.exists(source):
        print("GAP_LOG_NA: no %s in the worktree" % GAP_LOG)
        return 0
    try:
        lines = read_text(source).splitlines()
    except OSError as exc:
        return fail("cannot read %s: %s" % (GAP_LOG, exc))
    try:
        open_entries, fixed_entries = sections(lines)
    except ValueError as exc:
        return fail("%s cannot be parsed: %s" % (GAP_LOG, exc))

    try:
        changed = {
            normalise(p) for p in read_text(changed_path).splitlines() if p.strip()
        }
    except OSError as exc:
        return fail("cannot read the changed-files list: %s" % exc)

    linked = []
    for entry in open_entries:
        hits = [path for path in cited_paths(entry) if path in changed]
        if hits:
            linked.append((entry, hits[0]))

    # A diff that touches no cited path is not applicable, and neither is a gap-log edit that
    # declares nothing: an entry added under `## Open` (the dogfood pass) is not a fix PR. The
    # body is still read first: a declaration of an entry this diff does not cite (a moved entry
    # whose gap-log file was left out of the diff) must fail, not turn into NA.
    applicable = bool(linked) or GAP_LOG in changed
    try:
        body_lines = read_text(body_path).splitlines()
    except OSError as exc:
        if applicable:
            return fail("cannot read the PR body: %s" % exc)
        print("GAP_LOG_NA: no ## Open entry cites a path this PR changes")
        return 0
    declared = declarations(body_lines)
    if not applicable and not declared:
        print("GAP_LOG_NA: no ## Open entry cites a path this PR changes")
        return 0

    waiver = None
    texts = []
    for text in declared:
        lowered = text.lower()
        if lowered == "none" or lowered.startswith("none:"):
            reason = text[len("none"):]
            reason = reason[1:].strip() if reason.startswith(":") else ""
            if len(reason) >= WAIVER_MIN_CHARS:
                waiver = reason
                continue
            if lowered == "none":
                return fail(bare_none_failure(linked))
            return fail(
                "a waiver needs a reason: 'Gap-log: none: <reason>' with at least %d "
                "characters, got %d" % (WAIVER_MIN_CHARS, len(reason))
            )
        if not text:
            return fail(
                "a bare 'Gap-log:' line declares nothing; paste the entry's own text or "
                "'Gap-log: none: <reason>'"
            )
        if len(text) < DECL_MIN_CHARS:
            return fail(
                "a 'Gap-log:' declaration needs at least %d characters of the entry's own "
                "text, got %d" % (DECL_MIN_CHARS, len(text))
            )
        texts.append(text)

    if waiver is not None:
        print("GAP_LOG_WAIVED: " + waiver)
        return 0
    if not texts:
        if linked:
            return fail(uncovered_failure(linked))
        print("GAP_LOG_NA: no ## Open entry cites a path this PR changes")
        return 0

    for text in texts:
        matches = [("open", e) for e in open_entries if text in e]
        matches += [("fixed", e) for e in fixed_entries if text in e]
        if not matches:
            return fail(
                "'Gap-log: %s' names no entry in %s under ## Open or ## 已修; paste the "
                "entry's own text" % (text, GAP_LOG)
            )
        if len(matches) > 1:
            return fail(
                "'Gap-log: %s' names %d gap-log entries; use a longer, unique string"
                % (text, len(matches))
            )
        section, entry = matches[0]
        if section == "open":
            return fail(
                "the declared entry is still under ## Open: %s — move the entry to ## 已修 "
                "in this PR (the declaration text must then be in ## 已修 and in no ## Open "
                "line)" % entry
            )
        if GAP_LOG not in changed:
            return fail(
                "'Gap-log: %s' declares an entry, but %s is not among this PR's changed "
                "files: move the entry to ## 已修 in this PR (the move must be in this PR)"
                % (text, GAP_LOG)
            )

    uncovered = [
        (entry, path)
        for entry, path in linked
        if not any(text in entry for text in texts)
    ]
    if uncovered:
        return fail(uncovered_failure(uncovered))

    print("GAP_LOG_OK: every cited ## Open entry is closed in this PR")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
