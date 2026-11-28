#!/usr/bin/env python3
"""The one rule for which open PRs the RSI loop selects (R-ceo-pr-filter).

  from pr_select import is_candidate

Both readers used to carry their own copy of the filter: the merge dispatcher's row builder
(merge.sh) and the open-PR backpressure counter (common.sh). Both skipped every head starting
with `rsi/ceo-`, so a legitimate PR from a CEO-named head (#392, `rsi/ceo-ok-marker`) was never
verified, reviewed or merged while other PRs were; it sat open with zero cycles.log entries and
had to be re-opened from another head. `rsi/ceo-*` is not a namespace reserved for control: only
CONTROL_BRANCH — the loop's own working branch, auto-synced to origin/main, never a deliverable —
must stay out.

The DREAM job's date-stamped consolidation branches (`rsi/dream-2026-11-20`,
`rsi/dream-20261121`) used to be excluded too, because DREAM merged them itself under the
docs-only gate. That merge was the one delivery the merge lane never saw, so it never reached
merged.log (DREAM's #847). DREAM no longer merges its own PR: the merge lane is the one path that
records a delivery, so its date branch is a candidate like every other rsi/* head. The
`rsi/dream-*` prefix was never a safe exclusion anyway — it swallowed #535
(`rsi/dream-phone-line`, a real slice about the DREAM report's phone line): green CI, MERGEABLE,
zero cycles.log entries, invisible to the merge lane until a person renamed its head.

A candidate starts with `rsi/`, is not the control branch, is not a draft, and carries none of
the CEO-hold labels. The dispatcher deliberately applies the label rule one step later, in
ceo_hold_skip(), so an owner approval marker can release a labelled hold (see
test-merge-ceo-ok.sh); it calls is_candidate() with no labels for the same head rule.
"""

CONTROL_BRANCH = "rsi/ceo-loop"
HOLD_LABELS = frozenset({"hold", "needs-ceo"})


def label_names(labels):
    """gh returns `[{"name": ...}]`; the counter and the row filter both accept plain strings."""
    names = set()
    for label in labels or ():
        name = label.get("name") if isinstance(label, dict) else label
        if name:
            names.add(name)
    return names


def is_candidate(head, is_draft, labels=()):
    if not isinstance(head, str) or not head.startswith("rsi/"):
        return False
    if head == CONTROL_BRANCH:
        return False
    if is_draft:
        return False
    return not (label_names(labels) & HOLD_LABELS)
