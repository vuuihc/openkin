#!/usr/bin/env python3
"""Name every open rsi/* PR the merge dispatcher fetched but did not select (R-unseen-pr).

The dispatcher selects rows with one predicate and prints only about that set, so a wrong
predicate does not skip one PR: the tick says "no open rsi PRs", which is false, and nothing
names the stranded PR (#392 rsi/ceo-ok-marker, #535 rsi/dream-phone-line — both green and
unselected for 2.5 hours until a person renamed a head).

This tool re-derives the selection with a deliberately COARSER rule than pr_select.is_candidate().
It must NOT import the selector: if both rules were the same function, a wrong selector would make
the difference empty and the check tautological. An open PR is reported when the head starts with
`rsi/`, it is not a draft, it carries neither the `hold` nor the `needs-ceo` label, it is not the
control branch `rsi/ceo-loop`, and its number is absent from the dispatcher's `--rows`. The
DREAM job's date-stamped consolidation branch is not special any more: DREAM no longer merges its
own PR, the merge lane does and records the delivery, so a skipped `rsi/dream-<date>` is exactly
the stranded PR this alarm exists for.

Fail closed, never block: unreadable JSON, an empty list, a missing/unreadable --state directory
or any unexpected item shape exits 0 with no output and no write. A tick is never stopped and a PR
is never invented.
"""

import argparse
import json
import os
import sys
import time

CONTROL_BRANCH = "rsi/ceo-loop"
HOLD_LABELS = frozenset({"hold", "needs-ceo"})

RULE = (
    "Report an open PR the dispatcher did not select: rsi/* head, not a draft,\n"
    "no hold/needs-ceo label, not rsi/ceo-loop, and number absent from --rows."
)

# The script lives in rsi/runtime; its state lives in rsi/state. Derive it from __file__, never
# from the process working directory (the dispatcher may run from anywhere).
DEFAULT_STATE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state"
)


def _label_names(labels):
    """gh returns [{"name": ...}]; plain strings are accepted too. None = unexpected shape."""
    names = set()
    for label in labels:
        if isinstance(label, dict):
            name = label.get("name")
        elif isinstance(label, str):
            name = label
        else:
            return None
        if not isinstance(name, str):
            return None
        names.add(name)
    return names


def _parse_items(text):
    """Return [(number, head, is_draft, label_names)] or None when the input is not usable."""
    try:
        items = json.loads(text)
    except Exception:
        return None
    if not isinstance(items, list) or not items:
        return None
    parsed = []
    for item in items:
        if not isinstance(item, dict):
            return None
        number = item.get("number")
        head = item.get("headRefName")
        draft = item.get("isDraft")
        # A missing field is an unexpected shape, not an empty label set.
        labels = item.get("labels") if "labels" in item else None
        # bool is an int subclass; a bool number is an unexpected shape, not a PR.
        if isinstance(number, bool) or not isinstance(number, int):
            return None
        if not isinstance(head, str) or not head:
            return None
        if not isinstance(draft, bool):
            return None
        if not isinstance(labels, list):
            return None
        names = _label_names(labels)
        if names is None:
            return None
        parsed.append((number, head, draft, names))
    return parsed


def _selected_numbers(rows):
    """The first TSV field of every non-empty dispatcher row, as integers."""
    numbers = set()
    for line in (rows or "").splitlines():
        field = line.split("\t", 1)[0].strip()
        if field.isdigit():
            numbers.add(int(field))
    return numbers


def _coarse(number, head, draft, labels, selected):
    """The independent, deliberately coarse rule. Keep it in step with RULE, not with pr_select."""
    if not head.startswith("rsi/"):
        return False
    if head == CONTROL_BRANCH:
        return False
    if draft:
        return False
    if labels & HOLD_LABELS:
        return False
    return number not in selected


def _log_new(merge_dir, number, head):
    """Append once per newly seen (number, head); the marker remembers the head already logged."""
    marker = os.path.join(merge_dir, "unseen-pr.%d" % number)
    try:
        with open(marker, encoding="utf-8") as handle:
            already = handle.read().strip()
    except Exception:
        already = None
    if already == head:
        return
    with open(os.path.join(merge_dir, "unseen-pr.log"), "a", encoding="utf-8") as handle:
        handle.write(
            "%s unseen-pr #%d %s\n"
            % (time.strftime("%Y-%m-%d %H:%M:%S"), number, head)
        )
    with open(marker, "w", encoding="utf-8") as handle:
        handle.write(head + "\n")


def main(argv):
    parser = argparse.ArgumentParser(description=RULE)
    parser.add_argument("--rows", default="", help="the dispatcher's TSV rows (may be empty)")
    parser.add_argument("--state", default=DEFAULT_STATE, help="the RSI state directory")
    args = parser.parse_args(argv)

    try:
        text = sys.stdin.read()
    except Exception:
        return 0
    items = _parse_items(text)
    if items is None:
        return 0
    state = args.state
    if not os.path.isdir(state) or not os.access(state, os.R_OK | os.X_OK):
        return 0

    selected = _selected_numbers(args.rows)
    seen = set()
    reported = []
    for number, head, draft, labels in sorted(items, key=lambda item: (item[0], item[1])):
        if not _coarse(number, head, draft, labels, selected):
            continue
        if (number, head) in seen:
            continue
        seen.add((number, head))
        reported.append((number, head))
    if not reported:
        return 0

    merge_dir = os.path.join(state, "merge")
    try:
        os.makedirs(merge_dir, exist_ok=True)
    except Exception:
        merge_dir = None

    for number, head in reported:
        # The console is the live fact: print on every run, even when the log already has it.
        print("unseen-pr #%d %s" % (number, head))
        if merge_dir:
            try:
                _log_new(merge_dir, number, head)
            except Exception:
                pass  # the log is durable, best-effort; never fail the tick over it
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception:
        # Fail closed: an unexpected crash must not stop the dispatcher or invent a PR.
        sys.exit(0)
